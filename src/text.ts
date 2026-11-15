/**
 * Text that goes to bunq and shows in the owner's app (a draft's recipient
 * name and description) is one line of characters that show: no control
 * characters (Cc: line breaks, tabs, escapes) and no format characters
 * (Cf: bidi overrides and isolates, zero-width spaces and joiners, soft
 * hyphens), which could make the app show something else than was sent.
 */
const UNSEEN = /[\p{Cc}\p{Cf}]/u

/** Whether `value` has a control or format character. */
export function hasUnseen(value: string): boolean {
  return UNSEEN.test(value)
}

/** One line of visible text of 1 to `max` characters. */
export function plainLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    !hasUnseen(value)
  )
}
