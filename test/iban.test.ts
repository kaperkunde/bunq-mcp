import { describe, expect, it } from "vitest"

import { checkIban, normalizeIban } from "../src/iban.ts"

describe("checkIban", () => {
  it.each([
    "NL91ABNA0417164300",
    "DE89370400440532013000",
    "GB82WEST12345698765432",
    "BE68539007547034",
    "FR1420041010050500013M02606",
    "nl91 abna 0417 1643 00",
  ])("takes %s", (iban) => {
    const result = checkIban(iban)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.iban).toBe(normalizeIban(iban))
  })

  it("refuses a typo: the check digits do not match", () => {
    const result = checkIban("NL91ABNA0417164301")
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("check digits"),
    })
  })

  it("refuses two swapped digits", () => {
    expect(checkIban("DE89370400440532010300").ok).toBe(false)
  })

  it("refuses the wrong length for the country", () => {
    const result = checkIban("NL91ABNA041716430")
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("18 characters"),
    })
  })

  it("refuses a country without IBANs", () => {
    expect(checkIban("US12345678901234567890").ok).toBe(false)
  })

  it("refuses anything but letters and digits", () => {
    expect(checkIban("NL91-ABNA-0417-1643-00").ok).toBe(false)
    expect(checkIban("").ok).toBe(false)
  })
})
