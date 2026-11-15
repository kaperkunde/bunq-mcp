import { randomUUID, sign } from "node:crypto"

import type { Config } from "./config.ts"
import type { IncomingResponse, Transport } from "./egress.ts"
import type { Logger } from "./log.ts"
import { BOOTSTRAP_PATHS, guard } from "./policy.ts"
import {
  sha256,
  type ClientKeys,
  type ContextState,
  type SessionState,
  type Store,
} from "./store.ts"

/**
 * The bunq context for one API key: installation, device and session, kept
 * in the data folder, and every request after them.
 *
 * - First start: POST /installation with the client public key, POST
 *   /device-server with the API key, POST /session-server (signed) for a
 *   session token and the user's id. Each result is saved before the next
 *   step, so a restart picks up where it stopped.
 * - Later starts reuse the installation and device. A new API key or new
 *   permitted addresses (their hash differs from the one saved) register a
 *   new device.
 * - The session is made again before it runs out (its creation time plus
 *   the user's session_timeout), and at once when bunq answers 401 to a
 *   request that carried it; the request is then sent once more. Concurrent
 *   calls share one renewal.
 * - When bunq refuses a new session on a context from an earlier start (a
 *   device removed in the app, or an API key bound to an address the
 *   machine no longer has), the context is made again from the
 *   installation on, once per process.
 * - A failed bootstrap is not retried at once: the next attempt waits a
 *   minute, then longer each time, up to an hour (bunq allows as few as
 *   ten installations a day).
 * - At most three reads and five writes go out in any three seconds, and a
 *   429 is retried twice after a pause.
 *
 * Every request passes the policy (policy.ts) on its way to the transport.
 * Nothing here logs a body, a token or the key.
 */

export const USER_AGENT = "bunq-mcp/0.1 (PCP service)"
const DEFAULT_SESSION_TIMEOUT_S = 7 * 24 * 60 * 60
/** Renew this long before bunq would end the session. */
const RENEW_MARGIN_MS = 5 * 60 * 1000
const BOOTSTRAP_BACKOFF_MS = 60 * 1000
const BOOTSTRAP_BACKOFF_MAX_MS = 60 * 60 * 1000
const RATE_WINDOW_MS = 3000
const RATE_LIMITS = { GET: 3, POST: 5 } as const
const RETRIES_AFTER_429 = 2

export class BunqError extends Error {
  override name = "BunqError"
  readonly status: number
  readonly description?: string

  constructor(status: number, description?: string, message?: string) {
    super(
      message ??
        `bunq answered ${status}${description ? `: ${description}` : ""}`,
    )
    this.status = status
    this.description = description
  }
}

export type BunqItem = Record<string, unknown>

/** A listing's items, each unwrapped from its type name, and its paging. */
export type BunqListing = {
  items: { type: string; value: BunqItem }[]
  olderId?: number
}

type ClientOptions = {
  config: Pick<
    Config,
    "apiKey" | "environment" | "draftMaxCents" | "permittedIps"
  >
  store: Store
  transport: Transport
  logger: Logger
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** bunq's `{"Error": [{"error_description": …}]}`, shortened. */
function errorDescription(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && Array.isArray(parsed.Error)) {
      const first: unknown = parsed.Error[0]
      if (isRecord(first) && typeof first.error_description === "string") {
        return first.error_description.slice(0, 300)
      }
    }
  } catch {
    // Not JSON: no description.
  }
  return undefined
}

/** The `Response` array of a bunq answer. */
function responseItems(body: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new BunqError(0, undefined, "bunq's answer was not JSON.")
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.Response)) {
    throw new BunqError(0, undefined, "bunq's answer had no Response.")
  }
  return parsed.Response
}

/** The first item of `items` that has `key`, as an object. */
function find(items: unknown[], key: string): BunqItem | undefined {
  for (const item of items) {
    if (isRecord(item) && isRecord(item[key])) return item[key] as BunqItem
  }
  return undefined
}

/** `{"Payment": {...}}` → { type: "Payment", value: {...} }. */
function unwrap(item: unknown): { type: string; value: BunqItem } | undefined {
  if (!isRecord(item)) return undefined
  const [type] = Object.keys(item)
  if (type === undefined) return undefined
  const value = item[type]
  return isRecord(value) ? { type, value } : undefined
}

/** The older_id out of a Pagination.older_url, when there is one. */
function olderId(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed) || !isRecord(parsed.Pagination)) return undefined
    const url = parsed.Pagination.older_url
    if (typeof url !== "string") return undefined
    const match = /[?&]older_id=([0-9]{1,19})(?:&|$)/.exec(url)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * The user a session belongs to, and how long bunq keeps its sessions. For
 * a person's or a company's key that is the UserPerson or UserCompany. For
 * a UserApiKey session (an OAuth grant, or a key another user made for
 * you) the id paths take is the UserApiKey's own id, as bunq's API and its
 * SDKs use it; the user who granted it only gives the session timeout.
 */
function sessionUser(items: unknown[]): { id: number; timeout: number } {
  let id: unknown
  let timeoutOf: BunqItem | undefined
  const person = find(items, "UserPerson") ?? find(items, "UserCompany")
  if (person) {
    id = person.id
    timeoutOf = person
  } else {
    const apiKey = find(items, "UserApiKey")
    id = apiKey?.id
    const granted =
      apiKey && isRecord(apiKey.granted_by_user)
        ? apiKey.granted_by_user
        : undefined
    timeoutOf = granted ? unwrap(granted)?.value : undefined
  }
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new BunqError(0, undefined, "bunq's session named no user.")
  }
  const sessionTimeout = timeoutOf?.session_timeout
  const timeout =
    typeof sessionTimeout === "number" && sessionTimeout > 0
      ? sessionTimeout
      : DEFAULT_SESSION_TIMEOUT_S
  return { id, timeout }
}

export class BunqClient {
  readonly #config: ClientOptions["config"]
  readonly #store: Store
  readonly #send: Transport
  readonly #log: Logger
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>

  #state: ContextState | undefined
  #keys: ClientKeys | undefined
  #renewing: Promise<SessionState> | undefined
  #resetUsed = false
  #blockedUntil = 0
  #blockedError: Error | undefined
  #backoffMs = BOOTSTRAP_BACKOFF_MS
  readonly #sent: Record<"GET" | "POST", number[]> = { GET: [], POST: [] }

  constructor(options: ClientOptions) {
    this.#config = options.config
    this.#store = options.store
    // The policy sits between this client and the network: every request,
    // bootstrap included, is checked before it is dialled.
    this.#send = guard(options.transport, options.config.draftMaxCents)
    this.#log = options.logger
    this.#now = options.now ?? Date.now
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** The client key pair, read (or made) once. */
  #clientKeys(): ClientKeys {
    this.#keys ??= this.#store.keys()
    return this.#keys
  }

  // ---- Sending -------------------------------------------------------------

  /** Waits until another request of this method fits the rate window. */
  async #pace(method: "GET" | "POST") {
    const sent = this.#sent[method]
    for (;;) {
      const now = this.#now()
      while (sent.length > 0 && sent[0]! <= now - RATE_WINDOW_MS) sent.shift()
      if (sent.length < RATE_LIMITS[method]) {
        sent.push(now)
        return
      }
      await this.#sleep(sent[0]! + RATE_WINDOW_MS - now)
    }
  }

  async #raw(
    method: "GET" | "POST",
    path: string,
    options: {
      token?: string
      body?: string
      signed?: boolean
      idempotencyKey?: string
    } = {},
  ): Promise<IncomingResponse> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Cache-Control": "no-cache",
      "X-Bunq-Language": "en_US",
      "X-Bunq-Region": "nl_NL",
      "X-Bunq-Geolocation": "0 0 0 0 000",
      "X-Bunq-Client-Request-Id": randomUUID(),
    }
    if (options.token) headers["X-Bunq-Client-Authentication"] = options.token
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
      if (options.signed) {
        headers["X-Bunq-Client-Signature"] = sign(
          "sha256",
          Buffer.from(options.body, "utf8"),
          this.#clientKeys().privateKey,
        ).toString("base64")
      }
    }
    if (options.idempotencyKey) {
      headers["X-Bunq-Client-Idempotency-Key"] = options.idempotencyKey
    }

    for (let attempt = 0; ; attempt++) {
      await this.#pace(method)
      const started = this.#now()
      const response = await this.#send({
        method,
        path,
        headers,
        body: options.body,
      })
      this.#log.info("bunq_request", {
        method,
        path: path.replace(/\?.*$/, ""),
        status: response.status,
        ms: this.#now() - started,
      })
      if (response.status === 429 && attempt < RETRIES_AFTER_429) {
        await this.#sleep(RATE_WINDOW_MS * (attempt + 1))
        continue
      }
      return response
    }
  }

  #fail(response: IncomingResponse): never {
    throw new BunqError(response.status, errorDescription(response.body))
  }

  // ---- The context ---------------------------------------------------------

  /**
   * What the device was registered with, hashed: the API key and the
   * permitted addresses. A change to either registers a new device.
   */
  #registration(): string {
    return sha256(
      `${this.#config.apiKey}\n${this.#config.permittedIps.join(",")}`,
    )
  }

  #context(): ContextState {
    if (this.#state) return this.#state
    const { publicKeyPem } = this.#clientKeys()
    const saved = this.#store.readContext()
    const fingerprint = sha256(publicKeyPem)
    if (
      saved &&
      saved.environment === this.#config.environment &&
      saved.publicKeySha256 === fingerprint
    ) {
      this.#state = saved
    } else {
      this.#state = {
        version: 1,
        environment: this.#config.environment,
        publicKeySha256: fingerprint,
      }
    }
    return this.#state
  }

  #save(state: ContextState) {
    this.#state = state
    this.#store.writeContext(state)
  }

  async #install(state: ContextState): Promise<ContextState> {
    const { publicKeyPem } = this.#clientKeys()
    const response = await this.#raw("POST", BOOTSTRAP_PATHS[0], {
      body: JSON.stringify({ client_public_key: publicKeyPem }),
    })
    if (response.status !== 200) this.#fail(response)
    const items = responseItems(response.body)
    const token = find(items, "Token")?.token
    const serverPublicKey = find(items, "ServerPublicKey")?.server_public_key
    if (typeof token !== "string" || typeof serverPublicKey !== "string") {
      throw new BunqError(
        0,
        undefined,
        "bunq's installation answer had no token.",
      )
    }
    const next: ContextState = {
      version: 1,
      environment: state.environment,
      publicKeySha256: state.publicKeySha256,
      installation: { token, serverPublicKey },
    }
    this.#save(next)
    this.#log.info("bunq_installation_created")
    return next
  }

  async #registerDevice(state: ContextState): Promise<ContextState> {
    const installation = state.installation!
    const body: Record<string, unknown> = {
      description: "bunq-mcp (PCP service)",
      secret: this.#config.apiKey,
    }
    if (this.#config.permittedIps.length > 0) {
      body.permitted_ips = this.#config.permittedIps
    }
    const response = await this.#raw("POST", BOOTSTRAP_PATHS[1], {
      token: installation.token,
      body: JSON.stringify(body),
    })
    if (response.status !== 200) this.#fail(response)
    const id = find(responseItems(response.body), "Id")?.id
    if (typeof id !== "number") {
      throw new BunqError(0, undefined, "bunq's device answer had no id.")
    }
    const next: ContextState = {
      ...state,
      device: { id, registration: this.#registration() },
      session: undefined,
    }
    this.#save(next)
    this.#log.info("bunq_device_registered")
    return next
  }

  async #startSession(state: ContextState): Promise<SessionState> {
    const response = await this.#raw("POST", BOOTSTRAP_PATHS[2], {
      token: state.installation!.token,
      body: JSON.stringify({ secret: this.#config.apiKey }),
      signed: true,
    })
    if (response.status !== 200) this.#fail(response)
    const items = responseItems(response.body)
    const token = find(items, "Token")?.token
    if (typeof token !== "string") {
      throw new BunqError(0, undefined, "bunq's session answer had no token.")
    }
    const user = sessionUser(items)
    const session: SessionState = {
      token,
      userId: user.id,
      createdAt: new Date(this.#now()).toISOString(),
      timeoutSeconds: user.timeout,
    }
    this.#save({ ...state, session })
    this.#log.info("bunq_session_created", { timeout_s: user.timeout })
    return session
  }

  #fresh(session: SessionState | undefined): session is SessionState {
    if (!session) return false
    const expires =
      Date.parse(session.createdAt) + session.timeoutSeconds * 1000
    return this.#now() < expires - RENEW_MARGIN_MS
  }

  /** Installation, device and session, each made only when missing. */
  async #bootstrap(): Promise<SessionState> {
    let state = this.#context()
    const madeBefore = Boolean(state.installation && state.device)
    if (!state.installation) state = await this.#install(state)
    if (!state.device || state.device.registration !== this.#registration()) {
      state = await this.#registerDevice(state)
    }
    try {
      return await this.#startSession(state)
    } catch (error) {
      const refused =
        error instanceof BunqError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      if (!refused || !madeBefore || this.#resetUsed) throw error
      // A context from an earlier start that bunq no longer takes: make it
      // again, once per process.
      this.#resetUsed = true
      this.#log.warn("bunq_context_reset", { status: error.status })
      state = await this.#install(state)
      state = await this.#registerDevice(state)
      return await this.#startSession(state)
    }
  }

  /** A session that is good for now, made again when it is not. */
  async session(): Promise<SessionState> {
    const current = this.#context().session
    if (
      this.#fresh(current) &&
      this.#context().device?.registration === this.#registration()
    ) {
      return current
    }
    if (this.#renewing) return this.#renewing
    if (this.#now() < this.#blockedUntil && this.#blockedError) {
      throw this.#blockedError
    }
    this.#renewing = this.#bootstrap()
      .then((session) => {
        this.#backoffMs = BOOTSTRAP_BACKOFF_MS
        this.#blockedError = undefined
        return session
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error("bunq bootstrap failed")
        this.#blockedUntil = this.#now() + this.#backoffMs
        this.#blockedError = failure
        this.#backoffMs = Math.min(
          this.#backoffMs * 2,
          BOOTSTRAP_BACKOFF_MAX_MS,
        )
        this.#log.error("bunq_bootstrap_failed", {
          status: failure instanceof BunqError ? failure.status : undefined,
        })
        throw failure
      })
      .finally(() => {
        this.#renewing = undefined
      })
    return this.#renewing
  }

  /** Drops `token` as the session, unless another call already replaced it. */
  #expire(token: string) {
    const state = this.#context()
    if (state.session?.token === token) {
      this.#save({ ...state, session: undefined })
    }
  }

  /** The id of the user the API key belongs to. */
  async userId(): Promise<number> {
    return (await this.session()).userId
  }

  /** A request with the session token, made again once after a 401. */
  async #authed(
    method: "GET" | "POST",
    path: string,
    options: { body?: string; signed?: boolean; idempotencyKey?: string } = {},
  ): Promise<IncomingResponse> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.session()
      const response = await this.#raw(method, path, {
        ...options,
        token: session.token,
      })
      if (response.status === 401 && attempt === 0) {
        this.#log.warn("bunq_session_refused")
        this.#expire(session.token)
        continue
      }
      if (response.status !== 200) this.#fail(response)
      return response
    }
  }

  // ---- What the tools use --------------------------------------------------

  /** GET a listing under /v1, each item unwrapped from its type's name. */
  async list(path: string): Promise<BunqListing> {
    const response = await this.#authed("GET", `/v1${path}`)
    const items = responseItems(response.body)
      .map(unwrap)
      .filter(
        (item): item is { type: string; value: BunqItem } => item !== undefined,
      )
    return { items, olderId: olderId(response.body) }
  }

  /** GET one object under /v1. */
  async read(path: string): Promise<{ type: string; value: BunqItem }> {
    const { items } = await this.list(path)
    const first = items[0]
    if (!first) throw new BunqError(404, "Not found.")
    return first
  }

  /**
   * POST a draft payment. The body is checked again by the policy on its
   * way out; the idempotency key makes a resend after a 401 one draft.
   */
  async createDraftPayment(
    userId: number,
    accountId: number,
    body: Record<string, unknown>,
  ): Promise<number> {
    const response = await this.#authed(
      "POST",
      `/v1/user/${userId}/monetary-account/${accountId}/draft-payment`,
      {
        body: JSON.stringify(body),
        signed: true,
        idempotencyKey: randomUUID(),
      },
    )
    const id = find(responseItems(response.body), "Id")?.id
    if (typeof id !== "number") {
      throw new BunqError(0, undefined, "bunq's draft answer had no id.")
    }
    return id
  }
}
