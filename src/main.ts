import { BunqClient } from "./bunq.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { httpsTransport } from "./egress.ts"
import { createMcpHttpServer } from "./http.ts"
import { createLogger } from "./log.ts"
import { Store } from "./store.ts"

/**
 * Starts the service: reads the environment, makes (or reads) the client
 * key, and listens. The bunq session is made on the first tool call, so a
 * start needs no network; a bad API key shows on that call and in the log.
 */

const logger = createLogger()

let config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error("config_invalid", { message: error.message })
    process.exit(2)
  }
  throw error
}

const store = new Store(config.dataDir)
try {
  store.keys()
} catch {
  logger.error("data_dir_unwritable", { dir: config.dataDir })
  process.exit(2)
}

const client = new BunqClient({
  config,
  store,
  transport: httpsTransport(config.environment),
  logger,
})

if (!config.authToken) {
  logger.warn("mcp_auth_off", {
    message: "MCP_AUTH=off: anything that reaches the port can use the tools.",
  })
}

const server = createMcpHttpServer(
  config,
  { client, logger, draftMaxCents: config.draftMaxCents },
  logger,
)

server.listen(config.port, config.host, () => {
  logger.info("listening", {
    host: config.host,
    port: config.port,
    path: config.path,
    environment: config.environment,
  })
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
