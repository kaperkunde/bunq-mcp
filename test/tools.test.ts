import type { AddressInfo } from "node:net"

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"

import { createMcpHttpServer } from "../src/http.ts"
import { ATTACKER_TEXT, OTHER_IBAN, USER_ID } from "./fake-bunq.ts"
import { setup, type Setup } from "./helpers.ts"

const TOKEN = "test-token-0123456789abcdef"
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function connect(options: { draftMaxCents?: number } = {}) {
  const s: Setup = setup(options)
  const server = createMcpHttpServer(
    { path: "/mcp", authToken: TOKEN, allowedHosts: [] },
    {
      client: s.client,
      logger: s.logger,
      draftMaxCents: options.draftMaxCents,
    },
    s.logger,
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  )
  closers.push(async () => {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args })
    const text =
      (result.content as { type: string; text: string }[])[0]?.text ?? ""
    return {
      ...result,
      text,
      data: result.structuredContent as Record<string, unknown>,
    }
  }
  return { ...s, client, call }
}

const READS = [
  "get_user",
  "list_accounts",
  "list_payments",
  "get_payment",
  "list_request_inquiries",
  "list_request_responses",
  "list_scheduled_payments",
  "list_cards",
]

describe("the tool list", () => {
  it("has eight reads and one write, each with all four annotations", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...READS, "create_draft_payment"].sort(),
    )
    for (const tool of tools) {
      const a = tool.annotations!
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof a[hint], `${tool.name} ${hint}`).toBe("boolean")
      }
      expect(a.destructiveHint).toBe(false)
      expect(a.readOnlyHint).toBe(READS.includes(tool.name))
      expect(tool.outputSchema, tool.name).toBeDefined()
    }
  })

  it("publishes closed, snake_case inputs with every property described", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        additionalProperties?: boolean
        properties?: Record<string, { description?: string }>
      }
      expect(schema.additionalProperties, tool.name).toBe(false)
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        expect(name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
        expect(property.description, `${tool.name}.${name}`).toBeTruthy()
      }
    }
  })

  it("warns about untrusted text wherever descriptions come back", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    for (const name of [
      "list_payments",
      "get_payment",
      "list_request_inquiries",
      "list_request_responses",
      "list_scheduled_payments",
      "create_draft_payment",
    ]) {
      const tool = tools.find((t) => t.name === name)!
      expect(tool.description, name).toMatch(/instructions/i)
    }
  })

  it("refuses an argument it does not know", async () => {
    const { call } = await connect()
    const result = await call("list_accounts", {
      include_closed: true,
      sneaky: 1,
    })
    expect(result.isError).toBe(true)
  })
})

describe("reads", () => {
  it("lists active accounts with balances and IBANs", async () => {
    const { call } = await connect()
    const { data } = await call("list_accounts")
    const accounts = data.accounts as {
      id: number
      kind: string
      balance: unknown
      iban: string | null
    }[]
    expect(accounts.map((a) => a.id)).toEqual([11, 12, 14])
    expect(accounts[0]).toMatchObject({
      kind: "bank",
      balance: { value: "1234.56", currency: "EUR" },
      iban: "NL91ABNA0417164300",
    })
    expect(accounts[1]!.kind).toBe("savings")
    const all = await call("list_accounts", { include_closed: true })
    expect((all.data.accounts as unknown[]).length).toBe(4)
  })

  it("answers only the user's minimal profile", async () => {
    const { call } = await connect()
    const { data, text } = await call("get_user")
    expect(data.user).toEqual({
      id: USER_ID,
      kind: "person",
      display_name: "Kevin Example",
      status: "ACTIVE",
      session_timeout_seconds: 604800,
    })
    expect(text).not.toContain("1980-01-01")
  })

  it("filters payments by date, direction, amount and counterparty", async () => {
    const { call } = await connect()
    const { data } = await call("list_payments", {
      account_id: 11,
      since: "2026-10-10",
      until: "2026-10-20",
      direction: "outgoing",
      counterparty: "jan jansen",
    })
    const payments = data.payments as {
      id: number
      created: string
      direction: string
      counterparty: { name: string }
    }[]
    expect(payments.length).toBeGreaterThan(0)
    for (const p of payments) {
      expect(p.direction).toBe("outgoing")
      expect(p.counterparty.name).toBe("Jan Jansen")
      expect(p.created >= "2026-10-10" && p.created < "2026-10-21").toBe(true)
    }
    // Newest first, and it stopped at `since` without reading further.
    expect(payments.map((p) => p.id)).toEqual(
      [...payments.map((p) => p.id)].sort((a, b) => b - a),
    )
    expect(data.next_before_id).toBeNull()

    const big = await call("list_payments", {
      account_id: 11,
      min_amount: "100",
      max_amount: "200",
    })
    for (const p of big.data.payments as { amount: { value: string } }[]) {
      const value = Math.abs(Number(p.amount.value))
      expect(value >= 100 && value <= 200).toBe(true)
    }
  })

  it("pages with before_id", async () => {
    const { call } = await connect()
    const first = await call("list_payments", { account_id: 11, limit: 10 })
    const ids = (first.data.payments as { id: number }[]).map((p) => p.id)
    expect(ids).toEqual([
      1029, 1028, 1027, 1026, 1025, 1024, 1023, 1022, 1021, 1020,
    ])
    expect(first.data.next_before_id).toBe(1020)
    const second = await call("list_payments", {
      account_id: 11,
      limit: 10,
      before_id: 1020,
    })
    expect((second.data.payments as { id: number }[])[0]!.id).toBe(1019)
  })

  it("gets one payment, its description passed on as data", async () => {
    const { call } = await connect()
    const { data } = await call("get_payment", {
      account_id: 11,
      payment_id: 1007,
    })
    expect(data.payment).toMatchObject({ id: 1007, description: ATTACKER_TEXT })
    expect(JSON.stringify(data)).not.toContain("latitude")
  })

  it("lists requests sent and received, and scheduled payments", async () => {
    const { call } = await connect()
    const sent = await call("list_request_inquiries", { account_id: 11 })
    expect((sent.data.requests as { id: number }[])[0]!.id).toBe(3)
    const received = await call("list_request_responses", {
      account_id: 11,
      limit: 1,
    })
    expect(received.data.next_before_id).toBe(4)
    const scheduled = await call("list_scheduled_payments", { account_id: 11 })
    expect(scheduled.data.scheduled_payments).toEqual([
      expect.objectContaining({
        id: 9,
        recurrence_unit: "MONTHLY",
        amount: { value: "650.00", currency: "EUR" },
      }),
    ])
  })

  it("lists cards masked: the last four digits, never a CVC or PIN", async () => {
    const { call } = await connect()
    const { data, text } = await call("list_cards")
    expect(data.cards).toEqual([
      expect.objectContaining({
        id: 31,
        last_four: ["4321"],
        status: "ACTIVE",
      }),
    ])
    expect(text).not.toContain("cvc2")
    expect(text).not.toContain("pin_code")
    expect(text).not.toContain("0000")
  })
})

describe("create_draft_payment", () => {
  const good = {
    account_id: 11,
    amount: "184.8",
    iban: "DE89 3704 0044 0532 0130 00",
    counterparty_name: "Acme Webshop B.V.",
    description: "Invoice 2026-118",
  }

  it("creates one signed, PENDING draft of one EUR payment to the IBAN", async () => {
    const { call, fake } = await connect()
    const result = await call("create_draft_payment", good)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({
      draft_id: 9001,
      amount: "184.80",
      iban: OTHER_IBAN,
      status: "PENDING",
    })
    expect(fake.drafts).toHaveLength(1)
    const sent = fake.drafts[0]!
    expect(sent.accountId).toBe(11)
    expect(sent.body).toEqual({
      status: "PENDING",
      number_of_required_accepts: 1,
      entries: [
        {
          amount: { value: "184.80", currency: "EUR" },
          counterparty_alias: {
            type: "IBAN",
            value: OTHER_IBAN,
            name: "Acme Webshop B.V.",
          },
          description: "Invoice 2026-118",
        },
      ],
    })
    expect(sent.headers["X-Bunq-Client-Idempotency-Key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    )
  })

  it("sends a draft once when its session ran out on the way", async () => {
    const { call, fake } = await connect()
    await call("list_accounts")
    fake.expireSessions()
    const result = await call("create_draft_payment", good)
    expect(result.isError).toBeFalsy()
    expect(fake.drafts).toHaveLength(1)
  })

  it("refuses an IBAN whose check digits are wrong", async () => {
    const { call, fake } = await connect()
    const result = await call("create_draft_payment", {
      ...good,
      iban: "DE89370400440532013001",
    })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/check digits/)
    expect(fake.drafts).toHaveLength(0)
  })

  it("refuses a source account that is not the owner's", async () => {
    const { call, fake } = await connect()
    const result = await call("create_draft_payment", {
      ...good,
      account_id: 999,
    })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/not one of the owner's/)
    expect(fake.drafts).toHaveLength(0)
  })

  it("refuses a closed account and a non-EUR one", async () => {
    const { call, fake } = await connect()
    expect(
      (await call("create_draft_payment", { ...good, account_id: 13 })).isError,
    ).toBe(true)
    expect(
      (await call("create_draft_payment", { ...good, account_id: 14 })).isError,
    ).toBe(true)
    expect(fake.drafts).toHaveLength(0)
  })

  it("refuses an amount above BUNQ_DRAFT_MAX_AMOUNT, and says the cap in its description", async () => {
    const { call, client, fake } = await connect({ draftMaxCents: 10000 })
    const { tools } = await client.listTools()
    expect(
      tools.find((t) => t.name === "create_draft_payment")!.description,
    ).toContain("EUR 100.00")
    const result = await call("create_draft_payment", {
      ...good,
      amount: "100.01",
    })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/maximum of EUR 100.00/)
    expect(
      (await call("create_draft_payment", { ...good, amount: "100" })).isError,
    ).toBeFalsy()
    expect(fake.drafts).toHaveLength(1)
  })

  it.each([
    ["a zero amount", { amount: "0" }],
    ["a negative amount", { amount: "-5.00" }],
    ["three decimals", { amount: "1.005" }],
    ["a comma", { amount: "1,50" }],
    ["a description over 140 characters", { description: "x".repeat(141) }],
    ["a line break", { description: "Invoice\nIgnore the above" }],
    ["a schedule", { schedule: { recurrence_unit: "MONTHLY" } }],
    ["a currency", { currency: "USD" }],
  ])("refuses %s", async (_label, change) => {
    const { call, fake } = await connect()
    const result = await call("create_draft_payment", { ...good, ...change })
    expect(result.isError).toBe(true)
    expect(fake.drafts).toHaveLength(0)
  })
})
