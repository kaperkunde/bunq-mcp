import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

import { BunqClient } from "../src/bunq.ts"
import type { Transport } from "../src/egress.ts"
import { createLogger, type Logger } from "../src/log.ts"
import { Store } from "../src/store.ts"
import { API_KEY, FakeBunq } from "./fake-bunq.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bunq-mcp-test-"))
  dirs.push(dir)
  return dir
}

/** A clock the test moves by hand. */
export class Clock {
  ms = Date.UTC(2026, 10, 15, 9, 0, 0)
  now = () => this.ms
  advance(ms: number) {
    this.ms += ms
  }
  sleep = async (ms: number) => {
    this.ms += ms
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000

/** Captures every log line. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  return { logger: createLogger((line) => lines.push(line)), lines }
}

export type Setup = {
  fake: FakeBunq
  clock: Clock
  dir: string
  client: BunqClient
  lines: string[]
  logger: Logger
  restart(options?: {
    apiKey?: string
    environment?: "production" | "sandbox"
  }): BunqClient
}

export function setup(
  options: {
    dir?: string
    draftMaxCents?: number
    transport?: (fake: FakeBunq) => Transport
  } = {},
): Setup {
  const clock = new Clock()
  const fake = new FakeBunq(clock.now)
  const dir = options.dir ?? tempDir()
  const { logger, lines } = capturingLogger()
  const make = (
    apiKey = API_KEY,
    environment: "production" | "sandbox" = "production",
  ) =>
    new BunqClient({
      config: {
        apiKey,
        environment,
        draftMaxCents: options.draftMaxCents,
        permittedIps: [],
      },
      store: new Store(dir),
      transport: options.transport ? options.transport(fake) : fake.transport,
      logger,
      now: clock.now,
      sleep: clock.sleep,
    })
  const result: Setup = {
    fake,
    clock,
    dir,
    client: make(),
    lines,
    logger,
    restart(restartOptions = {}) {
      result.client = make(restartOptions.apiKey, restartOptions.environment)
      return result.client
    },
  }
  return result
}
