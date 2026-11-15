import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Environment } from "./egress.ts"

/**
 * What the service keeps in its data folder (a named volume), readable by
 * its own user only:
 *
 * - `client-key.pem`: the RSA key pair made on first start (2048 bits, as
 *   bunq takes it). Its public half is the installation's.
 * - `context.json`: the installation token and bunq's public key, the
 *   device's id and a hash of the API key it was registered with (so a new
 *   key registers a new device), and the current session: its token, the
 *   user's id, when it was made and how long bunq keeps it.
 *
 * Writes go to a temporary file and are renamed into place, so a crash
 * leaves the old file or the new one, never half of one.
 */

export type SessionState = {
  token: string
  userId: number
  createdAt: string
  timeoutSeconds: number
}

export type ContextState = {
  version: 1
  environment: Environment
  /** SHA-256 of the client public key the installation was made with. */
  publicKeySha256: string
  installation?: { token: string; serverPublicKey: string }
  device?: { id: number; apiKeySha256: string }
  session?: SessionState
}

const KEY_FILE = "client-key.pem"
const CONTEXT_FILE = "context.json"

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export type ClientKeys = {
  privateKey: KeyObject
  publicKeyPem: string
}

export class Store {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** The client key pair, made on first use. */
  keys(): ClientKeys {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, KEY_FILE)
    let pem: string
    try {
      pem = readFileSync(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      })
      // wx: never write over a key another start made in the meantime.
      try {
        writeFileSync(path, privateKey, { flag: "wx", mode: 0o600 })
      } catch (raced) {
        if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced
      }
      pem = readFileSync(path, "utf8")
    }
    const privateKey = createPrivateKey(pem)
    const publicKeyPem = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString()
    return { privateKey, publicKeyPem }
  }

  /** The saved context, or undefined when there is none or it is unreadable. */
  readContext(): ContextState | undefined {
    let text: string
    try {
      text = readFileSync(join(this.dir, CONTEXT_FILE), "utf8")
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(text) as ContextState
      return parsed?.version === 1 ? parsed : undefined
    } catch {
      return undefined
    }
  }

  writeContext(state: ContextState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, CONTEXT_FILE)
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(temporary, path)
  }
}
