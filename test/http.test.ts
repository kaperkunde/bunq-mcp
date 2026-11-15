import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import { createMcpHttpServer, hostAllowed } from "../src/http.ts"
import { setup } from "./helpers.ts"

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function serve(authToken?: string) {
  const s = setup()
  const server = createMcpHttpServer(
    { path: "/mcp", authToken, allowedHosts: [] },
    { client: s.client, logger: s.logger },
    s.logger,
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  )
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, fake: s.fake, lines: s.lines }
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
})
const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
}

describe("the HTTP side", () => {
  it("answers 404 on / and on any other path, with nothing about the account", async () => {
    const { base, fake } = await serve()
    for (const path of [
      "/",
      "/info",
      "/mcp/extra",
      "/.well-known/oauth-authorization-server",
    ]) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(404)
      expect(await response.text()).toBe("Not found")
    }
    expect(fake.requests).toHaveLength(0)
  })

  it("answers the health check without touching bunq", async () => {
    const { base, fake } = await serve("a-long-enough-token-123")
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(fake.requests).toHaveLength(0)
  })

  it("refuses MCP without the bearer token, when one is set", async () => {
    const { base } = await serve("a-long-enough-token-123")
    const none = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: initialize,
    })
    expect(none.status).toBe(401)
    const wrong = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        Authorization: "Bearer a-long-enough-token-124",
      },
      body: initialize,
    })
    expect(wrong.status).toBe(401)
    const right = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        Authorization: "Bearer a-long-enough-token-123",
      },
      body: initialize,
    })
    expect(right.status).toBe(200)
  })

  it("refuses an Origin that is not loopback (DNS rebinding)", async () => {
    const { base } = await serve()
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, Origin: "http://evil.example" },
      body: initialize,
    })
    expect(response.status).toBe(403)
  })

  it("checks Host against loopback and MCP_ALLOWED_HOSTS", () => {
    expect(hostAllowed("127.0.0.1:8080", [])).toBe(true)
    expect(hostAllowed("localhost", [])).toBe(true)
    expect(hostAllowed("[::1]:9000", [])).toBe(true)
    expect(hostAllowed("evil.example", [])).toBe(false)
    expect(hostAllowed(undefined, [])).toBe(false)
    expect(hostAllowed("192.0.2.10:8080", ["192.0.2.10:8080"])).toBe(true)
    expect(hostAllowed("192.0.2.10:9999", ["192.0.2.10:8080"])).toBe(false)
    expect(hostAllowed("192.0.2.10:9999", ["192.0.2.10:*"])).toBe(true)
  })
})
