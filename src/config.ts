import { AMOUNT, toCents } from "./money.ts"
import type { Environment } from "./egress.ts"

/**
 * Everything the service reads from its environment, checked once at
 * start. A bad value stops it with a message that names the variable,
 * never its value.
 */
export type Config = {
  apiKey: string
  environment: Environment
  dataDir: string
  /** The owner's cap per draft payment, in cents; none when unset. */
  draftMaxCents?: number
  /** permitted_ips for the device registration; bunq's default when empty. */
  permittedIps: string[]
  host: string
  port: number
  path: string
  /** The bearer token every MCP request must send, when set. */
  authToken?: string
  /** Host header values accepted besides loopback. */
  allowedHosts: string[]
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

type Env = Record<string, string | undefined>

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

export function loadConfig(env: Env = process.env): Config {
  const apiKey = trimmed(env, "BUNQ_API_KEY")
  if (!apiKey) {
    throw new ConfigError(
      "BUNQ_API_KEY is not set: create an API key in the bunq app (Profile → Security & Settings → Developers → API keys) and bind it as this service's secret.",
    )
  }
  if (!/^[A-Za-z0-9_]{16,200}$/.test(apiKey)) {
    throw new ConfigError("BUNQ_API_KEY does not look like a bunq API key.")
  }

  const environment = trimmed(env, "BUNQ_ENVIRONMENT") ?? "production"
  if (environment !== "production" && environment !== "sandbox") {
    throw new ConfigError("BUNQ_ENVIRONMENT is production or sandbox.")
  }

  const rawMax = trimmed(env, "BUNQ_DRAFT_MAX_AMOUNT")
  let draftMaxCents: number | undefined
  if (rawMax !== undefined) {
    if (!AMOUNT.test(rawMax) || toCents(rawMax) <= 0) {
      throw new ConfigError(
        "BUNQ_DRAFT_MAX_AMOUNT is a positive EUR amount such as 500 or 250.00.",
      )
    }
    draftMaxCents = toCents(rawMax)
  }

  const permittedIps = (trimmed(env, "BUNQ_PERMITTED_IPS") ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean)
  for (const ip of permittedIps) {
    if (ip !== "*" && !IPV4.test(ip)) {
      throw new ConfigError(
        "BUNQ_PERMITTED_IPS is a comma-separated list of IPv4 addresses, or * for a wildcard API key.",
      )
    }
  }

  const port = Number(trimmed(env, "MCP_PORT") ?? "8080")
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("MCP_PORT is a port number.")
  }

  const path = trimmed(env, "MCP_PATH") ?? "/mcp"
  if (!/^\/[A-Za-z0-9._~-]+$/.test(path)) {
    throw new ConfigError("MCP_PATH is a path such as /mcp.")
  }

  const authToken = trimmed(env, "MCP_AUTH_TOKEN")
  if (authToken !== undefined && authToken.length < 16) {
    throw new ConfigError("MCP_AUTH_TOKEN is at least 16 characters.")
  }
  // Fail closed: without a token the tools answer whoever reaches the
  // port, so that takes an explicit MCP_AUTH=off.
  const auth = trimmed(env, "MCP_AUTH")
  if (auth !== undefined && auth !== "off") {
    throw new ConfigError("MCP_AUTH is off, or left unset.")
  }
  if (authToken === undefined && auth !== "off") {
    throw new ConfigError(
      "MCP_AUTH_TOKEN is not set: set it to a long random secret (PCP sends it for you), or set MCP_AUTH=off to serve the tools without one.",
    )
  }
  if (authToken !== undefined && auth === "off") {
    throw new ConfigError(
      "MCP_AUTH=off and MCP_AUTH_TOKEN are both set: choose one.",
    )
  }

  const allowedHosts = (trimmed(env, "MCP_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)

  return {
    apiKey,
    environment,
    dataDir: trimmed(env, "BUNQ_DATA_DIR") ?? "/data",
    draftMaxCents,
    permittedIps,
    host: trimmed(env, "MCP_HOST") ?? "0.0.0.0",
    port,
    path,
    authToken,
    allowedHosts,
  }
}
