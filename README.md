# bunq-mcp

An MCP server for one bunq user, made to run as a [PCP](https://pcp.gg)
service. An assistant can read your bunq accounts, balances, payments,
payment requests, scheduled payments and cards, and prepare **draft**
payments. A draft moves no money: bunq holds it until you accept or reject
it in the bunq app.

Kaperkunde keeps it, for the pcp.gg services list (kaperkunde/pcp#142). It
is a small client of its own: no bunq SDK, two runtime dependencies
(`@modelcontextprotocol/server` and `zod`), Node 24. The hardening rules
come from
[datadefend/bunq-private-account-mcp](https://github.com/datadefend/bunq-private-account-mcp),
written again here; [docs/audit-datadefend.md](docs/audit-datadefend.md)
says what was taken and what was not.

It is not made, endorsed or supported by bunq.

## Tools

| Tool                      | Tier  | Suggested level | What it does                                                                                                                                                                                                                                                             |
| ------------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_user`                | Read  | allowed         | The bunq user the key belongs to: id, person or company, display name, session timeout. Nothing else of the profile.                                                                                                                                                     |
| `list_accounts`           | Read  | allowed         | Accounts (bank, savings, joint, …) with balance, currency and IBAN; their ids are the `account_id` the other tools take. Closed ones only with `include_closed`.                                                                                                         |
| `list_payments`           | Read  | allowed         | One account's payments, newest first, filtered by `since`/`until` (dates, UTC), `min_amount`/`max_amount` (EUR, in or out), `direction`, `counterparty` (name or IBAN), `limit`, paged with `before_id`; reads up to `max_pages` pages of 200 from bunq to find matches. |
| `get_payment`             | Read  | allowed         | One payment by id.                                                                                                                                                                                                                                                       |
| `list_request_inquiries`  | Read  | allowed         | Payment requests sent from an account, with their status.                                                                                                                                                                                                                |
| `list_request_responses`  | Read  | allowed         | Payment requests received on an account (direct debits, iDEAL, bunq requests), with their status. Reading answers none.                                                                                                                                                  |
| `list_scheduled_payments` | Read  | allowed         | Scheduled and recurring payments on an account. Read only.                                                                                                                                                                                                               |
| `list_cards`              | Read  | allowed         | Cards: type, status, expiry, name, the last four digits of each number. Never a full number, CVC or PIN.                                                                                                                                                                 |
| `create_draft_payment`    | Write | **ask**         | A draft of one payment in EUR from one of your accounts to an IBAN. See below.                                                                                                                                                                                           |

Every tool states all four MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`), takes a closed
snake_case input whose every property is described, and answers JSON as
`structuredContent` with an output schema. Answers are picked fields, never
bunq's objects as they come: no geolocation, addresses, document numbers,
avatars, CVCs or PIN assignments.

**Untrusted text.** Payment descriptions, request descriptions and
counterparty names are written by whoever sent or asked for the money:
anyone can send you a cent with a description that reads like an
instruction. Every tool that returns them says so in its description, and
`create_draft_payment` says to create a draft only when you asked for that
payment in the conversation.

### Draft payments

`create_draft_payment` takes `account_id`, `amount` (EUR, `184.80`),
`iban`, `counterparty_name` and `description` (at most 140 characters), and
refuses, before anything is sent:

- an amount that is not positive, has more than two decimals, or is above
  `BUNQ_DRAFT_MAX_AMOUNT` when that is set;
- an IBAN from a country without IBANs, of the wrong length for its
  country, or whose check digits are wrong (ISO 13616 mod 97);
- a source account that is not one of yours, not active, or not in EUR.

It sends one draft with exactly one payment, status PENDING, one accept,
no schedule and no attachment, signed, with an idempotency key (so a draft
sent again after an expired session is still one draft). The request layer
checks the same again on the request itself (`src/policy.ts`).

bunq shows the draft in the app with the name the assistant typed, not a
verified account holder: check the IBAN before you accept.

### What it never does

The request layer (`src/policy.ts`) sits in front of the only connection
and lets through GET on the read paths above, the three POSTs that start a
session (`/installation`, `/device-server`, `/session-server`) and POST to
one account's `draft-payment` with the body described above. Everything
else is refused before it is sent: a payment, a payment batch, a request
inquiry, a change to a card, an account, a setting or a schedule, any PUT,
PATCH or DELETE. There is no code that builds one.

## Environment

| Variable                           |                                            | What it is                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUNQ_API_KEY`                     | **secret, required**                       | Your bunq API key: in the bunq app, Profile → Security & Settings → Developers → API keys → Add API key. One service per bunq user: a personal key and a business key are two services.                                                                                      |
| `MCP_AUTH_TOKEN`                   | **secret**, required by the PCP definition | When set, every MCP request must send `Authorization: Bearer <token>`. PCP sends it for you (`registers.auth`). Use a long random value; at least 16 characters.                                                                                                             |
| `BUNQ_DRAFT_MAX_AMOUNT`            | plain, optional                            | The largest draft, in EUR (`500`, `250.00`). Empty: no cap.                                                                                                                                                                                                                  |
| `BUNQ_PERMITTED_IPS`               | plain, optional                            | `permitted_ips` for the device registration. Empty: bunq ties the key to the address it is first used from. For a key that allows all addresses (a home connection whose address changes), your current address and `*`: `192.0.2.1,*`. A change registers the device again. |
| `BUNQ_ENVIRONMENT`                 | plain, optional                            | `production` (default) or `sandbox` (bunq's sandbox, with a sandbox key).                                                                                                                                                                                                    |
| `MCP_ALLOWED_HOSTS`                | plain, optional                            | `Host` values accepted besides loopback, comma separated (`192.0.2.10:8080`, `host:*`, `*`): the address you publish on, if it is not 127.0.0.1.                                                                                                                             |
| `MCP_PORT`, `MCP_HOST`, `MCP_PATH` |                                            | Where it listens: `8080`, `0.0.0.0` (inside the container), `/mcp`.                                                                                                                                                                                                          |
| `BUNQ_DATA_DIR`                    |                                            | Its data folder: `/data`, a named volume.                                                                                                                                                                                                                                    |

A bad value stops the service at start with a line that names the
variable, never its value.

## Where it connects

**Only to `api.bunq.com`** (or `public-api.sandbox.bunq.com` with
`BUNQ_ENVIRONMENT=sandbox`), on port 443. No telemetry, no update check, no
other host, no DNS but the name lookup for that host.

That is enforced by the code, not by PCP (a PCP service has no network
setting): `src/egress.ts` is the only module that opens a connection. It
fixes the host when the transport is made; a request carries only a path,
checked against `/v1/…`, never a URL; redirects are not followed; no proxy
variable is read (its own `https.Agent`); answers are capped at 8 MiB.
ESLint forbids `node:https`, `node:net`, `node:tls`, `node:http` (outside
the server module) and `fetch` everywhere else, and `test/egress.test.ts`
checks the sources for the same. Neither runtime dependency is used to
make a request: the MCP SDK only serves, zod only checks.

To check it on your server, watch the container's connections for a while
(for example `conntrack -L | grep <container IP>` or `tcpdump -n -i
docker0 host <container IP>`): you should see DNS for the one name and
HTTPS to bunq's addresses, and nothing else.

## What it keeps

In `/data` (mode 0700, files 0600, its own user):

- `client-key.pem`: an RSA key pair (2048 bits) made on first start. Its
  public half is registered with bunq as the installation's key.
- `context.json`: the installation token and bunq's public key, the
  device's id and a hash of the API key and permitted addresses it was
  registered with, and the current session (token, user id, when it was
  made, how long bunq keeps it). Never the API key itself.

The first tool call installs, registers the device and starts a session;
later starts reuse all three. The session is made again before your
auto-logout time runs out (bunq's `session_timeout`, a week by default),
and at once when bunq answers 401 to a request, which is then sent once
more; calls at the same time share one renewal. A new API key or new
permitted addresses register a new device on the same installation. If bunq
refuses a new session on a context from an earlier start (a device removed
in the app, a key tied to an address the machine no longer has), the
context is made again from the installation on, once per run. A failed
start is not retried for a minute, then longer each time, up to an hour:
bunq allows as few as ten installations a day.

At most three reads and five writes go to bunq in any three seconds, and a
429 is retried twice after a pause.

To start over (a new key pair and installation), remove the volume.

## Logs

One JSON line per event on standard error: the event, and for a request to
bunq its method, path (ids only), status and time. Never a body, a header,
a token, the key, an IBAN, a name or a description: the logger takes picked
fields only and masks IBANs, tokens and keys in every one of them
(`src/log.ts`; `test/logging.test.ts` runs every tool and checks). The MCP
side logs nothing per request.

## With PCP

PCP runs it as a service on one of your SSH servers, with the Docker or
Podman there, and adds it as an MCP server. The definition, in the
[pcp-gg-common](https://github.com/kaperkunde/pcp-gg-common) format
(`pcp_format` 4, since PCP sends `MCP_AUTH_TOKEN` as a header), is
[docs/pcp-service.yaml](docs/pcp-service.yaml):

```yaml
pcp_format: 4
version: 1
name: bunq
image: ghcr.io/kaperkunde/bunq-mcp@sha256:<digest from the image workflow>
source: ghcr.io/kaperkunde/bunq-mcp:latest
ports:
  - container: 8080
env:
  - name: BUNQ_API_KEY
    required: true
  - name: MCP_AUTH_TOKEN
    required: true
  - name: BUNQ_DRAFT_MAX_AMOUNT
    plain: true
  - name: BUNQ_PERMITTED_IPS
    plain: true
  - name: MCP_ALLOWED_HOSTS
    plain: true
volumes:
  - name: data
    path: /data
health:
  kind: http
  port: 8080
  path: /health
registers:
  kind: mcp
  port: 8080
  path: /mcp
  auth:
    env: MCP_AUTH_TOKEN
    header: Authorization
    template: Bearer {{secret}}
```

(Descriptions left out here; the file has them.) PCP publishes the port on
the SSH server's 127.0.0.1 and reaches it through the SSH connection.

The levels to propose with it (`tool_access` on `register_server`): reads
allowed, the draft asks you each time.

```json
[
  { "tools": ["get_*", "list_*"], "access": "allowed", "tier": "read" },
  { "tools": ["create_draft_payment"], "access": "ask", "tier": "write" }
]
```

## Running it yourself

```sh
docker run -d --name bunq-mcp -p 127.0.0.1:8080:8080 \
  -v bunq-mcp-data:/data \
  -e BUNQ_API_KEY -e MCP_AUTH_TOKEN \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/kaperkunde/bunq-mcp@sha256:<digest>
```

`GET /health` answers `{"status":"ok"}`; `GET /` and every other path but
`/mcp` answer 404.

## The image

Built on GitHub's own runners by `.github/workflows/image.yml` for
linux/amd64 and linux/arm64, pushed to `ghcr.io/kaperkunde/bunq-mcp` (`main`
and `sha-<commit>` on every push to main; `<version>` and `latest` on a
`v*` tag), signed with cosign keyless and with GitHub's build provenance
attested beside it. Refer to it by the digest the run prints. Check it:

```sh
cosign verify ghcr.io/kaperkunde/bunq-mcp@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/kaperkunde/bunq-mcp/\.github/workflows/image\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/kaperkunde/bunq-mcp@sha256:<digest> --repo kaperkunde/bunq-mcp
```

Node 24 on Alpine, the base pinned by digest; production dependencies from
the lock file only; no npm, npx, corepack or yarn left in it; runs as uid
10001; writes only to `/data`, so it runs with a read-only root.

## Developing

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

The tests run against an in-process fake of bunq's API (`test/fake-bunq.ts`),
which checks what bunq checks (tokens, the API key, signatures) and records
every request: the bootstrap, session renewal after a 401 and before the
timeout, more than a week of auto-logouts unattended, the request
allow-list, IBAN checks, the cap, the own-account check, the HTTP side, the
logs, and the definition against the code. Nothing in the tests reaches a
network but the loopback MCP server.

## Licence

MIT, see [LICENSE](LICENSE). No code was copied from datadefend's or
Wilco Kruijer's MIT-licensed bunq-mcp; see the audit.
