# Architecture

One static page, no backend. The browser is the whole client: it discovers the
maintainer's routers from Nostr, talks ContextVM to them over relays, and renders
only what came back.

## Module map

| module | responsibility | testable without a browser? |
|---|---|---|
| `lib/config.js` | protocol constants (kinds, tag names, relays, timeouts) and the tool catalog with the read/write split | yes — plain data |
| `lib/nip07.js` | wraps `window.nostr`; the only identity entry point | yes — the window is injected |
| `lib/clientkey.js` | deterministic CVM client key from a NIP-07 signature | yes — storage and signer injected |
| `lib/discovery.js` | CEP-6 announcements → router descriptors (`#p` filter, dedupe, filters to query) | yes — transport injected |
| `lib/cvm.js` | NIP-59 gift-wrapped JSON-RPC: build requests, unwrap replies, correlate, time out | yes — transport injected |
| `lib/transport.js` | relay I/O. `SimplePool` in production; the same interface in tests | — it *is* the seam |
| `app.js` | state, DOM rendering, the confirm gate, event wiring | via Playwright (real DOM) |

Every module that touches the outside world takes it as a parameter
(`signer`, `storage`, `transport`, `now`, `timeoutMs`). Nothing calls a global
relay, a global clock or `localStorage` directly except in the default arguments
at the composition root (`app.js`).

## Wire format

**Discovery (the router announces itself).** Kind `11316`, a *regular*
replaceable event, so `#p` filtering works on it:

```json
{
  "kind": 11316,
  "pubkey": "<router server pubkey>",
  "tags": [["d","tollgate-control-plane"],
           ["t","cvm:service:tollgate-control-plane"],
           ["p","<maintainer npub>"]],
  "content": "{\"name\":…,\"about\":…,\"caps\":[…],\"relays\":[…] }"
}
```

The page queries `[{kinds:[11316],"#p":[<hex>]}, {kinds:[11316],"#p":[<npub>]}]`.
Both spellings are queried because the router's `p` tag carries the maintainer's
**bech32** npub while the Nostr convention is hex; relays match tag values
literally, so querying both costs one extra filter and removes a whole class of
"my routers vanished" bug. `selectRouters` then re-checks the `p` tag in the
client and dedupes per `(kind, pubkey, d)`, newest `created_at` winning.

Kind `11317` (the tools list) is recognised but not required.

**Calls.** A JSON-RPC 2.0 message inside a kind-25910 rumor, inside a NIP-59
seal (kind 13, signed by the caller), inside a NIP-59 gift wrap (kind 1059,
signed by a throwaway key):

```
tools/call {name, arguments}
  → rumor   25910          (content = the JSON-RPC)
  → seal     13            (nip44 to the router; signed by the client key)
  → wrap   1059  tags: [["p", <router>]]
```

The router replies with the same three layers in reverse, addressed to the
caller, with one extra tag on the wrap:

```
wrap 1059  tags: [["p", <client>], ["e", <id of my request wrap>]]
```

The client subscribes **broadly** — `[{kinds:[1059,21059], limit:0}]` — because
`#p` filtering on 1059 is unreliable on some relays, and filters the `p` tag
itself. Correlation is by the `e` tag (falling back to the JSON-RPC id, in case
a future router omits it). Decryption is two nip44 layers, in order: outer wrap
with the wrap's ephemeral pubkey, then the seal with the router's pubkey. The
seal signature is verified, so a response that does not come from the router is
not treated as the router's answer.

`result` is the router's `CLIResponse` (`{success, message, data, error, …}`);
`normalizeToolResult` also accepts an MCP-style `content[]` array with JSON text
in it, so a protocol change on the router side degrades to "unreadable" rather
than "crash".

## State model

```
router = { pubkey, d, name, about, relays, announcedAt,
           panels: { <tool>: {ok, data, message, error, errorKind} },
           loading, lastContact }
```

`routerState(router, now)` derives the badge from `panels`, and only from
`panels`:

| state | condition |
|---|---|
| `loading` | a refresh is in flight and nothing has answered yet |
| `live` | at least one tool answered `ok` and contact was recent |
| `stale` | at least one tool answered `ok`, but not within 120 s |
| `unreachable` | every tool failed **and every failure was a timeout** |
| `error` | every tool failed, at least one with a router-reported error |

The distinction between `unreachable` and `error` matters: the first means "the
router is not talking to us", the second means "the router talked and refused".
Both render as text on the card; neither ever renders a value.

## The confirm gate

`runWrite()` **awaits** `confirmWrite()` before it can reach `state.cvm.call`.
The gate is a real `<dialog>` opened with `showModal()`, so the browser enforces
modality and a stray click behind it cannot send anything; it resolves `true`
only when the dialog closes with `returnValue === "send"`. The dialog shows the
router, the tool name and the exact JSON arguments. A source-level test asserts
the ordering inside `runWrite` (`confirmWrite` appears before the call), so the
gate cannot be bypassed by a refactor that keeps the dialog but forgets to wait
for it.

## Vendoring

`vendor/nostr.mjs` is `nostr-tools` 2.23.3 bundled with esbuild from
`vendor/nostr-entry.js` (pure, pool, nip44, nip19). It is committed, so the
published site is byte-reproducible from the repo and depends on no CDN.
`scripts/vendor-nostr.sh` rebuilds it; `vendor/VENDOR.md` records the version
and the regeneration command.

## Known cross-component gaps (router side)

These are honest limitations of the system as it stands, recorded here so nobody
discovers them by surprise. None of them are hidden by the UI.

1. **The `p` tag carries a bech32 npub, not hex.** `announce.go` writes
   `["p", maintainerNpub]` where `maintainer_npub` is a `npub1…` string. Relays
   index tag values literally, so this works, but every Nostr tool that assumes
   hex `p` tags will miss it. This page queries both spellings; the fix belongs
   on the router side (`nostr.HexPubKeyFromNpub` before tagging).

2. **Write authorisation compares hex to bech32.** The CVM authoriser compares
   the caller's **hex** pubkey against `maintainer_npub` (**bech32**), so a
   maintainer-signed write cannot currently match. The dashboard shows the
   router's refusal verbatim; it does not paper over it with a fake success.

3. **A derived client key cannot perform maintainer-only writes.** The caller
   identity is the seal's author, which for this page is the derived client key,
   never the maintainer's. Reads (open to any signed caller) work; writes will be
   refused until either the router authorises a client key explicitly, or the
   page signs the seal with the maintainer's key through NIP-07 (which requires
   the extension to support `nip44.decrypt` for the reply). The confirm gate and
   the write tools are implemented and tested regardless — the UI's job is to
   send exactly what the operator confirmed and report exactly what came back.

4. **`relay.contextvm.org` is not in the default relay list.** It has been
   unreachable (DNS/TLS) and its inclusion caused multi-second stalls on every
   subscribe. A test asserts it stays out.

## Test strategy

Two layers, both hermetic:

- **Deno** (`tests/*_test.ts`, 46 tests) — the protocol and the contracts. The
  real `CvmClient` is driven through a stub transport; replies are built with the
  same `wrapForRecipient` the router would use, so the client is exercised
  against the real wire format. Plus source-level contracts: no key field, no
  CDN, no forbidden tool, every imported module exists, and the confirm gate is
  ordered correctly.
- **Playwright** (`e2e/dashboard.spec.mjs`, 10 tests) — the DOM. A `window.nostr`
  double that really signs, a stub relay that hands every published gift wrap to
  Node, which unwraps it with the router's key and answers it. The app's real
  discovery, real p-tag filter, real NIP-59 client and real rendering are all in
  the loop. The relay URLs are `wss://test.invalid`.

The tests are the specification for the three rules that matter — no key in the
page, real data only, confirm before write — so a regression in any of them
fails a test rather than a review.
