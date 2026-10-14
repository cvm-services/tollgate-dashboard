/**
 * The CVM client, exercised end to end without a relay.
 *
 * The stub transport IS the relay: it records what the client publishes and
 * lets the test deliver an inbound gift wrap. The ROUTER's half of every
 * exchange is built with `wrapForRecipient` — the same three-layer NIP-59
 * construction the client uses — so a stub that invented its own envelope
 * could not pass these tests.
 *
 * Run: `deno test --allow-read tests/cvm_test.ts` (also `npm test`).
 */
import { strict as assert } from "node:assert";
import { generateSecretKey, getPublicKey } from "../vendor/nostr.mjs";
import {
  CvmClient,
  CvmTimeoutError,
  CvmToolError,
  normalizeToolResult,
  unwrapGiftWrap,
  wrapForRecipient,
} from "../lib/cvm.js";
import { CALL_TIMEOUT_MS, EPHEMERAL_GIFT_WRAP_KIND, GIFT_WRAP_KIND, RUMOR_KIND } from "../lib/config.js";

/** A relay double: records publishes, delivers injected events. */
function stubTransport({ relays = 3 } = {}) {
  const sent = [];
  const subs = [];
  return {
    sent,
    subs,
    lastFilter: null,
    async publish(evt) {
      sent.push(evt);
      return relays;
    },
    subscribe(filter, handlers) {
      this.lastFilter = filter;
      const sub = {
        filter,
        handlers,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      subs.push(sub);
      return sub;
    },
    close() {
      for (const s of subs) s.closed = true;
    },
    /** Deliver an inbound gift wrap to every open subscription. */
    inject(evt) {
      let delivered = 0;
      for (const s of subs) {
        if (s.closed) continue;
        s.handlers.onevent(evt);
        delivered++;
      }
      return delivered;
    },
  };
}

function makePair({ relays = 3 } = {}) {
  const clientSk = generateSecretKey();
  const routerSk = generateSecretKey();
  const transport = stubTransport({ relays });
  const client = new CvmClient({ secretKey: clientSk, transport, timeoutMs: 300, jitterSeconds: 0 });
  return { client, transport, clientSk, routerSk, routerPk: getPublicKey(routerSk) };
}

/** Build the router's reply to a request gift wrap. */
function routerReply(requestEvent, routerSk, { result, error, omitETag = false } = {}) {
  const { rumor } = unwrapGiftWrap(requestEvent, routerSk);
  const rpc = JSON.parse(rumor.content);
  const payload = error
    ? { jsonrpc: "2.0", id: rpc.id, error }
    : { jsonrpc: "2.0", id: rpc.id, result };
  const { giftWrap } = wrapForRecipient({
    rumor: { kind: RUMOR_KIND, tags: [["p", rumor.pubkey]], content: JSON.stringify(payload) },
    recipientPubkey: rumor.pubkey,
    senderSecretKey: routerSk,
    extraTags: omitETag ? [] : [["e", requestEvent.id]],
  });
  return giftWrap;
}

Deno.test("subscription is BROAD: no #p filter, and both gift-wrap kinds", () => {
  const { client, transport } = makePair();
  client.start();
  assert.deepEqual(transport.lastFilter, { kinds: [GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND], limit: 0 });
  assert.equal(transport.lastFilter["#p"], undefined, "a #p filter silently returns nothing on some relays");
});

Deno.test("a tool call round-trips: request → router → response → result", async () => {
  const { client, transport, routerSk, routerPk } = makePair();
  client.start();

  const pending = client.call(routerPk, "wallet_balance", {});
  assert.equal(transport.sent.length, 1, "the request was published");
  const request = transport.sent[0];
  assert.equal(request.kind, GIFT_WRAP_KIND);
  assert.equal(request.tags[0][0], "p");
  assert.equal(request.tags[0][1], routerPk, "addressed to the router");

  // What the router sees after unwrapping with its own key.
  const { rumor } = unwrapGiftWrap(request, routerSk);
  assert.equal(rumor.kind, RUMOR_KIND);
  const rpc = JSON.parse(rumor.content);
  assert.equal(rpc.method, "tools/call");
  assert.deepEqual(rpc.params, { name: "wallet_balance", arguments: {} });

  transport.inject(routerReply(request, routerSk, { result: { success: true, data: { balance: 4242 }, message: "ok" } }));
  const out = await pending;
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, { balance: 4242 });
  assert.equal(out.message, "ok");
});

Deno.test("the client-side p filter drops an event addressed to someone else", () => {
  const { client, routerSk } = makePair();
  client.start();
  const strangerPk = getPublicKey(generateSecretKey());

  const { giftWrap } = wrapForRecipient({
    rumor: { kind: RUMOR_KIND, tags: [["p", strangerPk]], content: "{}" },
    recipientPubkey: strangerPk,
    senderSecretKey: routerSk,
  });

  const res = client.handleEvent(giftWrap);
  assert.equal(res.accepted, false);
  assert.match(res.reason, /not addressed to this client/);
});

Deno.test("correlation falls back to the JSON-RPC id when the e tag is missing", async () => {
  const { client, transport, routerSk, routerPk } = makePair();
  client.start();
  const pending = client.call(routerPk, "status", {});
  transport.inject(routerReply(transport.sent[0], routerSk, { result: { success: true, data: { uptime: 12 } }, omitETag: true }));
  const out = await pending;
  assert.deepEqual(out.data, { uptime: 12 });
});

Deno.test("an unrelated response is not accepted", () => {
  const { client, transport, routerSk } = makePair();
  client.start();
  const clientPk = getPublicKey(client.secretKey);
  const { giftWrap } = wrapForRecipient({
    rumor: { kind: RUMOR_KIND, tags: [["p", clientPk]], content: JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) },
    recipientPubkey: clientPk,
    senderSecretKey: routerSk,
  });
  const res = client.handleEvent(giftWrap);
  assert.equal(res.accepted, false);
  assert.match(res.reason, /no pending call matches/);
  assert.equal(transport.sent.length, 0);
});

Deno.test("a router that never answers fails with a timeout, not a value", async () => {
  const { client, transport, routerPk } = makePair();
  client.start();
  const pending = client.call(routerPk, "status", {});
  assert.equal(transport.sent.length, 1);
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof CvmTimeoutError, `expected CvmTimeoutError, got ${err}`);
    assert.match(err.message, /no response from the router/);
    assert.equal(err.toolName, "status");
    return true;
  });
});

Deno.test("a JSON-RPC error surfaces as CvmToolError with the router's message", async () => {
  const { client, transport, routerSk, routerPk } = makePair();
  client.start();
  const pending = client.call(routerPk, "service_stop", {});
  transport.inject(
    routerReply(transport.sent[0], routerSk, {
      error: { code: -32000, message: 'tool "service_stop" is maintainer-only' },
    }),
  );
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof CvmToolError);
    assert.equal(err.code, -32000);
    assert.match(err.message, /maintainer-only/);
    return true;
  });
});

Deno.test("no relay accepting the request fails immediately with the real reason", async () => {
  const { client, transport, routerPk } = makePair({ relays: 0 });
  client.start();
  await assert.rejects(client.call(routerPk, "status", {}), (err) => {
    assert.ok(err instanceof CvmToolError);
    assert.match(err.message, /no relay accepted the request/);
    return true;
  });
  assert.equal(transport.sent.length, 1, "the request was still attempted");
});

Deno.test("close() fails in-flight calls instead of leaving them hanging", async () => {
  const { client, routerPk } = makePair();
  client.start();
  const pending = client.call(routerPk, "status", {});
  client.close();
  await assert.rejects(pending, /client closed/);
});

Deno.test("normalizeToolResult accepts both the CLIResponse and the MCP content[] shapes", () => {
  assert.deepEqual(normalizeToolResult({ success: false, error: "nope" }), {
    ok: false,
    data: null,
    message: "",
    error: "nope",
    progress: null,
    timestamp: null,
  });
  const mcp = normalizeToolResult({ content: [{ type: "text", text: '{"success":true,"data":{"ssid":"TollGate"}}' }] });
  assert.equal(mcp.ok, true);
  assert.deepEqual(mcp.data, { ssid: "TollGate" });
  const plain = normalizeToolResult({ anything: 1 });
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.data, { anything: 1 });
});

Deno.test("the default per-call budget is 30s", () => {
  assert.equal(CALL_TIMEOUT_MS, 30_000);
});
