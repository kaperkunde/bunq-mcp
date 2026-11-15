import { checkIban } from "./iban.ts"
import { AMOUNT, toCents } from "./money.ts"
import { plainLine } from "./text.ts"
import type { OutgoingRequest, Transport } from "./egress.ts"

/**
 * What may be sent to bunq at all, checked on every request before it is
 * dialled, whoever builds it:
 *
 * - GET on the read paths the tools use, and nothing else.
 * - POST to /v1/installation, /v1/device-server and /v1/session-server
 *   (the session bootstrap), and POST to one account's draft-payment, with
 *   a body that is exactly one EUR payment to a valid IBAN, no schedule,
 *   one accept required.
 *
 * Everything else (PUT, DELETE, PATCH, a POST to /payment, a request
 * inquiry, a card, a setting, a schedule) is refused here, so no code path
 * in this service can move money or change the account.
 */

export class PolicyError extends Error {
  override name = "PolicyError"
}

const ID = "[1-9][0-9]{0,18}"
const QUERY =
  "(?:\\?(?:count=[0-9]{1,3}|older_id=[0-9]{1,19}|newer_id=[0-9]{1,19})(?:&(?:count=[0-9]{1,3}|older_id=[0-9]{1,19}|newer_id=[0-9]{1,19}))*)?"

const READS: readonly RegExp[] = [
  `/v1/user`,
  `/v1/user/${ID}/monetary-account`,
  `/v1/user/${ID}/monetary-account/${ID}/payment`,
  `/v1/user/${ID}/monetary-account/${ID}/payment/${ID}`,
  `/v1/user/${ID}/monetary-account/${ID}/request-inquiry`,
  `/v1/user/${ID}/monetary-account/${ID}/request-response`,
  `/v1/user/${ID}/monetary-account/${ID}/schedule-payment`,
  `/v1/user/${ID}/card`,
].map((path) => new RegExp(`^${path}${QUERY}$`))

/** The session bootstrap: installation, device, session. */
export const BOOTSTRAP_PATHS = [
  "/v1/installation",
  "/v1/device-server",
  "/v1/session-server",
] as const

export const DRAFT_PAYMENT = new RegExp(
  `^/v1/user/(${ID})/monetary-account/(${ID})/draft-payment$`,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}

/**
 * A draft-payment body this service may send: one entry, EUR, an IBAN that
 * checks out, a description of at most 140 characters, PENDING, one accept,
 * no schedule. `maxCents` is the owner's cap, when set.
 */
export function checkDraftBody(body: string | undefined, maxCents?: number) {
  let parsed: unknown
  try {
    parsed = JSON.parse(body ?? "")
  } catch {
    throw new PolicyError("A draft payment's body is not JSON.")
  }
  if (!isRecord(parsed)) throw new PolicyError("A draft payment is an object.")
  if (!onlyKeys(parsed, ["status", "entries", "number_of_required_accepts"])) {
    throw new PolicyError(
      "A draft payment carries no schedule or other fields.",
    )
  }
  if (parsed.status !== undefined && parsed.status !== "PENDING") {
    throw new PolicyError("A new draft payment is PENDING.")
  }
  if (parsed.number_of_required_accepts !== 1) {
    throw new PolicyError("A draft payment needs exactly one accept.")
  }
  const entries = parsed.entries
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new PolicyError("A draft payment holds exactly one payment.")
  }
  const entry: unknown = entries[0]
  if (
    !isRecord(entry) ||
    !onlyKeys(entry, ["amount", "counterparty_alias", "description"])
  ) {
    throw new PolicyError(
      "A draft payment's entry is an amount, an IBAN and a description.",
    )
  }
  const amount = entry.amount
  if (
    !isRecord(amount) ||
    !onlyKeys(amount, ["value", "currency"]) ||
    amount.currency !== "EUR" ||
    typeof amount.value !== "string" ||
    !AMOUNT.test(amount.value) ||
    toCents(amount.value) <= 0
  ) {
    throw new PolicyError("A draft payment is a positive amount in EUR.")
  }
  if (maxCents !== undefined && toCents(amount.value) > maxCents) {
    throw new PolicyError("A draft payment is above the owner's maximum.")
  }
  const alias = entry.counterparty_alias
  if (
    !isRecord(alias) ||
    !onlyKeys(alias, ["type", "value", "name"]) ||
    alias.type !== "IBAN" ||
    typeof alias.value !== "string" ||
    !checkIban(alias.value).ok
  ) {
    throw new PolicyError("A draft payment goes to a valid IBAN only.")
  }
  if (!plainLine(alias.name, 70)) {
    throw new PolicyError(
      "A draft payment's recipient name is one line of at most 70 visible characters.",
    )
  }
  if (!plainLine(entry.description, 140)) {
    throw new PolicyError(
      "A draft payment's description is one line of at most 140 visible characters.",
    )
  }
}

/** Throws a PolicyError unless the request is one this service may send. */
export function assertAllowed(request: OutgoingRequest, maxCents?: number) {
  const { method, path } = request
  if (method === "GET") {
    if (request.body !== undefined) throw new PolicyError("A read has no body.")
    if (READS.some((pattern) => pattern.test(path))) return
    throw new PolicyError(`Refused GET ${path}: not a path this service reads.`)
  }
  if (method === "POST") {
    if ((BOOTSTRAP_PATHS as readonly string[]).includes(path)) return
    if (DRAFT_PAYMENT.test(path)) {
      checkDraftBody(request.body, maxCents)
      return
    }
  }
  throw new PolicyError(
    `Refused ${method} ${path}: this service only reads and creates draft payments.`,
  )
}

/** The transport, behind the policy: nothing reaches `transport` unchecked. */
export function guard(transport: Transport, maxCents?: number): Transport {
  return async (request) => {
    assertAllowed(request, maxCents)
    return transport(request)
  }
}
