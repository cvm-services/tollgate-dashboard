# Vendored dependency — nostr-tools

**Package:** `nostr-tools` **2.23.3** (MIT)
**Entry:** `vendor/nostr-entry.js`
**Output:** `vendor/nostr.mjs` (committed; ~142 KB, self-contained ESM)
**Regenerate:** `NOSTR_TOOLS_ROOT=/path/to/node_modules bash scripts/vendor-nostr.sh`

## Why vendored

The dashboard is served as an **nsite** (static files over Blossom + relays).
It has **no build step at runtime and no CDN at runtime**: it must keep working
when a third-party CDN is unreachable, and the bytes that ship must be the bytes
in this repo. A `<script src="https://unpkg.com/...">` would make the dashboard
unusable exactly when a relay or CDN is having a bad day — which is when an
operator most needs to see their routers.

The exact import list is in `nostr-entry.js` — deliberately four specifiers so
nobody has to guess what is inside the blob:

- `nostr-tools/pure` — `finalizeEvent`, `generateSecretKey`, `getPublicKey`, `verifyEvent`
- `nostr-tools/pool` — `SimplePool` (relay connections)
- `nostr-tools/nip44` — `v2.encrypt` / `v2.decrypt` for the CVM rumor
- `nostr-tools/nip19` — `npubEncode` / `decode` for display + query keys

## Copy from

This bundle was produced from the `nostr-tools@2.23.3` already present in
`auditable-voting/web/node_modules` on the build host (same version pinned by
the cvm-registry order PWA), so the wire format matches the rest of the estate.
`vendor-nostr.sh` pins the version and refuses to build against a different one.

## sha256

```
66795fc72fbe167c56af73798e2a0a7ef8bc5912af6e8f35e9b61dacb9190347  vendor/nostr.mjs
```

## Licence

MIT; upstream licence headers are preserved in the bundle
(`--legal-comments=inline`).
