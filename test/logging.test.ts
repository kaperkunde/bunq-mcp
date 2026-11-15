import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { redact } from "../src/log.ts"
import { toolSpecs, runTool } from "../src/tools.ts"
import { API_KEY, ATTACKER_TEXT, OTHER_IBAN, OWN_IBAN } from "./fake-bunq.ts"
import { setup } from "./helpers.ts"

describe("logging", () => {
  it("never logs a body, a token, the key or an IBAN, through a whole run", async () => {
    const s = setup()
    const specs = toolSpecs({ client: s.client, logger: s.logger })
    const run = (name: string, args: Record<string, unknown> = {}) =>
      runTool(
        specs.find((spec) => spec.name === name)!,
        args,
        s.logger,
      )

    await run("get_user")
    await run("list_accounts", { include_closed: false })
    await run("list_payments", {
      account_id: 11,
      limit: 50,
      direction: "any",
      max_pages: 3,
    })
    await run("get_payment", { account_id: 11, payment_id: 1007 })
    await run("list_request_responses", { account_id: 11, limit: 50 })
    await run("list_cards")
    s.fake.expireSessions()
    await run("create_draft_payment", {
      account_id: 11,
      amount: "12.00",
      iban: OTHER_IBAN,
      counterparty_name: "Acme Webshop B.V.",
      description: "Invoice 77",
    })
    // A refusal from bunq: its error text stays out of the log too.
    await run("get_payment", { account_id: 11, payment_id: 1 })

    expect(s.lines.length).toBeGreaterThan(5)
    const log = s.lines.join("\n")
    const context = JSON.parse(
      readFileSync(join(s.dir, "context.json"), "utf8"),
    )
    const secrets = [
      API_KEY,
      context.installation.token,
      context.session.token,
      OWN_IBAN,
      OTHER_IBAN,
      "BE68539007547034",
      ATTACKER_TEXT,
      "Invoice",
      "Acme",
      "Jan Jansen",
      "Kevin",
      "1234.56",
      "Payment not found",
      "BEGIN",
    ]
    for (const secret of secrets) expect(log, secret).not.toContain(secret)
    // Every line is an event with fields, never free text.
    for (const line of s.lines) expect(JSON.parse(line)).toHaveProperty("event")
    for (const request of s.fake.requests) {
      if (request.body) expect(log).not.toContain(request.body)
      const auth = request.headers["X-Bunq-Client-Authentication"]
      if (auth) expect(log).not.toContain(auth)
    }
  })

  it("redacts IBANs, tokens and keys in any field", () => {
    expect(redact(`to ${OWN_IBAN} now`)).toBe("to NL**…4300 now")
    expect(redact("NL91 ABNA 0417 1643 00")).toBe("NL**…4300")
    expect(redact(`key ${API_KEY}`)).toBe("key [token]")
    expect(redact("a".repeat(64))).toBe("[token]")
    expect(
      redact("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"),
    ).toBe("[key]")
    expect(redact("/v1/user/4242/monetary-account/11/payment")).toBe(
      "/v1/user/4242/monetary-account/11/payment",
    )
  })
})
