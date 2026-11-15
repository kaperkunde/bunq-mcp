/**
 * IBANs (ISO 13616): the length each country uses, and the mod-97 check.
 * A draft payment goes only to an IBAN that passes both.
 */

/** The IBAN length of every country in the registry that a draft may name. */
// prettier-ignore
const LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18,
  NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24,
  SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24,
  TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
}

/** An IBAN without spaces, in upper case. */
export function normalizeIban(raw: string): string {
  return raw.replace(/[\s]+/g, "").toUpperCase()
}

/** The mod-97 remainder of the rearranged IBAN; 1 for a valid one. */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const code = char.charCodeAt(0)
    // A-Z is 10-35, 0-9 is itself.
    const value = code >= 65 && code <= 90 ? code - 55 : code - 48
    remainder =
      value >= 10
        ? (remainder * 100 + value) % 97
        : (remainder * 10 + value) % 97
  }
  return remainder
}

export type IbanCheck =
  { ok: true; iban: string } | { ok: false; reason: string }

/**
 * Whether `raw` is an IBAN: letters and digits only (spaces dropped), a
 * known country, that country's length, and the check digits right.
 */
export function checkIban(raw: string): IbanCheck {
  const iban = normalizeIban(raw)
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return {
      ok: false,
      reason: "An IBAN is two letters, two digits, then letters and digits.",
    }
  }
  const length = LENGTHS[iban.slice(0, 2)]
  if (length === undefined) {
    return {
      ok: false,
      reason: `${iban.slice(0, 2)} is not a country this service takes IBANs for.`,
    }
  }
  if (iban.length !== length) {
    return {
      ok: false,
      reason: `An IBAN from ${iban.slice(0, 2)} has ${length} characters; this one has ${iban.length}.`,
    }
  }
  if (mod97(iban) !== 1) {
    return {
      ok: false,
      reason: "The IBAN's check digits are wrong: it has a typo.",
    }
  }
  return { ok: true, iban }
}
