/**
 * Login and the derived CVM client identity.
 *
 * The properties that matter, and that a future refactor could quietly break:
 *   - no private key ever enters the page (there is no signer API that returns one)
 *   - the same maintainer gets the SAME CVM client identity across reloads
 *   - the derived key is not the maintainer's key, and is not computable from
 *     the maintainer's npub
 *
 * Run: `deno test --allow-read tests/identity_test.ts`.
 */
import { strict as assert } from "node:assert";
import { finalizeEvent, generateSecretKey, getPublicKey } from "../vendor/nostr.mjs";
import {
  CLIENT_KEY_STORAGE_PREFIX,
  bytesToHex,
  clientIdentity,
  hexToBytes,
  resetClientIdentity,
  secretKeyFromSignature,
} from "../lib/clientkey.js";
import { NoNip07Provider, hasNip07, nip07Signer } from "../lib/nip07.js";

/** @param {Record<string,string>} [init] */
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    size: () => m.size,
  };
}

/** A NIP-07 stub: signs with nostr-tools, exactly like a real extension. */
function stubProvider(sk) {
  return {
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (tmpl) => finalizeEvent({ ...tmpl }, sk),
  };
}

const SIG_A = "a".repeat(128);
const SIG_B = "b".repeat(128);

/** Storage that accepts writes and remembers nothing (private browsing). */
const noStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

Deno.test("secretKeyFromSignature is deterministic and 32 bytes", async () => {
  const a = await secretKeyFromSignature(SIG_A);
  const b = await secretKeyFromSignature(SIG_A);
  assert.equal(a.length, 32);
  assert.equal(bytesToHex(a), bytesToHex(b), "same signature → same key");
  const other = await secretKeyFromSignature(SIG_B);
  assert.notEqual(bytesToHex(a), bytesToHex(other), "different signature → different key");
});

Deno.test("the derived key is usable and is NOT the maintainer's key", async () => {
  const maintainerSk = generateSecretKey();
  const signer = await nip07Signer({ nostr: stubProvider(maintainerSk) });
  const identity = await clientIdentity(signer, { storage: memStorage() });
  assert.equal(identity.method, "deterministic");
  assert.notEqual(bytesToHex(identity.secretKey), bytesToHex(maintainerSk), "never the maintainer's key");
  assert.notEqual(identity.pubkey, signer.pubkey, "the CVM caller is not the maintainer");
  assert.equal(getPublicKey(identity.secretKey), identity.pubkey);
});

Deno.test("BIP-340 signing is randomised: the same signature request differs each time", async () => {
  // This is the measured fact the cache exists for. If a future nostr-tools
  // release makes signing deterministic, this test fails — and then the cache
  // can be reconsidered, with the reasoning in lib/clientkey.js updated.
  const sk = generateSecretKey();
  const tmpl = { kind: 22242, created_at: 1735689600, tags: [], content: "tollgate-dashboard-cvm-client-v1" };
  const first = finalizeEvent({ ...tmpl }, sk);
  const second = finalizeEvent({ ...tmpl }, sk);
  assert.equal(first.id, second.id, "the event id IS deterministic");
  assert.notEqual(first.sig, second.sig, "the signature is NOT deterministic");
});

Deno.test("the client identity is stable across reloads (same storage)", async () => {
  const sk = generateSecretKey();
  const storage = memStorage();

  const first = await clientIdentity(await nip07Signer({ nostr: stubProvider(sk) }), { storage });
  const second = await clientIdentity(await nip07Signer({ nostr: stubProvider(sk) }), { storage });

  assert.equal(first.method, "deterministic");
  assert.equal(second.method, "cached");
  assert.equal(first.pubkey, second.pubkey, "a reload must not look like a new caller");
  assert.equal(bytesToHex(first.secretKey), bytesToHex(second.secretKey));
});

Deno.test("without storage a randomised signer yields a different identity each time", async () => {
  const sk = generateSecretKey();
  const a = await clientIdentity(await nip07Signer({ nostr: stubProvider(sk) }), { storage: memStorage() });
  const b = await clientIdentity(await nip07Signer({ nostr: stubProvider(sk) }), { storage: noStorage });
  assert.notEqual(a.pubkey, b.pubkey);
});

Deno.test("a signer that refuses falls back to a random per-session key, and says so", async () => {
  const sk = generateSecretKey();
  const signer = await nip07Signer({ nostr: stubProvider(sk) });
  signer.signEvent = async () => {
    throw new Error("user rejected");
  };
  let reported = null;
  const identity = await clientIdentity(signer, { storage: memStorage(), onFallback: (e) => (reported = e) });
  assert.equal(identity.method, "ephemeral");
  assert.match(reported?.message ?? "", /user rejected/);
  // A random key each time — and never the maintainer's.
  const again = await clientIdentity(signer, { storage: memStorage() });
  assert.notEqual(identity.pubkey, again.pubkey);
  assert.notEqual(identity.pubkey, signer.pubkey);
});

Deno.test("resetClientIdentity forgets the key so the next sign-in derives a fresh one", async () => {
  const sk = generateSecretKey();
  const storage = memStorage();
  const signer = await nip07Signer({ nostr: stubProvider(sk) });
  const first = await clientIdentity(signer, { storage });
  assert.ok(storage.getItem(CLIENT_KEY_STORAGE_PREFIX + signer.pubkey), "the derived key was remembered");
  resetClientIdentity(signer, { storage });
  assert.equal(storage.getItem(CLIENT_KEY_STORAGE_PREFIX + signer.pubkey), null);
  const second = await clientIdentity(signer, { storage });
  assert.equal(second.method, "deterministic");
});

Deno.test("a cached value that is not a 32-byte hex key is ignored, not trusted", async () => {
  const sk = generateSecretKey();
  const signer = await nip07Signer({ nostr: stubProvider(sk) });
  const storage = memStorage({ [CLIENT_KEY_STORAGE_PREFIX + signer.pubkey]: "not-a-key" });
  const identity = await clientIdentity(signer, { storage });
  assert.equal(identity.method, "deterministic");
});

// ------------------------------------------------------------------- NIP-07

Deno.test("hasNip07 is false without a provider and true with one", () => {
  assert.equal(hasNip07({}), false);
  assert.equal(hasNip07({ nostr: { getPublicKey: async () => "x" } }), false, "signEvent is required too");
  assert.equal(hasNip07({ nostr: { getPublicKey: async () => "x", signEvent: async () => ({}) } }), true);
});

Deno.test("signing in without a provider raises NoNip07Provider", async () => {
  await assert.rejects(nip07Signer({}), (err) => err instanceof NoNip07Provider);
});

Deno.test("a provider returning a non-hex pubkey is refused", async () => {
  await assert.rejects(
    nip07Signer({ nostr: { getPublicKey: async () => "npub1nothex", signEvent: async () => ({}) } }),
    /malformed pubkey/,
  );
});

Deno.test("the signer exposes no way to read a private key", async () => {
  const sk = generateSecretKey();
  const signer = await nip07Signer({ nostr: stubProvider(sk) });
  assert.deepEqual(Object.keys(signer).sort(), ["method", "pubkey", "signEvent"]);
  assert.equal(signer.pubkey, getPublicKey(sk));
  // And the signature it returns is the extension's, not a key.
  const signed = await signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "hi" });
  assert.equal(signed.sig.length, 128);
  assert.equal(hexToBytes(signed.sig).length, 64);
});
