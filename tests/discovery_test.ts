/**
 * Discovery: the router is the source of truth.
 *
 * These tests pin the properties that decide whether the dashboard shows a
 * maintainer's real fleet, an empty fleet, or someone else's router by mistake.
 *
 * Run: `deno test --allow-read tests/discovery_test.ts`.
 */
import { strict as assert } from "node:assert";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "../vendor/nostr.mjs";
import {
  announcementKey,
  collectRouters,
  discoveryFilters,
  isAddressedToMaintainer,
  isTollgateAnnouncement,
  parseAnnouncement,
  selectRouters,
  tagValues,
} from "../lib/discovery.js";
import { ANN_CLASS_TAG, ANN_D_SLUG, ANN_SERVER_KIND } from "../lib/config.js";

/** A kind-11316 announcement exactly as the router builds it (announce.go). */
function announcement({
  routerSk = generateSecretKey(),
  d = ANN_D_SLUG,
  t = ANN_CLASS_TAG,
  p = null,
  content = { name: "tollgate-control-plane", about: "…", caps: ["tools"] },
  created_at = 1_700_000_000,
} = {}) {
  const tags = [["d", d]];
  if (t) tags.push(["t", t]);
  if (p) tags.push(["p", p]);
  const evt = finalizeEvent(
    {
      kind: ANN_SERVER_KIND,
      created_at,
      tags,
      content: JSON.stringify(content),
    },
    routerSk,
  );
  return { evt, routerSk, routerPk: getPublicKey(routerSk) };
}

const maintainerSk = generateSecretKey();
const maintainerHex = getPublicKey(maintainerSk);
const maintainerNpub = nip19.npubEncode(maintainerHex);
const maintainer = { hex: maintainerHex, npub: maintainerNpub };

Deno.test("tagValues reads every value of a repeated tag", () => {
  const { evt } = announcement({ p: maintainerHex });
  assert.deepEqual(tagValues(evt, "p"), [maintainerHex]);
  assert.deepEqual(tagValues(evt, "d"), [ANN_D_SLUG]);
  assert.deepEqual(tagValues(evt, "nope"), []);
});

Deno.test("isTollgateAnnouncement accepts the router's own shape and nothing else", () => {
  assert.equal(isTollgateAnnouncement(announcement().evt), true);
  // Right slug, no class tag — still ours (the slug is authoritative).
  assert.equal(isTollgateAnnouncement(announcement({ t: null }).evt), true);
  // Our namespaced class tag is enough on its own: it is the precise identifier,
  // so a router that renames its `d` slug does not vanish from the fleet view.
  assert.equal(isTollgateAnnouncement(announcement({ d: "renamed-by-operator" }).evt), true);
  // Right kind, neither our slug nor our class tag — not ours.
  assert.equal(
    isTollgateAnnouncement(announcement({ d: "someone-elses-service", t: "cvm:service:other" }).evt),
    false,
  );
  // Wrong kind entirely.
  const other = announcement().evt;
  assert.equal(isTollgateAnnouncement({ ...other, kind: 11317 }), false);
});

Deno.test("the p tag is the discovery key, in either spelling", () => {
  assert.equal(isAddressedToMaintainer(announcement({ p: maintainerHex }).evt, maintainer), true);
  assert.equal(isAddressedToMaintainer(announcement({ p: maintainerNpub }).evt, maintainer), true);
  const stranger = getPublicKey(generateSecretKey());
  assert.equal(isAddressedToMaintainer(announcement({ p: stranger }).evt, maintainer), false);
  assert.equal(isAddressedToMaintainer(announcement({ p: null }).evt, maintainer), false);
});

Deno.test("selectRouters finds exactly the maintainer's routers", () => {
  const mineA = announcement({ p: maintainerHex });
  const mineB = announcement({ p: maintainerNpub });
  const stranger = announcement({ p: getPublicKey(generateSecretKey()) });
  const unclaimed = announcement({ p: null });

  const routers = selectRouters([mineA.evt, mineB.evt, stranger.evt, unclaimed.evt], maintainer);
  assert.equal(routers.length, 2, "only the two the maintainer owns");
  assert.deepEqual(
    routers.map((r) => r.pubkey).sort(),
    [mineA.routerPk, mineB.routerPk].sort(),
  );
});

Deno.test("a synthetic 11316 parses into the router descriptor the UI renders", () => {
  const { evt, routerPk } = announcement({
    p: maintainerHex,
    content: {
      name: "tollgate-control-plane",
      about: "Remote management of a TollGate router over ContextVM",
      caps: ["tools"],
      relays: ["wss://relay2.contextvm.org", "wss://relay.primal.net"],
    },
  });
  const router = parseAnnouncement(evt);
  assert.equal(router.pubkey, routerPk);
  assert.equal(router.d, ANN_D_SLUG);
  assert.equal(router.name, "tollgate-control-plane");
  assert.match(router.about, /Remote management/);
  assert.deepEqual(router.relays, ["wss://relay2.contextvm.org", "wss://relay.primal.net"]);
  assert.equal(router.announcedAt, 1_700_000_000);
});

Deno.test("a router that published no relay list yields null, not a guessed default", () => {
  const { evt } = announcement({ p: maintainerHex, content: { name: "tollgate-control-plane" } });
  assert.equal(parseAnnouncement(evt).relays, null);
});

Deno.test("replaceable semantics: the newest announcement per (kind, pubkey, d) wins", () => {
  const routerSk = generateSecretKey();
  const older = announcement({ routerSk, p: maintainerHex, created_at: 1_700_000_000, content: { name: "tollgate-control-plane", about: "old" } });
  const newer = announcement({ routerSk, p: maintainerHex, created_at: 1_700_009_999, content: { name: "tollgate-control-plane", about: "new" } });

  assert.equal(announcementKey(older.evt), announcementKey(newer.evt));
  const routers = selectRouters([older.evt, newer.evt], maintainer);
  assert.equal(routers.length, 1, "one router, not two");
  assert.match(routers[0].about, /new/);
  // Order must not matter.
  assert.match(selectRouters([newer.evt, older.evt], maintainer)[0].about, /new/);
});

Deno.test("two different routers of one maintainer are two routers", () => {
  const a = announcement({ p: maintainerHex });
  const b = announcement({ p: maintainerHex });
  assert.notEqual(announcementKey(a.evt), announcementKey(b.evt));
  assert.equal(selectRouters([a.evt, b.evt], maintainer).length, 2);
});

Deno.test("discoveryFilters queries both spellings of the maintainer key", () => {
  const filters = discoveryFilters(maintainer);
  assert.deepEqual(filters, [
    { kinds: [ANN_SERVER_KIND], "#p": [maintainerHex] },
    { kinds: [ANN_SERVER_KIND], "#p": [maintainerNpub] },
  ]);
});

/** A transport that replays a scripted event list then EOSEs (or not). */
function replayTransport(events, { eose = true } = {}) {
  return {
    filters: null,
    subscribe(filter, handlers) {
      this.filters = filter;
      for (const evt of events) handlers.onevent(evt);
      if (eose) handlers.oneose();
      return { close() {} };
    },
  };
}

Deno.test("collectRouters returns the fleet and the filters it used", async () => {
  const mine = announcement({ p: maintainerHex });
  const stranger = announcement({ p: getPublicKey(generateSecretKey()) });
  const t = replayTransport([mine.evt, stranger.evt]);
  const res = await collectRouters(t, maintainer, { timeoutMs: 500 });
  assert.equal(res.routers.length, 1);
  assert.equal(res.routers[0].pubkey, mine.routerPk);
  assert.equal(res.timedOut, false);
  assert.equal(res.filters.length, 2);
});

Deno.test("an empty fleet is an empty fleet — never a fabricated one", async () => {
  const t = replayTransport([]);
  const res = await collectRouters(t, maintainer, { timeoutMs: 500 });
  assert.deepEqual(res.routers, []);
  assert.equal(res.timedOut, false);
});

Deno.test("a relay that never EOSEs still yields what it delivered, flagged as timed out", async () => {
  const mine = announcement({ p: maintainerHex });
  const t = replayTransport([mine.evt], { eose: false });
  const res = await collectRouters(t, maintainer, { timeoutMs: 120 });
  assert.equal(res.timedOut, true);
  assert.equal(res.routers.length, 1, "delivered events are not thrown away on timeout");
});
