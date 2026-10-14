# tollgate-dashboard

A static web page that shows a **TollGate maintainer every router they own, in
one place** — and lets them act on those routers without a shell.

It is an **nsite**: a plain static site published to Nostr (Blossom blobs + a
manifest event) and served by any nsite gateway. There is no backend, no
database, no API server, and nothing to keep running. The page talks to the
routers itself, from the browser, over Nostr relays, using **ContextVM**.

```
browser (this page)                    relays                    router
  │  kind 1059 gift wrap  ────────────→ wss://…  ──────────────→  tollgate-cvm
  │  (NIP-59, encrypted to router)                                  │ runs the
  │                                                                │ TollGate CLI
  │  ←──────────── kind 1059 gift wrap, p = me, e = my request ────┘
  │
  └─ discovery: the router's own kind-11316 announcement (CEP-6), #p = my npub
```

Nothing here is a registry. **The router is the source of truth**: the page
finds routers by asking relays for the announcements the routers published
themselves, and it shows a router's state only when that router actually
answered.

---

## The two hard rules

### 1. Login is NIP-07. The private key never enters the page.

There is **no field to paste an nsec**, and there never will be. The page calls
`window.nostr.getPublicKey()` and `window.nostr.signEvent()`; the key stays in
the extension (Alby, nos2x, …). If no provider is present, the page says so and
stops — it does not offer a workaround.

`lib/nip07.js` exposes exactly three things — `pubkey`, `signEvent`, `method` —
and a test asserts that surface, so no future refactor can quietly grow a
`getPrivateKey()`.

### 2. Real data only.

If a router does not answer, the page says **unreachable** and shows the error
for that router. It never substitutes a plausible-looking value. An empty fleet
says *"No routers found for this npub."* — it does not render demo rows. The
full JSON of every raw response is available per card under *raw responses*, so
what you see can always be traced to what the router actually said.

---

## The derived CVM client key (and why it is derived)

A ContextVM client needs **its own** keypair: the router encrypts its reply *to
the caller's pubkey*, so the caller must hold a secret key to decrypt it. The
maintainer's nsec is unavailable to the page — by design — so the page derives a
separate, dashboard-scoped key from a NIP-07 signature:

1. Ask the extension to sign a fixed message
   (`content: "tollgate-dashboard-cvm-client-v1"`, kind 22242,
   `created_at: 1735689600`, no tags — all constants, so the signature is over
   the same bytes every time).
2. `secretKey = SHA-256(domain_separator ‖ signature_bytes)` → 32 bytes, used
   directly as the CVM client secret key.
3. If that is not a valid secp256k1 scalar (≈ 2⁻¹²⁸ chance), re-hash with a
   counter appended until it is. A value that cannot be validated is never used.
4. Remember the derived key in `localStorage` under
   `tollgate-dashboard-cvm-client:v1:<maintainer-pubkey>`, so a reload is the
   same client identity without another signature prompt.
5. If signing fails (user cancelled, provider broken), fall back to a **random
   per-session key** and say so in the UI. Reads still work; the caller identity
   is simply not stable across reloads.

**Why the cache is not redundant.** BIP-340 signatures are *randomised*: the
same event signed twice by the same key yields different signature bytes (the
event *id* is deterministic; the signature is not). Every mainstream NIP-07
extension uses a randomised Schnorr implementation, so hashing the signature
alone would give the maintainer a **different client identity on every reload** —
exactly the failure the derivation exists to prevent. The cache is what makes
the identity stable, and `tests/identity_test.ts` measures both halves of this
claim rather than asserting it in prose. If a future signer is deterministic, the
cache is still correct — it just stops being load-bearing.

**Security properties of the derived key** (it is not the maintainer's key, and
it is not a wallet):

- It cannot sign as the maintainer, and the router's authoriser compares the
  caller's pubkey to `maintainer_npub`, so this key cannot perform maintainer-only
  writes.
- It cannot move funds: `drain`, `fund` and `ssl` are absent from this codebase
  by rule, and a test asserts they can never appear in the tool catalog.
- It is stored per-origin. **Reset client key** in the header forgets it; the
  next sign-in derives a fresh one.

---

## What the page can ask a router

Reads (open to any signed caller) — every one of these is fetched per router on
load and on refresh, with `Promise.allSettled` so one dead tool cannot blank a
card:

| tool | shown as |
|---|---|
| `status` | Status |
| `wallet_balance` | Wallet balance |
| `private_status` | Private network |
| `upstream_list` | Upstreams |
| `config_get` | Config |

Writes (**maintainer-only on the router**, and confirm-gated here): click
*Manage* on a card, then the tool. A modal shows the **tool name, the router and
the exact arguments**; nothing is sent until *Send*. *Cancel* sends nothing and
says so.

`config_set {key, value}` · `private_enable` · `private_disable` ·
`private_rename {ssid}` · `service_restart` · `service_stop` · `service_start`

Deliberately **absent**, forever: `drain`, `fund`, `ssl` — they hand out
spendable ecash or credentials, and this page must not be a path to either.

---

## Robustness patterns (all of these are load-bearing)

- **Broad subscribe, client-side `#p` filter.** `#p` filtering on kind 1059 does
  not work on some relays, so the client subscribes to
  `[{kinds: [1059, 21059], limit: 0}]` and drops anything whose `p` tag is not
  its own pubkey. A test asserts that an event addressed to someone else is
  ignored.
- **Full three-layer NIP-59.** Rumor (25910) → seal (kind 13, signed by the
  caller) → gift wrap (1059, signed by a throwaway key). The router unwraps with
  `go-nostr`'s `GiftUnwrap`, which expects all three layers; a two-layer
  construction would simply be dropped.
- **Correlation by the `e` tag.** The reply's gift wrap carries
  `["e", <id of my request gift wrap>]`; the JSON-RPC id is the fallback.
- **Per-call timeout** (default 30 s) with a visible failure — a timeout is
  rendered as an error, never as a blank or a zero.
- **Per-router state**: `live` · `stale` (no successful contact in 120 s) ·
  `unreachable` (every call timed out) · `error` (the router answered with an
  error). `unreachable` and `stale` get an explicit banner with the reason.
- **Fan-out with `Promise.allSettled`** for both the per-router tool calls and
  the multi-relay publish.

---

## Running it

Serve the repo root over HTTP (ES modules need a real MIME type — `file://` will
not work):

```bash
node e2e/server.mjs          # http://127.0.0.1:8099
```

Then open it with a NIP-07 extension installed, and sign in.

## Tests

```bash
deno test --allow-read --no-check tests/   # 46 tests: protocol, discovery, identity, UI contracts
npx playwright test                        # 9 browser tests: login, discovery, round trip, confirm gate, unreachable
```

Both suites are **hermetic — no relay, no network**. The Deno suite drives the
real client through a stub transport; the Playwright suite installs a `window.nostr`
double and a stub relay through the app's own test seam, and answers every gift
wrap the page publishes by unwrapping it with the router's key in Node. The relay
URLs the page is given are `wss://test.invalid`, so a stray real socket would be
visible.

`npm install` is needed for the Playwright suite only
(`@playwright/test`; browsers via `npx playwright install chromium`). The Deno
suite needs nothing but Deno.

## Deploying

```bash
scripts/build-dist.sh                 # stage index.html, app.js, style.css, lib/, vendor/
NSITE_NSEC_FILE=~/.hermes/state/tollgate-dashboard-nsec.key scripts/deploy-nsite.sh
```

One nsec **per nsite** — never reuse another site's identity. The deployed site
is reachable at `https://<npub>.nsite.lol/` (and `.nsite.run`, `.nwb.tf`,
`.nsite.cloud`). Nothing in `dist/` is generated at runtime, and nothing is
fetched from a CDN: `nostr-tools` is vendored (`vendor/nostr.mjs`, rebuilt with
`scripts/vendor-nostr.sh`) and a test asserts that no shipped file references an
external URL.

See `docs/architecture.md` for the module map, the wire format, and the known
cross-component gaps with the router side.

## Layout

```
index.html          the whole UI (one page)
app.js              state, rendering, event wiring, the confirm gate
style.css
lib/config.js       protocol constants + the tool catalog (read/write split)
lib/nip07.js        the only way identity enters the page
lib/clientkey.js    deterministic CVM client key derivation
lib/discovery.js    CEP-6 kind-11316 discovery, #p filter, dedupe
lib/cvm.js          NIP-59 gift-wrapped JSON-RPC client
lib/transport.js    relay I/O (SimplePool in production, a stub in tests)
vendor/nostr.mjs    vendored nostr-tools 2.23.3 bundle
tests/              Deno suites (protocol, discovery, identity, UI contracts)
e2e/                Playwright suite + the test-only static server
scripts/            vendor, build-dist, deploy-nsite
docs/architecture.md
```
