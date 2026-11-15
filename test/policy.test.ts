import { describe, expect, it } from "vitest"

import type { OutgoingRequest } from "../src/egress.ts"
import { PolicyError, assertAllowed, guard } from "../src/policy.ts"
import { OTHER_IBAN } from "./fake-bunq.ts"
import { setup } from "./helpers.ts"

const DRAFT_PATH = "/v1/user/4242/monetary-account/11/draft-payment"

function draft(
  overrides: Record<string, unknown> = {},
  entry: Record<string, unknown> = {},
) {
  return JSON.stringify({
    status: "PENDING",
    number_of_required_accepts: 1,
    entries: [
      {
        amount: { value: "10.00", currency: "EUR" },
        counterparty_alias: { type: "IBAN", value: OTHER_IBAN, name: "Acme" },
        description: "Invoice 1",
        ...entry,
      },
    ],
    ...overrides,
  })
}

function req(method: string, path: string, body?: string): OutgoingRequest {
  return { method, path, headers: {}, body }
}

describe("the request allow-list", () => {
  it.each([
    "/v1/user",
    "/v1/user/4242/monetary-account?count=200",
    "/v1/user/4242/monetary-account/11/payment?count=200&older_id=1029",
    "/v1/user/4242/monetary-account/11/payment/1001",
    "/v1/user/4242/monetary-account/11/request-inquiry?count=50",
    "/v1/user/4242/monetary-account/11/request-response?count=50&older_id=4",
    "/v1/user/4242/monetary-account/11/schedule-payment?count=200",
    "/v1/user/4242/card?count=200",
  ])("lets GET %s through", (path) => {
    expect(() => assertAllowed(req("GET", path))).not.toThrow()
  })

  it.each([
    "/v1/user/4242/monetary-account/11/draft-payment",
    "/v1/user/4242/monetary-account/11/schedule",
    "/v1/user/4242/event",
    "/v1/user/4242/monetary-account/11/payment?description=x",
    "/v1/installation",
    "/v1/user/4242/../4243/card",
  ])("refuses GET %s", (path) => {
    expect(() => assertAllowed(req("GET", path))).toThrow(PolicyError)
  })

  it.each(["/v1/installation", "/v1/device-server", "/v1/session-server"])(
    "lets the bootstrap POST %s through",
    (path) => {
      expect(() => assertAllowed(req("POST", path, "{}"))).not.toThrow()
    },
  )

  it.each([
    ["POST", "/v1/user/4242/monetary-account/11/payment"],
    ["POST", "/v1/user/4242/monetary-account/11/payment-batch"],
    ["POST", "/v1/user/4242/monetary-account/11/request-inquiry"],
    ["POST", "/v1/user/4242/monetary-account/11/schedule-payment"],
    ["POST", "/v1/user/4242/card/31/replace"],
    ["PUT", "/v1/user-person/4242"],
    ["PUT", "/v1/user/4242/monetary-account/11/draft-payment/9001"],
    ["PUT", "/v1/user/4242/card/31"],
    ["DELETE", "/v1/session/77"],
    ["PATCH", "/v1/user/4242/monetary-account/11"],
  ])("refuses %s %s", (method, path) => {
    expect(() => assertAllowed(req(method, path, "{}"))).toThrow(PolicyError)
  })

  it("lets one EUR payment to a valid IBAN through as a draft", () => {
    expect(() => assertAllowed(req("POST", DRAFT_PATH, draft()))).not.toThrow()
  })

  it.each([
    [
      "two payments",
      draft({
        entries: [
          JSON.parse(draft()).entries[0],
          JSON.parse(draft()).entries[0],
        ],
      }),
    ],
    ["no payment", draft({ entries: [] })],
    [
      "a schedule",
      draft({
        schedule: {
          time_start: "2026-12-01",
          recurrence_unit: "MONTHLY",
          recurrence_size: 1,
        },
      }),
    ],
    ["two accepts", draft({ number_of_required_accepts: 2 })],
    ["an accepted status", draft({ status: "ACCEPTED" })],
    ["dollars", draft({}, { amount: { value: "10.00", currency: "USD" } })],
    [
      "a zero amount",
      draft({}, { amount: { value: "0.00", currency: "EUR" } }),
    ],
    [
      "a negative amount",
      draft({}, { amount: { value: "-10.00", currency: "EUR" } }),
    ],
    [
      "an email",
      draft(
        {},
        { counterparty_alias: { type: "EMAIL", value: "a@b.c", name: "A" } },
      ),
    ],
    [
      "a bad IBAN",
      draft(
        {},
        {
          counterparty_alias: {
            type: "IBAN",
            value: "DE89370400440532013001",
            name: "A",
          },
        },
      ),
    ],
    ["an attachment", draft({}, { attachment: [{ id: 1 }] })],
    ["a long description", draft({}, { description: "x".repeat(141) })],
    ["an empty description", draft({}, { description: "" })],
    ["a line break", draft({}, { description: "Invoice\nPay more" })],
    ["a bidi override", draft({}, { description: "Invoice \u202E8110" })],
    ["a zero-width space", draft({}, { description: "Invoice\u200B118" })],
    [
      "a bidi isolate in the name",
      draft(
        {},
        {
          counterparty_alias: {
            type: "IBAN",
            value: OTHER_IBAN,
            name: "Acme \u2067Bank",
          },
        },
      ),
    ],
    [
      "a zero-width joiner in the name",
      draft(
        {},
        {
          counterparty_alias: {
            type: "IBAN",
            value: OTHER_IBAN,
            name: "Ac\u200Dme",
          },
        },
      ),
    ],
    [
      "a name over 70 characters",
      draft(
        {},
        {
          counterparty_alias: {
            type: "IBAN",
            value: OTHER_IBAN,
            name: "x".repeat(71),
          },
        },
      ),
    ],
    ["no JSON", "not json"],
  ])("refuses a draft with %s", (_label, body) => {
    expect(() => assertAllowed(req("POST", DRAFT_PATH, body))).toThrow(
      PolicyError,
    )
  })

  it("refuses a draft above the owner's maximum", () => {
    const body = draft({}, { amount: { value: "500.01", currency: "EUR" } })
    expect(() => assertAllowed(req("POST", DRAFT_PATH, body), 50000)).toThrow(
      PolicyError,
    )
    expect(() =>
      assertAllowed(req("POST", DRAFT_PATH, draft()), 50000),
    ).not.toThrow()
  })

  it("never hands a refused request to the transport", async () => {
    let reached = 0
    const send = guard(async () => {
      reached++
      return { status: 200, headers: {}, body: "{}" }
    })
    await expect(
      send(req("POST", "/v1/user/4242/monetary-account/11/payment", "{}")),
    ).rejects.toThrow(PolicyError)
    await expect(send(req("DELETE", "/v1/session/77"))).rejects.toThrow(
      PolicyError,
    )
    expect(reached).toBe(0)
  })

  it("sits in front of every request the client makes", async () => {
    // The client is built over the guard: a path outside the allow-list
    // fails before the fake sees it.
    const s = setup()
    await s.client.userId()
    const seen = s.fake.requests.length
    await expect(s.client.list("/user/4242/event")).rejects.toThrow(PolicyError)
    expect(s.fake.requests.length).toBe(seen)
  })
})
