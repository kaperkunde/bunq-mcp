import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  BUNQ_HOSTS,
  EgressError,
  httpsTransport,
  safePath,
  wireHeaders,
} from "../src/egress.ts"

const SRC = join(import.meta.dirname, "..", "src")

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }))
}

describe("egress", () => {
  it("knows two hosts, bunq's API and its sandbox, and nothing else", () => {
    expect(BUNQ_HOSTS).toEqual({
      production: "api.bunq.com",
      sandbox: "public-api.sandbox.bunq.com",
    })
  })

  // A code convention checked here and by ESLint, not a sandbox: it keeps
  // the ways a module could reach the network out of every file but one.
  const NETWORK =
    "(?:node:)?(?:https?|http2|net|tls|dns|dgram|child_process|worker_threads|cluster|inspector)|undici"
  const dialing = [
    new RegExp(`from "(?:${NETWORK})"`),
    new RegExp(`import\\(\\s*["'\`](?:${NETWORK})["'\`]`),
    /import\(\s*[^"'`\s]/, // a computed dynamic import
    /\brequire\s*\(/,
    /\bcreateRequire\b/,
    /(?<![.\w])fetch\s*\(/,
    /\b(?:globalThis|global|self)\s*(?:\.\s*fetch\b|\[)/,
    /\bWebSocket\b|\bEventSource\b|\bXMLHttpRequest\b/,
    /process\s*\.\s*(?:binding|dlopen)\b/,
  ]

  it("dials only from src/egress.ts", () => {
    const offenders = sources()
      .filter(({ file }) => file !== "egress.ts")
      // http.ts imports node:http to listen; the next test pins that down.
      .map(({ file, text }) => ({
        file,
        text: file === "http.ts" ? text.replace('from "node:http"', "") : text,
      }))
      .filter(({ text }) => dialing.some((pattern) => pattern.test(text)))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it.each([
    'import { lookup } from "node:dns"',
    'import { Worker } from "node:worker_threads"',
    'import { connect } from "node:http2"',
    'const https = await import("node:https")',
    "const m = await import(name)",
    'const { createRequire } = await import("module")',
    "const r = createRequire(import.meta.url)",
    'await globalThis.fetch("https://example.org")',
    'await globalThis["fetch"]("https://example.org")',
    'await fetch("https://example.org")',
    'const tls = require("node:tls")',
  ])("would catch %s", (line) => {
    expect(dialing.some((pattern) => pattern.test(line))).toBe(true)
  })

  it("leaves the server's own calls alone", () => {
    expect(
      dialing.some((pattern) => pattern.test("handler.fetch(request)")),
    ).toBe(false)
  })

  it("serves HTTP only from src/http.ts, and makes no HTTP request there", () => {
    const users = sources()
      .filter(({ text }) => /from "(?:node:)?http"/.test(text))
      .map(({ file }) => file)
    expect(users).toEqual(["http.ts"])
    const http = readFileSync(join(SRC, "http.ts"), "utf8")
    expect(http).not.toMatch(/\b(?:request|get)\s*\(/)
    expect(http).toMatch(/import \{\s*createServer,/)
  })

  it("names its host only in BUNQ_HOSTS", () => {
    const hostLike = /["'`][a-z0-9.-]+\.(?:com|net|org|io|nl|dev)\b/i
    const offenders = sources()
      .filter(({ file }) => file !== "egress.ts")
      .filter(({ text }) => hostLike.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it.each([
    "https://evil.example/v1/user",
    "//evil.example/v1/user",
    "/v2/user",
    "/v1/user/../../x",
    "/v1//user",
    "/v1/user@evil.example",
    "/v1/user#x",
    "/v1/user\r\nHost: evil.example",
  ])("refuses the path %j before it dials", async (path) => {
    expect(safePath(path)).toBe(false)
    const send = httpsTransport("production")
    await expect(
      send({ method: "GET", path, headers: {} }),
    ).rejects.toBeInstanceOf(EgressError)
  })

  it("takes the paths the client sends", () => {
    expect(
      safePath(
        "/v1/user/4242/monetary-account/11/payment?count=200&older_id=12",
      ),
    ).toBe(true)
    expect(safePath("/v1/session-server")).toBe(true)
  })

  it("sends a body with its length, never chunked", () => {
    const body = JSON.stringify({ description: "Factuur – €12" })
    const headers = wireHeaders({
      method: "POST",
      path: "/v1/session-server",
      headers: { A: "1" },
      body,
    })
    expect(headers["Content-Length"]).toBe(
      String(Buffer.byteLength(body, "utf8")),
    )
    expect(Number(headers["Content-Length"])).toBeGreaterThan(body.length)
    expect(
      wireHeaders({ method: "GET", path: "/v1/user", headers: { A: "1" } }),
    ).toEqual({ A: "1" })
  })

  it("checks bunq's certificate, said outright", () => {
    const egress = readFileSync(join(SRC, "egress.ts"), "utf8")
    expect(egress.match(/rejectUnauthorized: true/g)).toHaveLength(2)
    expect(egress).not.toMatch(
      /rejectUnauthorized: false|NODE_TLS_REJECT_UNAUTHORIZED/,
    )
  })
})
