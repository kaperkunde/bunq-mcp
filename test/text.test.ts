import { describe, expect, it } from "vitest"

import { hasUnseen, plainLine } from "../src/text.ts"

describe("hasUnseen", () => {
  it("finds control and format characters, and nothing in plain text", () => {
    for (const char of [
      "\n",
      "\t",
      "\u0000",
      "\u007f",
      "‮",
      "⁦",
      "​",
      "‍",
      "­",
      "﻿",
      "؜",
    ]) {
      expect(hasUnseen(`a${char}b`), JSON.stringify(char)).toBe(true)
    }
    for (const text of [
      "Factuur 2026-118 – €12,50",
      "Café Zoë",
      "日本語",
      "Ĳsselmeer",
    ]) {
      expect(hasUnseen(text), text).toBe(false)
    }
  })
})

describe("plainLine", () => {
  it("takes one visible line of 1 to max characters", () => {
    expect(plainLine("Invoice 118", 140)).toBe(true)
    expect(plainLine("", 140)).toBe(false)
    expect(plainLine("x".repeat(141), 140)).toBe(false)
    expect(plainLine(42, 140)).toBe(false)
  })
})
