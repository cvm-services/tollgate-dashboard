// The ContextVM client: JSON-RPC 2.0 inside a kind-25910 rumor, inside a
// NIP-59 seal (kind 13), inside a NIP-59 gift wrap (kind 1059).
//
// This is the FULL three-layer NIP-59 construction, not the two-layer
// simplification that some browser examples use. The router runs go-nostr's
// `nip59.GiftUnwrap`, which requires the seal: without it, unwrapping fails and
// the router drops the request silently. The layers, exactly as go-nostr builds
// them (verified against go-nostr v0.51.12 nip59.go):
//
//   rumor  kind 25910, tags [["p", router]], content = JSON-RPC 2.0
//   seal   kind 13,    tags [],  content = nip44(rumor JSON) to the router,
//          signed by the SENDER's real key (this is what the router authorizes)
//   wrap   kind 1059,  tags [["p", router], ...extra], content = nip44(seal
//          JSON) to the router, signed by a fresh throwaway nonce key
//
// Responses come back the same way with the roles swapped, plus an extra
// ["e", <request-gift-wrap-id>] tag on the OUTER wrap for correlation.

import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent } from "../vendor/nostr.mjs";
import {
  CALL_TIMEOUT_MS,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
  RUMOR_KIND,
} from "./config.js";

/** A JSON-RPC error from the router (unknown tool, refusal, bad params…). */
export class CvmToolError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code) {
    super(message);
    this.name = "CvmToolError";
    this.code = code;
  }
}

/**
 * No response inside the budget. This is the honest "unreachable" signal: the
 * dashboard must render it as an error for THAT router, never as a plausible
 * value. It is a distinct class so the UI can say "no answer in 30s" rather
 * than "the router said no".
 */
export class CvmTimeoutError extends Error {
  /** @param {string} toolName @param {number} timeoutMs */
  constructor(toolName, timeoutMs) {
    super(`no response from the router within ${Math.round(timeoutMs / 1000)}s (${toolName})`);
    this.name = "CvmTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** nip44 conversation key between our secret and their public key. */
function conversationKey(secretKey, pubkey) {
  return nip44.v2.utils.getConversationKey(secretKey, pubkey);
}

/**
 * Build a rumor + seal + gift wrap addressed to `recipientPubkey`, signed by
 * `senderSecretKey`. Exported because the test suite uses it to synthesise the
 * router's half of the conversation with the exact same wire format — a stub
 * that invented its own envelope would test nothing.
 *
 * @param {{rumor: any, recipientPubkey: string, senderSecretKey: Uint8Array,
 *          extraTags?: string[][], now?: () => number, jitterSeconds?: number,
 *          random?: () => number, nonceSecretKey?: Uint8Array}} opts
 */
export function wrapForRecipient({
  rumor,
  recipientPubkey,
  senderSecretKey,
  extraTags = [],
  now = nowSeconds,
  jitterSeconds = 0,
  random = Math.random,
  nonceSecretKey,
}) {
  const created = now();
  const senderPubkey = getPublicKey(senderSecretKey);

  // The rumor is NOT signed (NIP-59): it carries the sender's pubkey so the
  // recipient can attribute it after unwrapping the seal.
  const rumorEvent = finalizeEvent(
    {
      pubkey: senderPubkey,
      kind: rumor.kind ?? RUMOR_KIND,
      created_at: rumor.created_at ?? created,
      tags: rumor.tags ?? [["p", recipientPubkey]],
      content: rumor.content,
    },
    senderSecretKey,
  );

  const jitter = () => (jitterSeconds > 0 ? Math.floor(random() * jitterSeconds) : 0);

  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: created - jitter(),
      tags: [],
      content: nip44.v2.encrypt(JSON.stringify(rumorEvent), conversationKey(senderSecretKey, recipientPubkey)),
    },
    senderSecretKey,
  );

  const nonceSk = nonceSecretKey ?? generateSecretKey();
  const giftWrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: created - jitter(),
      // Extra tags (the response's ["e", request-id]) MUST be present before
      // signing: a tag appended after signing invalidates the signature and
      // relays drop the event without telling anyone.
      tags: [["p", recipientPubkey], ...extraTags],
      content: nip44.v2.encrypt(JSON.stringify(seal), conversationKey(nonceSk, recipientPubkey)),
      pubkey: getPublicKey(nonceSk),
    },
    nonceSk,
  );

  return { rumor: rumorEvent, seal, giftWrap };
}

/**
 * Open a gift wrap addressed to us: unwrap the nonce layer, verify the seal's
 * signature, unwrap the rumor.
 *
 * Throws on anything that is not a well-formed, correctly-signed envelope
 * addressed to our key. Callers treat a throw as "not our traffic".
 *
 * @param {any} giftWrapEvent
 * @param {Uint8Array} secretKey
 * @returns {{rumor: any, seal: any}}
 */
export function unwrapGiftWrap(giftWrapEvent, secretKey) {
  const sealJson = nip44.v2.decrypt(
    giftWrapEvent.content,
    conversationKey(secretKey, giftWrapEvent.pubkey),
  );
  const seal = JSON.parse(sealJson);
  if (!verifyEvent(seal)) throw new Error("seal signature is invalid");

  const rumorJson = nip44.v2.decrypt(seal.content, conversationKey(secretKey, seal.pubkey));
  const rumor = JSON.parse(rumorJson);
  // NIP-59: the rumor carries no signature of its own; its author is the seal's.
  rumor.pubkey = seal.pubkey;
  return { rumor, seal };
}

/**
 * Normalise a JSON-RPC result into `{ok, data, message, error}`.
 *
 * The router answers `tools/call` with a marshalled CLIResponse
 * (`{success, message, data, error, progress, timestamp}`). MCP-flavoured
 * servers answer with `{content: [{type:"text", text:"<json>"}]}` instead, so
 * both shapes are accepted rather than guessing which server we are talking to.
 *
 * @param {any} result
 */
export function normalizeToolResult(result) {
  let value = result;
  if (value && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        try {
          value = JSON.parse(item.text);
          break;
        } catch {
          value = { success: true, message: item.text };
          break;
        }
      }
    }
  }
  if (value && typeof value === "object" && typeof value.success === "boolean") {
    return {
      ok: value.success,
      data: value.data ?? null,
      message: value.message ?? "",
      error: value.error ?? (value.success ? "" : "the router reported a failure with no message"),
      progress: value.progress ?? null,
      timestamp: value.timestamp ?? null,
    };
  }
  return { ok: true, data: value ?? null, message: "", error: "" };
}

/**
 * The CVM client. One instance per signed-in maintainer; it holds the derived
 * client secret key in memory only.
 */
export class CvmClient {
  /**
   * @param {{secretKey: Uint8Array, transport: any, timeoutMs?: number,
   *          now?: () => number, random?: () => number, jitterSeconds?: number}} opts
   */
  constructor({ secretKey, transport, timeoutMs = CALL_TIMEOUT_MS, now = nowSeconds, random = Math.random, jitterSeconds = 21_600 }) {
    this.secretKey = secretKey;
    this.clientPubkey = getPublicKey(secretKey);
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.random = random;
    this.jitterSeconds = jitterSeconds;

    /** gift-wrap id -> pending call */
    this.pending = new Map();
    /** json-rpc id -> pending call (fallback correlation) */
    this.byRpcId = new Map();
    this.nextId = 1;
    this.sub = null;
    this.started = false;
    /** Every gift wrap the client has published, for debugging/telemetry. */
    this.published = [];
  }

  /**
   * Start listening for responses.
   *
   * The subscription is deliberately BROAD. `#p` tag filtering does NOT work
   * for kind 1059 on some relays (a NIP-12 relay gap, measured — the event is
   * on the relay and a `#p` REQ returns nothing), so a `#p`-filtered
   * subscription silently receives zero responses while looking perfectly
   * healthy. The p-tag check therefore happens here, client-side, before any
   * key material is touched.
   */
  start() {
    if (this.started) return this;
    this.started = true;
    this.sub = this.transport.subscribe(
      { kinds: [GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND], limit: 0 },
      { onevent: (evt) => this.handleEvent(evt) },
    );
    return this;
  }

  /**
   * Handle one incoming gift wrap.
   *
   * @param {any} evt
   * @returns {{accepted: boolean, reason: string}}
   */
  handleEvent(evt) {
    // Client-side p filter. Everything before this line is cheap; everything
    // after it assumes the event really is addressed to us.
    const pTag = evt?.tags?.find((t) => t?.[0] === "p");
    if (!pTag || pTag[1] !== this.clientPubkey) {
      return { accepted: false, reason: "not addressed to this client" };
    }
    if (evt.kind !== GIFT_WRAP_KIND && evt.kind !== EPHEMERAL_GIFT_WRAP_KIND) {
      return { accepted: false, reason: "not a gift wrap" };
    }

    let rumor;
    try {
      ({ rumor } = unwrapGiftWrap(evt, this.secretKey));
    } catch (err) {
      return { accepted: false, reason: `could not unwrap: ${err.message}` };
    }
    if (rumor.kind !== RUMOR_KIND) {
      return { accepted: false, reason: `rumor kind ${rumor.kind}, want ${RUMOR_KIND}` };
    }

    let response;
    try {
      response = JSON.parse(rumor.content);
    } catch {
      return { accepted: false, reason: "rumor content is not JSON" };
    }

    // Correlation, in order of trust:
    //   1. the ["e", <request gift-wrap id>] tag the router puts on the wrap
    //   2. the JSON-RPC id, as a fallback
    const eTag = evt.tags?.find((t) => t?.[0] === "e")?.[1];
    let entry = eTag ? this.pending.get(eTag) : undefined;
    if (!entry && response?.id !== undefined) {
      entry = this.byRpcId.get(response.id) ?? this.byRpcId.get(String(response.id));
    }
    if (!entry) {
      return { accepted: false, reason: "no pending call matches this response" };
    }

    this.settle(entry, response);
    return { accepted: true, reason: "correlated" };
  }

  /** @param {any} entry @param {any} response */
  settle(entry, response) {
    clearTimeout(entry.timer);
    this.pending.delete(entry.giftWrapId);
    this.byRpcId.delete(entry.rpcId);
    if (response.error) {
      entry.reject(new CvmToolError(response.error.message ?? "unknown router error", response.error.code));
      return;
    }
    entry.resolve(normalizeToolResult(response.result));
  }

  /**
   * Call one tool on one router.
   *
   * @param {string} routerPubkey router's hex pubkey (the announcement author)
   * @param {string} toolName
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<{ok: boolean, data: any, message: string, error: string}>}
   */
  async call(routerPubkey, toolName, args = {}) {
    if (!this.started) this.start();
    const rpcId = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: rpcId,
    };

    const { giftWrap } = wrapForRecipient({
      rumor: {
        kind: RUMOR_KIND,
        tags: [["p", routerPubkey]],
        content: JSON.stringify(request),
      },
      recipientPubkey: routerPubkey,
      senderSecretKey: this.secretKey,
      now: this.now,
      jitterSeconds: this.jitterSeconds,
      random: this.random,
    });

    const promise = new Promise((resolve, reject) => {
      const entry = { rpcId, giftWrapId: giftWrap.id, toolName, routerPubkey, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(giftWrap.id);
        this.byRpcId.delete(rpcId);
        reject(new CvmTimeoutError(toolName, this.timeoutMs));
      }, this.timeoutMs);
      // Register under BOTH keys before publishing: a fast router can answer
      // before `publish` has even resolved.
      this.pending.set(giftWrap.id, entry);
      this.byRpcId.set(rpcId, entry);
    });

    this.published.push(giftWrap);
    const relays = await this.transport.publish(giftWrap);
    if (relays === 0) {
      // Nothing accepted the request, so nothing will answer it. Fail now with
      // the real reason instead of burning the 30s budget pretending to wait.
      const entry = this.pending.get(giftWrap.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(giftWrap.id);
        this.byRpcId.delete(rpcId);
        entry.reject(new CvmToolError(`no relay accepted the request for ${toolName}`, -32001));
      }
    }
    return promise;
  }

  /** Stop listening and fail every in-flight call. */
  close() {
    try {
      this.sub?.close?.();
    } catch {
      /* already closed */
    }
    this.started = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CvmToolError("client closed", -32002));
    }
    this.pending.clear();
    this.byRpcId.clear();
  }
}
