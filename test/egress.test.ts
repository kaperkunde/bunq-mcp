import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  BUNQ_HOSTS,
  EgressError,
  httpsTransport,
  safePath,
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

  it("dials only from src/egress.ts", () => {
    const dialing =
      /from "(?:node:)?(?:https|net|tls|http2|dgram|child_process)"|from "undici"|(?<![.\w])fetch\(|\bWebSocket\b|\bnew XMLHttpRequest\b/
    const offenders = sources()
      .filter(({ file }) => file !== "egress.ts")
      .filter(({ text }) => dialing.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
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
})
