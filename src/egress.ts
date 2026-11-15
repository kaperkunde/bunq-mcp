import { Agent, request as httpsRequest } from "node:https"

/**
 * The only place this service opens a connection. It dials one host: bunq's
 * production API, or its sandbox when BUNQ_ENVIRONMENT=sandbox. The host is
 * fixed when the transport is made and is never taken from a request, a
 * response or an argument: a request names a path only. Redirects are not
 * followed (node:https does not), no proxy is consulted (the agent is this
 * module's own), and an answer stops at MAX_RESPONSE_BYTES.
 *
 * ESLint keeps node:https, node:net, node:tls and fetch out of every other
 * module, and test/egress.test.ts checks the same on the sources.
 */

export const BUNQ_HOSTS = {
  production: "api.bunq.com",
  sandbox: "public-api.sandbox.bunq.com",
} as const

export type Environment = keyof typeof BUNQ_HOSTS

export type OutgoingRequest = {
  method: string
  /** The path and query, starting with /v1/. Never a URL. */
  path: string
  headers: Record<string, string>
  body?: string
}

export type IncomingResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type Transport = (request: OutgoingRequest) => Promise<IncomingResponse>

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 30_000

/** A path this transport sends: /v1/, then URL-safe characters only. */
const SAFE_PATH = /^\/v1\/[A-Za-z0-9\-_.~/]*(?:\?[A-Za-z0-9\-_.~=&]*)?$/

export class EgressError extends Error {
  override name = "EgressError"
}

/** Whether a path may be sent: no scheme, no host, no `..`, no `//`. */
export function safePath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes("//") && !path.includes("..")
}

/**
 * The headers sent: a request with a body says its length in bytes, so it
 * goes out in one piece (never chunked) exactly as it was signed.
 */
export function wireHeaders(outgoing: OutgoingRequest): Record<string, string> {
  if (outgoing.body === undefined) return outgoing.headers
  return {
    ...outgoing.headers,
    "Content-Length": String(Buffer.byteLength(outgoing.body, "utf8")),
  }
}

/** The transport to bunq's API for one environment. */
export function httpsTransport(environment: Environment): Transport {
  const host = BUNQ_HOSTS[environment]
  if (!host) throw new EgressError(`Unknown bunq environment: ${environment}`)
  // Our own agent: no global agent another module could have changed, and
  // node:https never reads HTTP(S)_PROXY.
  // Certificates are checked against the system's roots, said outright so
  // no default or environment variable can turn it off.
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 4,
    rejectUnauthorized: true,
  })

  return (outgoing) =>
    new Promise<IncomingResponse>((resolve, reject) => {
      if (!safePath(outgoing.path)) {
        reject(
          new EgressError("Refused a request path that is not bunq's API."),
        )
        return
      }
      const req = httpsRequest(
        {
          host,
          servername: host,
          port: 443,
          method: outgoing.method,
          path: outgoing.path,
          headers: wireHeaders(outgoing),
          agent,
          rejectUnauthorized: true,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new EgressError("bunq's answer was too large."))
              return
            }
            chunks.push(chunk)
          })
          res.on("end", () => {
            const headers: Record<string, string> = {}
            for (const [name, value] of Object.entries(res.headers)) {
              if (typeof value === "string") headers[name] = value
              else if (Array.isArray(value)) headers[name] = value.join(", ")
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          })
          res.on("error", reject)
        },
      )
      req.on("timeout", () =>
        req.destroy(new EgressError("bunq did not answer in time.")),
      )
      req.on("error", reject)
      // One write with its length: a signed body goes out exactly as
      // signed, never chunked.
      req.end(outgoing.body)
    })
}
