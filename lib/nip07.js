// NIP-07 signer — the ONLY way a maintainer's identity enters this dashboard.
//
// HARD RULE: the private key never enters the page. There is no "paste your
// nsec" field anywhere in this codebase and there must never be one: an nsec in
// a page is an nsec in the DOM, in devtools, in any injected script, in every
// screenshot, and in the browser's history of form values. This module wraps
// `window.nostr` and nothing else.
//
// The `win` parameter is the injection seam: every function takes the object
// that should hold `window.nostr`, defaulting to the real global. Tests pass a
// stub; production passes nothing.

/**
 * True when a NIP-07 provider is present.
 * @param {any} [win]
 */
export function hasNip07(win = globalThis) {
  return Boolean(win?.nostr?.signEvent && win?.nostr?.getPublicKey);
}

/** Raised when no provider is installed — the UI renders this as an
 * instruction, never as an empty dashboard that looks like "no routers". */
export class NoNip07Provider extends Error {
  constructor() {
    super("No NIP-07 provider on this device.");
    this.name = "NoNip07Provider";
  }
}

/**
 * Wrap `window.nostr` in the small signer interface the rest of the dashboard
 * uses. Deliberately does NOT expose the key: there is no field on the returned
 * object that can be read to recover a secret.
 *
 * @param {any} [win] the object holding `window.nostr` (injected in tests)
 */
export async function nip07Signer(win = globalThis) {
  const p = win?.nostr;
  if (!hasNip07(win)) throw new NoNip07Provider();

  const pubkey = await p.getPublicKey();
  if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey)) {
    // A provider that returns an npub (bech32) here is out of spec; refuse
    // rather than silently query with a key that can never match a `#p` tag.
    throw new Error("the NIP-07 provider returned a malformed pubkey (expected 64-char hex)");
  }

  return {
    pubkey,
    method: "nip07",
    /**
     * Sign a template. NIP-07 providers add pubkey/id/sig themselves, so the
     * template carries only the four signed fields.
     */
    async signEvent(tmpl) {
      const signed = await p.signEvent({
        kind: tmpl.kind,
        created_at: tmpl.created_at,
        tags: tmpl.tags ?? [],
        content: tmpl.content ?? "",
      });
      if (!signed?.sig || !signed?.id) {
        throw new Error("the NIP-07 provider returned an unsigned event");
      }
      return signed;
    },
  };
}
