/**
 * The one logger. It writes one JSON line per event to standard error: an
 * event name and a few fields the caller picks (a method, a path, a status,
 * a duration). It never takes a request or response body, and every string
 * field passes `redact` first, so an IBAN, a token or a key that slips into
 * a field is masked before it is written.
 */

export type LogFields = Record<string, string | number | boolean | undefined>

export type Logger = {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** An IBAN as it is written, with or without groups of four. */
const IBAN =
  /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi
/**
 * A token, a key or a signature: a long run of hex, of letters, digits and
 * underscores (bunq's API keys), or of base64 (a path breaks the last one
 * with its dashes and stays readable).
 */
const TOKEN = /(?:[A-Za-z0-9_]{32,}|[A-Za-z0-9+/]{60,}={0,2})/g
/** A PEM block. */
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g

/**
 * Masks what must never reach a log: PEM blocks, tokens and keys, and
 * IBANs (all but the country code and the last four characters).
 */
export function redact(text: string): string {
  return text
    .replace(PEM, "[key]")
    .replace(TOKEN, "[token]")
    .replace(IBAN, (match) => {
      const compact = match.replace(/ /g, "")
      return `${compact.slice(0, 2)}**…${compact.slice(-4)}`
    })
}

/** Where lines go; standard error unless a test hands its own. */
export type Sink = (line: string) => void

export function createLogger(
  sink: Sink = (line) => process.stderr.write(`${line}\n`),
): Logger {
  function write(level: string, event: string, fields: LogFields = {}) {
    const line: Record<string, string | number | boolean> = {
      time: new Date().toISOString(),
      level,
      event,
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      line[key] = typeof value === "string" ? redact(value) : value
    }
    sink(JSON.stringify(line))
  }
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  }
}

/** A logger that drops everything (for tests that do not look). */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}
