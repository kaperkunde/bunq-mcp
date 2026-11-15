import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { BunqError } from "../src/bunq.ts"
import { API_KEY, USER_ID } from "./fake-bunq.ts"
import { DAY_MS, setup } from "./helpers.ts"

const INSTALL = ["POST", "/v1/installation"] as const
const DEVICE = ["POST", "/v1/device-server"] as const
const SESSION = ["POST", "/v1/session-server"] as const

describe("bootstrap", () => {
  it("installs, registers the device and starts a session, in that order", async () => {
    const { client, fake } = setup()
    expect(await client.userId()).toBe(USER_ID)
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/installation",
      "POST /v1/device-server",
      "POST /v1/session-server",
    ])
    // The installation token authenticates device and session.
    const installToken =
      fake.requests[1]!.headers["X-Bunq-Client-Authentication"]
    expect(installToken).toBeTruthy()
    expect(fake.requests[2]!.headers["X-Bunq-Client-Authentication"]).toBe(
      installToken,
    )
    // The session start is signed (the fake checks the signature).
    expect(fake.requests[2]!.headers["X-Bunq-Client-Signature"]).toBeTruthy()
    expect(
      fake.requests[0]!.headers["X-Bunq-Client-Authentication"],
    ).toBeUndefined()
  })

  it("keeps the key and the context in the data folder, readable by its owner only", async () => {
    const { client, dir } = setup()
    await client.userId()
    for (const file of ["client-key.pem", "context.json"]) {
      expect(statSync(join(dir, file)).mode & 0o077).toBe(0)
    }
    const context = JSON.parse(readFileSync(join(dir, "context.json"), "utf8"))
    expect(context.installation.token).toMatch(/^[0-9a-f]{64}$/)
    expect(context.device.id).toBeGreaterThan(0)
    expect(context.session.userId).toBe(USER_ID)
    // The API key itself is never written down, only its hash.
    expect(readFileSync(join(dir, "context.json"), "utf8")).not.toContain(
      API_KEY,
    )
  })

  it("reuses installation, device and session after a restart", async () => {
    const s = setup()
    await s.client.userId()
    const before = s.fake.requests.length
    const restarted = s.restart()
    expect(await restarted.userId()).toBe(USER_ID)
    await restarted.list(`/user/${USER_ID}/monetary-account`)
    expect(s.fake.requests.slice(before).map((r) => r.method)).toEqual(["GET"])
  })

  it("registers a new device, on the same installation, for a new API key", async () => {
    const s = setup()
    await s.client.userId()
    const newKey = "sandbox_ffffffffffffffffffffffffffffffffffffffffffffffff"
    s.fake.apiKey = newKey
    await s.restart({ apiKey: newKey }).userId()
    expect(s.fake.count(...INSTALL)).toBe(1)
    expect(s.fake.count(...DEVICE)).toBe(2)
    expect(s.fake.count(...SESSION)).toBe(2)
  })

  it("registers a new device when the permitted addresses change", async () => {
    const s = setup()
    await s.client.userId()
    await s.restart({ permittedIps: ["192.0.2.1", "*"] }).userId()
    expect(s.fake.count(...INSTALL)).toBe(1)
    expect(s.fake.count(...DEVICE)).toBe(2)
    const device = s.fake.requests.filter((r) => r.path === "/v1/device-server")
    expect(JSON.parse(device[1]!.body!).permitted_ips).toEqual([
      "192.0.2.1",
      "*",
    ])
    expect(JSON.parse(device[0]!.body!)).not.toHaveProperty("permitted_ips")
  })

  it("installs again when the environment changes", async () => {
    const s = setup()
    await s.client.userId()
    await s.restart({ environment: "sandbox" }).userId()
    expect(s.fake.count(...INSTALL)).toBe(2)
  })

  it("makes the context again, once, when bunq no longer takes a saved one", async () => {
    const s = setup()
    await s.client.userId()
    s.fake.forgetInstallations()
    s.fake.expireSessions()
    const restarted = s.restart()
    // The saved session is refused (401), the saved installation too: one
    // reset, then it works.
    await restarted.list(`/user/${USER_ID}/monetary-account`)
    expect(s.fake.count(...INSTALL)).toBe(2)
    expect(s.fake.count(...DEVICE)).toBe(2)
  })

  it("does not hammer bunq when a session cannot be made", async () => {
    const s = setup()
    s.fake.apiKey = "sandbox_somebodyelseskeysomebodyelseskeysomebodyelse"
    await expect(s.client.userId()).rejects.toBeInstanceOf(BunqError)
    const sent = s.fake.requests.length
    // Within the backoff, the stored failure is answered without a request.
    await expect(s.client.userId()).rejects.toBeInstanceOf(BunqError)
    expect(s.fake.requests.length).toBe(sent)
    s.clock.advance(61_000)
    await expect(s.client.userId()).rejects.toBeInstanceOf(BunqError)
    expect(s.fake.requests.length).toBeGreaterThan(sent)
  })
})

describe("session renewal", () => {
  it("makes a new session when bunq answers 401, and sends the request again", async () => {
    const s = setup()
    await s.client.userId()
    s.fake.expireSessions()
    const listing = await s.client.list(`/user/${USER_ID}/monetary-account`)
    expect(listing.items.length).toBeGreaterThan(0)
    expect(s.fake.count(...SESSION)).toBe(2)
    expect(s.fake.count(...INSTALL)).toBe(1)
    expect(s.fake.count(...DEVICE)).toBe(1)
  })

  it("shares one renewal between calls made at the same time", async () => {
    const s = setup()
    await s.client.userId()
    s.fake.expireSessions()
    await Promise.all(
      Array.from({ length: 5 }, () =>
        s.client.list(`/user/${USER_ID}/monetary-account`),
      ),
    )
    expect(s.fake.count(...SESSION)).toBeLessThanOrEqual(3)
  })

  it("renews before the session timeout runs out, without waiting for a 401", async () => {
    const s = setup()
    s.fake.sessionTimeout = 3600
    await s.client.userId()
    s.clock.advance(3600 * 1000)
    const before = s.fake.requests.length
    await s.client.list(`/user/${USER_ID}/monetary-account`)
    const after = s.fake.requests
      .slice(before)
      .map((r) => `${r.method} ${r.path}`)
    expect(after[0]).toBe("POST /v1/session-server")
    expect(after.filter((line) => line.startsWith("GET"))).toHaveLength(1)
  })

  it("keeps working over more than a week of auto-logouts, unattended", async () => {
    const s = setup()
    // bunq's default auto-logout: a week. The fake also logs out every
    // session on day 3 (as a changed setting in the app would).
    for (let day = 0; day < 12; day++) {
      if (day === 3) s.fake.expireSessions()
      const listing = await s.client.list(`/user/${USER_ID}/monetary-account`)
      expect(listing.items.length).toBe(4)
      s.clock.advance(DAY_MS)
    }
    expect(s.fake.count(...INSTALL)).toBe(1)
    expect(s.fake.count(...DEVICE)).toBe(1)
    // The first, the one after day 3's logout, and the one made on day 10,
    // just before the second would have run out.
    expect(s.fake.count(...SESSION)).toBe(3)
  })
})
