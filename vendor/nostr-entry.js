/**
 * Vendored Nostr entry point for the tollgate-dashboard nsite.
 *
 * This file exists so the browser bundle is REPRODUCIBLE from the repo: the
 * committed output `vendor/nostr.mjs` is built from this exact import list by
 * `scripts/vendor-nostr.sh`, so nobody has to guess which parts of nostr-tools
 * are in the blob or where it came from.
 *
 * The dashboard has no build step at runtime and no CDN at runtime. Only what
 * the dashboard genuinely uses is imported — four specifiers, no more:
 *
 *   - pure:   keys, event signing/verification (the CVM client keypair)
 *   - pool:   relay connections (SimplePool: discovery + gift-wrap traffic)
 *   - nip44:  v2 encrypt/decrypt of the CVM rumor (the only version we use)
 *   - nip19:  npub/nsec encode+decode, so the discovery `#p` query key can be
 *             taken from a NIP-07 extension that returns hex and still be
 *             rendered back to the maintainer as an npub.
 */
export { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
export { SimplePool } from "nostr-tools/pool";
export * as nip44 from "nostr-tools/nip44";
export * as nip19 from "nostr-tools/nip19";
