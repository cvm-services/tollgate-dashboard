// The CVM client identity, derived from a NIP-07 signature.
//
// WHY A DERIVED KEY AT ALL
//
// A ContextVM client needs its own keypair: the router gift-wraps its response
// TO the caller's pubkey, so the client must hold the matching secret to decrypt
// it. The maintainer's nsec cannot be that key — it must never enter the page.
//
// So the dashboard asks the extension to sign ONE fixed message and hashes the
// signature into a 32-byte secret key. The signature is the secret input: it is
// never published, and it is not derivable from the maintainer's npub, so the
// client key is secret without the page ever seeing a private key.
//
// WHY THE DERIVED KEY IS ALSO CACHED
//
// BIP-340 Schnorr signing is randomised by default in the libraries every
// NIP-07 extension is built on (noble-secp256k1 signs with a random aux
// nonce), so the SAME signature request yields a DIFFERENT signature each time.
// Hashing it alone would therefore hand the router a brand-new caller on every
// reload — exactly the instability this design exists to remove.
//
// Measured, not assumed: two `finalizeEvent` calls with identical inputs on
// nostr-tools 2.23.3 produce the same `id` and different `sig`. The event `id`
// is deterministic, but it is a hash of public fields, so deriving from the id
// would make the client key computable by anyone who knows the maintainer's
// npub — and a client key that anyone can compute is a key that anyone can use
// to decrypt the maintainer's responses.
//
// The resolution is to derive from the signature (secret) and remember the
// result (stable). The cache is keyed by the maintainer's pubkey and holds a
// NON-CUSTODIAL, dashboard-scoped key: it cannot sign as the maintainer, it
// cannot move funds, and reads over CVM are open to any signed caller anyway.
// `resetClientIdentity` forgets it, and the next sign-in derives a fresh one.
//
// If signing fails entirely, the fallback is a random per-session key. It is
// reported as `ephemeral` so the UI can say so — never silently.

import { generateSecretKey, getPublicKey } from "../vendor/nostr.mjs";
import { CLIENT_KEY_MESSAGE } from "./config.js";

/**
 * The fixed `created_at` of the derivation event. Part of the signed bytes, so
 * changing it changes every user's derived key. 2025-01-01T00:00:00Z.
 */
export const CLIENT_KEY_CREATED_AT = 1735689600;

/** Kind for the derivation event. Signing-only: nothing is ever published. */
export const CLIENT_KEY_KIND = 22242;

/** localStorage key prefix. Versioned with CLIENT_KEY_MESSAGE. */
export const CLIENT_KEY_STORAGE_PREFIX = "tollgate-dashboard-cvm-client:v1:";

/** Domain separation for the hash, so this key can never collide with another
 * use of a signature in this estate. */
const DERIVATION_DOMAIN = "tollgate-dashboard-cvm-client-v1|sig|";

/** @param {string} hex @returns {Uint8Array} */
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hexToBytes: not a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 via WebCrypto. `subtle` is injectable so the pure tests can pass a
 * deterministic stand-in; production uses the browser's.
 *
 * @param {Uint8Array} bytes
 * @param {any} [subtle]
 * @returns {Promise<Uint8Array>}
 */
export async function sha256(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) {
    throw new Error("WebCrypto is unavailable — the dashboard needs a secure context (https)");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Turn a signature into a usable secp256k1 secret key.
 *
 * A hash output is almost always a valid scalar; "almost" is not a guarantee,
 * so the derivation is domain-separated and the (vanishingly rare) invalid
 * scalar is re-hashed with a counter suffix. The retry is deterministic.
 *
 * @param {string} sigHex 128-char hex signature
 * @param {any} [subtle]
 * @returns {Promise<Uint8Array>} 32-byte secret key
 */
export async function secretKeyFromSignature(sigHex, subtle) {
  const sigBytes = hexToBytes(sigHex);
  const domain = new TextEncoder().encode(DERIVATION_DOMAIN);
  for (let attempt = 0; attempt < 16; attempt++) {
    const material = attempt === 0
      ? concat(domain, sigBytes)
      : concat(concat(domain, sigBytes), new Uint8Array([attempt]));
    const candidate = await sha256(material, subtle);
    try {
      getPublicKey(candidate); // throws for zero / out-of-range scalars
      return candidate;
    } catch {
      /* deterministic retry */
    }
  }
  throw new Error("could not derive a valid CVM client key from the signature");
}

/** @param {any} storage */
function readCached(storage, storageKey) {
  try {
    const raw = storage?.getItem?.(storageKey);
    if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) return null;
    return hexToBytes(raw);
  } catch {
    return null;
  }
}

/**
 * The CVM client identity for a logged-in maintainer.
 *
 * @param {{pubkey: string, signEvent: (t: any) => Promise<any>}} signer
 * @param {{storage?: any, subtle?: any, onFallback?: (err: Error) => void}} [opts]
 * @returns {Promise<{secretKey: Uint8Array, pubkey: string, method: "cached"|"deterministic"|"ephemeral"}>}
 */
export async function clientIdentity(signer, { storage = globalThis.localStorage, subtle, onFallback } = {}) {
  if (typeof signer?.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(signer.pubkey)) {
    throw new Error("clientIdentity needs a signer with a 64-char hex pubkey");
  }
  const storageKey = CLIENT_KEY_STORAGE_PREFIX + signer.pubkey;

  // Prefer the remembered key: with a randomised signer this is the only thing
  // that keeps the client identity stable across reloads.
  const cached = readCached(storage, storageKey);
  if (cached) return { secretKey: cached, pubkey: getPublicKey(cached), method: "cached" };

  try {
    if (typeof signer.signEvent !== "function") throw new Error("signer cannot sign");
    const signed = await signer.signEvent({
      kind: CLIENT_KEY_KIND,
      created_at: CLIENT_KEY_CREATED_AT,
      tags: [],
      content: CLIENT_KEY_MESSAGE,
    });
    if (typeof signed?.sig !== "string" || signed.sig.length !== 128) {
      throw new Error("the signer returned a malformed signature");
    }
    const secretKey = await secretKeyFromSignature(signed.sig, subtle);
    try {
      storage?.setItem?.(storageKey, bytesToHex(secretKey));
    } catch {
      /* private-mode storage: the identity is then per-session, which the
         `method` field still reports honestly */
    }
    return { secretKey, pubkey: getPublicKey(secretKey), method: "deterministic" };
  } catch (err) {
    onFallback?.(err instanceof Error ? err : new Error(String(err)));
    const secretKey = generateSecretKey();
    return { secretKey, pubkey: getPublicKey(secretKey), method: "ephemeral" };
  }
}

/**
 * Forget the remembered client key for this maintainer. The next sign-in
 * derives a fresh one; the router simply sees a caller it has not seen before.
 * @param {{pubkey: string}} signer @param {{storage?: any}} [opts]
 */
export function resetClientIdentity(signer, { storage = globalThis.localStorage } = {}) {
  try {
    storage?.removeItem?.(CLIENT_KEY_STORAGE_PREFIX + signer.pubkey);
  } catch {
    /* nothing to forget */
  }
}
