import { describe, expect, it } from "vitest"

import { ConfigError, loadConfig } from "../src/config.ts"
import { API_KEY } from "./fake-bunq.ts"

const TOKEN = "mcp-token-0123456789abcdef"

describe("loadConfig", () => {
  it("reads the defaults", () => {
    const config = loadConfig({ BUNQ_API_KEY: API_KEY, MCP_AUTH_TOKEN: TOKEN })
    expect(config).toMatchObject({
      environment: "production",
      dataDir: "/data",
      host: "0.0.0.0",
      port: 8080,
      path: "/mcp",
      permittedIps: [],
      allowedHosts: [],
    })
    expect(config.draftMaxCents).toBeUndefined()
    expect(config.authToken).toBe(TOKEN)
  })

  it("needs the API key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
  })

  it("never puts the key in its message", () => {
    const key = "not a key! but secret"
    try {
      loadConfig({ BUNQ_API_KEY: key })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain(key)
    }
  })

  it("reads the draft cap in cents", () => {
    expect(
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH_TOKEN: TOKEN,
        BUNQ_DRAFT_MAX_AMOUNT: "250",
      }).draftMaxCents,
    ).toBe(25000)
    expect(
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH_TOKEN: TOKEN,
        BUNQ_DRAFT_MAX_AMOUNT: "99.5",
      }).draftMaxCents,
    ).toBe(9950)
    for (const bad of ["0", "-5", "1,50", "abc", "1.234"]) {
      expect(() =>
        loadConfig({
          BUNQ_API_KEY: API_KEY,
          MCP_AUTH_TOKEN: TOKEN,
          BUNQ_DRAFT_MAX_AMOUNT: bad,
        }),
      ).toThrow(ConfigError)
    }
  })

  it("takes the sandbox only by name", () => {
    expect(
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH_TOKEN: TOKEN,
        BUNQ_ENVIRONMENT: "sandbox",
      }).environment,
    ).toBe("sandbox")
    expect(() =>
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH_TOKEN: TOKEN,
        BUNQ_ENVIRONMENT: "https://evil.example",
      }),
    ).toThrow(ConfigError)
  })

  it("takes IPv4 addresses or * for the device", () => {
    expect(
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH_TOKEN: TOKEN,
        BUNQ_PERMITTED_IPS: "192.0.2.1, *",
      }).permittedIps,
    ).toEqual(["192.0.2.1", "*"])
    expect(() =>
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH_TOKEN: TOKEN,
        BUNQ_PERMITTED_IPS: "example.com",
      }),
    ).toThrow(ConfigError)
  })

  it("wants a real MCP token when one is set", () => {
    expect(() =>
      loadConfig({ BUNQ_API_KEY: API_KEY, MCP_AUTH_TOKEN: "short" }),
    ).toThrow(ConfigError)
  })

  it("will not start without an MCP token unless told MCP_AUTH=off", () => {
    expect(() => loadConfig({ BUNQ_API_KEY: API_KEY })).toThrow(
      /MCP_AUTH_TOKEN is not set/,
    )
    const open = loadConfig({ BUNQ_API_KEY: API_KEY, MCP_AUTH: "off" })
    expect(open.authToken).toBeUndefined()
    for (const value of ["0", "false", "no", "OFF", "disabled"]) {
      expect(() =>
        loadConfig({ BUNQ_API_KEY: API_KEY, MCP_AUTH: value }),
      ).toThrow(ConfigError)
    }
    expect(() =>
      loadConfig({
        BUNQ_API_KEY: API_KEY,
        MCP_AUTH: "off",
        MCP_AUTH_TOKEN: TOKEN,
      }),
    ).toThrow(/choose one/)
  })
})
