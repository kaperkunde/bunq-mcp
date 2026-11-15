/**
 * Euro amounts as strings ("184.80"), as bunq writes them, and as whole
 * cents for comparing. No floating point touches an amount.
 */

/** A positive amount: up to seven digits, a dot and up to two decimals. */
export const AMOUNT = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/

/** "184.8" → 18480. Only for strings that match AMOUNT. */
export function toCents(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".")
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
}

/** 18480 → "184.80". */
export function fromCents(cents: number): string {
  const whole = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, "0")
  return `${whole}.${fraction}`
}

/**
 * A signed amount as bunq answers it ("-12.50", "1000.00") → cents, or
 * undefined for anything else.
 */
export function signedCents(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const match = /^(-?)([0-9]{1,12})(?:\.([0-9]{1,2}))?$/.exec(value)
  if (!match) return undefined
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"))
  return match[1] === "-" ? -cents : cents
}
