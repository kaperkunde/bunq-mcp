import { timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { Readable } from "node:stream"

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server"

import type { Config } from "./config.ts"
import type { Logger } from "./log.ts"
import { registerTools, type ToolDeps } from "./tools.ts"

/**
 * The MCP side: one HTTP server inside the container (PCP publishes its
 * port on the SSH server's 127.0.0.1 and reaches it through the SSH
 * connection).
 *
 * - `GET /health` answers `{"status":"ok"}` and nothing about the account.
 * - The MCP path (`/mcp`) serves MCP over Streamable HTTP, stateless: a
 *   fresh MCP server per request, nothing kept between them. With
 *   MCP_AUTH_TOKEN set, a request without `Authorization: Bearer <token>`
 *   is refused. Host and Origin must be loopback or in MCP_ALLOWED_HOSTS
 *   (DNS rebinding).
 * - Everything else, `/` included, is 404 with no body worth reading.
 *
 * Requests are not logged: no address, no body, no header.
 */

export const SERVER_NAME = "bunq-mcp"
export const SERVER_VERSION = "0.1.0"
const MAX_BODY_BYTES = 1024 * 1024

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** Whether a Host (or an Origin's host) value is one this server answers. */
export function hostAllowed(
  value: string | undefined,
  allowed: string[],
): boolean {
  if (!value) return false
  const host = value.toLowerCase()
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0]!
  if (LOOPBACK.has(name)) return true
  return allowed.some(
    (entry) => entry === "*" || entry === host || entry === `${name}:*`,
  )
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false
  const given = Buffer.from(header.slice("Bearer ".length).trim(), "utf8")
  const expected = Buffer.from(token, "utf8")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(text)
}

function toWebRequest(req: IncomingMessage, host: string): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value)
    else if (Array.isArray(value))
      for (const v of value) headers.append(name, v)
  }
  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit)
}

async function sendWebResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  )
  res.on("close", () => body.destroy())
  body.pipe(res)
}

export function createMcpHttpServer(
  config: Pick<Config, "path" | "authToken" | "allowedHosts">,
  deps: ToolDeps,
  logger: Logger,
): Server {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      })
      registerTools(server, deps)
      return server
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: () => logger.warn("mcp_request_error"),
    },
  )

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder")
    if (url.pathname === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        plain(res, 405, "Method not allowed")
        return
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (url.pathname !== config.path) {
      plain(res, 404, "Not found")
      return
    }
    const host = req.headers.host
    if (!hostAllowed(host, config.allowedHosts)) {
      plain(res, 403, "Host not allowed")
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost: string | undefined
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = undefined
      }
      if (!hostAllowed(originHost, config.allowedHosts)) {
        plain(res, 403, "Origin not allowed")
        return
      }
    }
    if (
      config.authToken &&
      !bearerMatches(req.headers.authorization, config.authToken)
    ) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Bearer realm="bunq-mcp"',
      })
      res.end("Unauthorized")
      return
    }
    handler
      .fetch(toWebRequest(req, host!))
      .then((response) => sendWebResponse(res, response))
      .catch(() => {
        logger.error("mcp_handler_failed")
        if (!res.headersSent) plain(res, 500, "Internal error")
        else res.destroy()
      })
  })
}
