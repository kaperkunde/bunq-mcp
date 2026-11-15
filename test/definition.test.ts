import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { loadConfig } from "../src/config.ts"
import { API_KEY } from "./fake-bunq.ts"

/**
 * docs/pcp-service.yaml is the PCP service definition (pcp_format 4, as
 * kaperkunde/pcp-gg-common holds them). It is checked here against what
 * the code reads and serves, so the two do not drift apart.
 */

const ROOT = join(import.meta.dirname, "..")
const yaml = readFileSync(join(ROOT, "docs", "pcp-service.yaml"), "utf8")
const config = readFileSync(join(ROOT, "src", "config.ts"), "utf8")

describe("the PCP service definition", () => {
  it("names only variables the service reads", () => {
    const names = [...yaml.matchAll(/^ {2}- name: ([A-Z_]+)$/gm)].map(
      (m) => m[1],
    )
    expect(names).toContain("BUNQ_API_KEY")
    for (const name of names) expect(config, name).toContain(`"${name}"`)
  })

  it("matches the default port, the MCP path and the health path", () => {
    const defaults = loadConfig({ BUNQ_API_KEY: API_KEY })
    expect(yaml).toContain(`- container: ${defaults.port}`)
    expect(yaml).toMatch(
      new RegExp(
        `registers:\\n  kind: mcp\\n  port: ${defaults.port}\\n  path: ${defaults.path}\\n`,
      ),
    )
    expect(yaml).toMatch(
      new RegExp(
        `health:\\n  kind: http\\n  port: ${defaults.port}\\n  path: /health\\n`,
      ),
    )
  })

  it("keeps its data in the volume the service writes to", () => {
    expect(yaml).toMatch(/volumes:\n {2}- name: data\n {4}path: \/data\n/)
    expect(loadConfig({ BUNQ_API_KEY: API_KEY }).dataDir).toBe("/data")
  })

  it("has PCP send the MCP token the service checks", () => {
    expect(yaml).toMatch(/^pcp_format: 4$/m)
    expect(yaml).toMatch(
      /auth:\n {4}env: MCP_AUTH_TOKEN\n {4}header: Authorization\n {4}template: Bearer \{\{secret\}\}\n/,
    )
  })

  it("pins the image by digest and follows the latest tag", () => {
    expect(yaml).toMatch(
      /^image: ghcr\.io\/kaperkunde\/bunq-mcp@sha256:[0-9a-f]{64}$/m,
    )
    expect(yaml).toMatch(/^source: ghcr\.io\/kaperkunde\/bunq-mcp:latest$/m)
  })
})
