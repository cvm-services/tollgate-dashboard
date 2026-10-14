// Browser tests for the TollGate maintainer dashboard.
//
// HERMETIC: no relay, no network, no real extension.
//   - `window.nostr` is a NIP-07 double whose signEvent really signs (with a
//     throwaway key generated per test) — a double that returned a fake
//     signature would test nothing, because the derived client key is a hash
//     of that signature.
//   - the relay is a stub transport installed through the app's own test seam
//     (`globalThis.__TOLLGATE_TEST__.transportFactory`); it hands every
//     published gift wrap to Node, which unwraps it with the router's key,
//     answers it, and injects the reply back into the page. So the app's real
//     NIP-59 client, its real p-tag filter and its real correlation logic are
//     all exercised.
//   - the relay URLs handed to the page are unroutable on purpose
//     (`wss://test.invalid`), so a stray real socket would be visible.
//
// Run: `npm run test:e2e` (starts e2e/server.mjs itself).

import { expect, test } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "../vendor/nostr.mjs";
import { wrapForRecipient, unwrapGiftWrap } from "../lib/cvm.js";
import { ANN_CLASS_TAG, ANN_D_SLUG, ANN_SERVER_KIND, RUMOR_KIND } from "../lib/config.js";

const hexOf = (bytes) => Buffer.from(bytes).toString("hex");

/** Test-only relay URLs: if the page ever dials one, that is a bug. */
const FAKE_RELAYS = ["wss://test.invalid"];

/** The router's answers for the read tools the dashboard calls. */
function defaultAnswer(name) {
  switch (name) {
    case "status":
      return { success: true, data: { running: true, uptime: 1234 }, message: "running" };
    case "wallet_balance":
      return { success: true, data: { balance: 4242 }, message: "ok" };
    case "private_status":
      return { success: true, data: { ssid: "TollGate-TEST", enabled: true }, message: "ok" };
    case "upstream_list":
      return { success: true, data: [], message: "ok" };
    case "config_get":
      return { success: true, data: { log_level: "info" }, message: "ok" };
    default:
      return { success: false, error: `unknown tool ${name}` };
  }
}

/** A kind-11316 announcement exactly as the router publishes it. */
function announcementEvent({ routerSk, maintainerHex, createdAt = Math.floor(Date.now() / 1000), about = "test router" }) {
  return finalizeEvent(
    {
      kind: ANN_SERVER_KIND,
      created_at: createdAt,
      tags: [["d", ANN_D_SLUG], ["t", ANN_CLASS_TAG], ["p", maintainerHex]],
      content: JSON.stringify({
        name: "tollgate-control-plane",
        about,
        caps: ["tools"],
        relays: ["wss://relay2.contextvm.org"],
      }),
    },
    routerSk,
  );
}

/**
 * Install the extension double + stub relay, and wire the Node-side responder.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{maintainerSk: Uint8Array, routers: Array<{sk: Uint8Array, answer: ((name: string, args: any) => any) | null}>,
 *          callTimeoutMs?: number, discoveryTimeoutMs?: number}} opts
 */
async function installHarness(page, { maintainerSk, routers, callTimeoutMs = 800, discoveryTimeoutMs = 1500 }) {
  const maintainerHex = getPublicKey(maintainerSk);

  // Node answers whatever the page published — this is the router.
  await page.exposeFunction("__respond", async (evt) => {
    for (const router of routers) {
      let rumor;
      try {
        ({ rumor } = unwrapGiftWrap(evt, router.sk));
      } catch {
        continue; // this gift wrap was not addressed to that router
      }
      if (!router.answer) return null; // a router that never answers
      const rpc = JSON.parse(rumor.content);
      const result = router.answer(rpc.params.name, rpc.params.arguments);
      if (result === null || result === undefined) return null;
      const { giftWrap } = wrapForRecipient({
        rumor: {
          kind: RUMOR_KIND,
          tags: [["p", rumor.pubkey]],
          content: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
        },
        recipientPubkey: rumor.pubkey,
        senderSecretKey: router.sk,
        extraTags: [["e", evt.id]],
      });
      return JSON.parse(JSON.stringify(giftWrap));
    }
    return null;
  });

  await page.addInitScript(
    ({ maintainerSkHex, relays, callTimeoutMs, discoveryTimeoutMs }) => {
      window.__stub = {
        sent: [],
        subs: [],
        inject(evt) {
          for (const s of this.subs) if (!s.closed) s.handlers.onevent(evt);
        },
        eose() {
          for (const s of this.subs) if (!s.closed) s.handlers.oneose?.();
        },
      };

      window.__TOLLGATE_TEST__ = {
        relays,
        callTimeoutMs,
        discoveryTimeoutMs,
        autoRefresh: false,
        transportFactory: () => ({
          publish: async (evt) => {
            const plain = JSON.parse(JSON.stringify(evt));
            window.__stub.sent.push(plain);
            const resp = await window.__respond(plain);
            if (resp) window.__stub.inject(resp);
            return 3;
          },
          subscribe: (filter, handlers) => {
            const sub = {
              filter,
              handlers,
              closed: false,
              close() {
                sub.closed = true;
              },
            };
            window.__stub.subs.push(sub);
            return sub;
          },
          close: () => {},
        }),
      };

      // The NIP-07 extension double. In production this object is the user's
      // extension and the key never leaves it; in the test the harness IS the
      // extension, which is why it holds the key.
      const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
      window.__ready = (async () => {
        const nostr = await import("/vendor/nostr.mjs");
        const sk = hexToBytes(maintainerSkHex);
        window.nostr = {
          getPublicKey: async () => nostr.getPublicKey(sk),
          signEvent: async (tmpl) => nostr.finalizeEvent({ ...tmpl }, sk),
        };
      })();
    },
    { maintainerSkHex: hexOf(maintainerSk), relays: FAKE_RELAYS, callTimeoutMs, discoveryTimeoutMs },
  );
}

/** Load the page, sign in, and hand back the maintainer's npub. */
async function signIn(page, maintainerSk) {
  await page.goto("/index.html");
  await page.waitForFunction(() => Boolean(window.nostr));
  await page.getByRole("button", { name: "Sign in with NIP-07" }).click();
  await expect(page.getByTestId("session-npub")).toBeVisible();
  return nip19.npubEncode(getPublicKey(maintainerSk));
}

/** Deliver announcements into the open discovery subscription, then EOSE. */
async function deliverDiscovery(page, events) {
  await page.waitForFunction(() => window.__stub.subs.length > 0);
  await page.evaluate((evts) => {
    for (const e of evts) window.__stub.inject(e);
    window.__stub.eose();
  }, events);
}

/** Every tool call the page published, decrypted with the router's key. */
async function publishedCalls(page, routerSk) {
  const sent = await page.evaluate(() => window.__stub.sent);
  const calls = [];
  for (const evt of sent) {
    try {
      const { rumor } = unwrapGiftWrap(evt, routerSk);
      calls.push(JSON.parse(rumor.content));
    } catch {
      /* not addressed to this router */
    }
  }
  return calls;
}

test("login is NIP-07: the session shows the maintainer's npub and the derived client key", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  await installHarness(page, { maintainerSk, routers: [] });
  const npub = await signIn(page, maintainerSk);

  await expect(page.getByTestId("session-npub")).toHaveText(npub);
  await expect(page.getByTestId("client-method")).toContainText("derived from your signature");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden();
  // The client pubkey shown is NOT the maintainer's pubkey.
  const body = await page.locator("#session").innerText();
  expect(body).not.toContain(getPublicKey(maintainerSk).slice(0, 20));
});

test("discovery renders a router card from a synthetic kind-11316 announcement", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const routerA = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  const routerB = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  await installHarness(page, { maintainerSk, routers: [routerA, routerB] });
  await signIn(page, maintainerSk);

  await deliverDiscovery(page, [
    announcementEvent({ routerSk: routerA.sk, maintainerHex, about: "kitchen router" }),
    announcementEvent({ routerSk: routerB.sk, maintainerHex, about: "garage router" }),
  ]);

  await expect(page.getByTestId("router-card")).toHaveCount(2);
  // The relays and the filters actually used are shown, not hidden.
  await expect(page.locator("#discovery-detail")).toContainText("wss://test.invalid");
  await expect(page.locator("#discovery-detail")).toContainText('"#p"');
  await expect(page.locator("#discovery-detail")).toContainText(maintainerHex);
});

test("an announcement addressed to a different maintainer is ignored", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const mine = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  const theirs = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  const strangerHex = getPublicKey(generateSecretKey());

  await installHarness(page, { maintainerSk, routers: [mine] });
  await signIn(page, maintainerSk);

  await deliverDiscovery(page, [
    announcementEvent({ routerSk: mine.sk, maintainerHex }),
    announcementEvent({ routerSk: theirs.sk, maintainerHex: strangerHex }),
  ]);

  await expect(page.getByTestId("router-card")).toHaveCount(1);
  const html = await page.locator("#routers").innerHTML();
  expect(html).not.toContain(nip19.npubEncode(getPublicKey(theirs.sk)));
  expect(html).not.toContain(getPublicKey(theirs.sk));
});

test("an empty fleet says so instead of showing a demo router", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  await installHarness(page, { maintainerSk, routers: [] });
  await signIn(page, maintainerSk);
  await deliverDiscovery(page, []);

  await expect(page.getByTestId("empty-state")).toHaveText("No routers found for this npub.");
  await expect(page.getByTestId("router-card")).toHaveCount(0);
});

test("a tool call round-trips: the real balance from the mocked gift-wrapped response is rendered", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const router = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  await installHarness(page, { maintainerSk, routers: [router] });
  await signIn(page, maintainerSk);
  await deliverDiscovery(page, [announcementEvent({ routerSk: router.sk, maintainerHex })]);

  const card = page.getByTestId("router-card").first();
  await expect(card.getByTestId("router-state")).toHaveText("live");
  await expect(card.locator('[data-tool="wallet_balance"]')).toHaveText("4242 sats");
  await expect(card.locator('[data-tool="private_status"]')).toContainText("TollGate-TEST");

  // The page really sent CVM requests, and they were the tools we expect.
  const calls = await publishedCalls(page, router.sk);
  const names = calls.map((c) => c.params.name);
  expect(names).toContain("wallet_balance");
  expect(names).toContain("status");
  expect(calls[0].method).toBe("tools/call");
});

test("a write action is confirm-gated: cancel sends nothing, send publishes the exact tool and arguments", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const router = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  await installHarness(page, { maintainerSk, routers: [router] });
  await signIn(page, maintainerSk);
  await deliverDiscovery(page, [announcementEvent({ routerSk: router.sk, maintainerHex })]);
  await expect(page.getByTestId("router-state").first()).toHaveText("live");

  await page.getByRole("button", { name: "Manage" }).first().click();
  await expect(page.locator("#actions-panel")).toBeVisible();

  const writesBefore = (await publishedCalls(page, router.sk)).filter((c) => c.params.name === "service_restart").length;

  // --- cancel: the dialog appears, shows the tool and args, and nothing is sent.
  await page.locator('[data-write="service_restart"]').click();
  const dialog = page.locator("#confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("confirm-tool")).toHaveText("service_restart");
  await expect(page.getByTestId("confirm-args")).toHaveText("{}");
  await expect(page.getByTestId("confirm-router")).toContainText(nip19.npubEncode(getPublicKey(router.sk)));
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#action-result")).toContainText("Cancelled");
  expect((await publishedCalls(page, router.sk)).filter((c) => c.params.name === "service_restart").length).toBe(writesBefore);

  // --- send: exactly one request, carrying the tool name.
  await page.locator('[data-write="service_restart"]').click();
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#action-result")).toContainText("service_restart");
  const after = (await publishedCalls(page, router.sk)).filter((c) => c.params.name === "service_restart");
  expect(after.length).toBe(writesBefore + 1);
});

test("a write action with arguments shows them in the confirmation and sends them", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const seen = [];
  const router = {
    sk: generateSecretKey(),
    answer: (name, args) => {
      if (name === "config_set") seen.push(args);
      return defaultAnswer(name);
    },
  };
  await installHarness(page, { maintainerSk, routers: [router] });
  await signIn(page, maintainerSk);
  await deliverDiscovery(page, [announcementEvent({ routerSk: router.sk, maintainerHex })]);
  await expect(page.getByTestId("router-state").first()).toHaveText("live");
  await page.getByRole("button", { name: "Manage" }).first().click();

  await page.locator('[data-write-group="config_set"] [data-arg="key"]').fill("maintainer_npub");
  await page.locator('[data-write-group="config_set"] [data-arg="value"]').fill("npub1example");
  await page.locator('[data-write="config_set"]').click();

  await expect(page.getByTestId("confirm-tool")).toHaveText("config_set");
  await expect(page.getByTestId("confirm-args")).toContainText("maintainer_npub");
  await expect(page.getByTestId("confirm-args")).toContainText("npub1example");

  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toEqual({ key: "maintainer_npub", value: "npub1example" });
});

test("an unreachable router renders as an error, never as a plausible value", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const live = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  const dead = { sk: generateSecretKey(), answer: null }; // never answers

  await installHarness(page, { maintainerSk, routers: [live, dead], callTimeoutMs: 600 });
  await signIn(page, maintainerSk);
  await deliverDiscovery(page, [
    announcementEvent({ routerSk: live.sk, maintainerHex, about: "responds" }),
    announcementEvent({ routerSk: dead.sk, maintainerHex, about: "dark" }),
  ]);

  await expect(page.getByTestId("router-card")).toHaveCount(2);

  const deadCard = page.locator(`article[data-router="${getPublicKey(dead.sk)}"]`);
  await expect(deadCard.getByTestId("router-state")).toHaveText("unreachable");
  await expect(deadCard.getByTestId("router-note")).toContainText("Unreachable:");
  await expect(deadCard.getByTestId("router-note")).toContainText("nothing was measured");

  // Every panel on the dead router shows the failure, and none of them shows a value.
  for (const tool of ["status", "wallet_balance", "private_status", "upstream_list", "config_get"]) {
    const cell = deadCard.locator(`[data-tool="${tool}"]`);
    await expect(cell).toContainText("error:");
  }
  expect(await deadCard.innerText()).not.toContain("4242");
  expect(await deadCard.innerText()).not.toContain("sats");

  // The live router is unaffected — one dead router does not blank the page.
  const liveCard = page.locator(`article[data-router="${getPublicKey(live.sk)}"]`);
  await expect(liveCard.getByTestId("router-state")).toHaveText("live");
  await expect(liveCard.locator('[data-tool="wallet_balance"]')).toHaveText("4242 sats");
});

test("the derived client identity is stable across a reload", async ({ page }) => {
  const maintainerSk = generateSecretKey();
  const maintainerHex = getPublicKey(maintainerSk);
  const router = { sk: generateSecretKey(), answer: (n) => defaultAnswer(n) };
  await installHarness(page, { maintainerSk, routers: [router] });
  await signIn(page, maintainerSk);

  const clientLine = () => page.locator("#session .pubkey").last().innerText();
  const first = await clientLine();

  // Reload: the app re-derives (or reuses) the client key without a fresh
  // signature being required, and the caller identity the router sees is the same.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.nostr));
  await page.getByRole("button", { name: "Sign in with NIP-07" }).click();
  await expect(page.getByTestId("session-npub")).toBeVisible();
  expect(await clientLine()).toBe(first);
  expect(maintainerHex.length).toBe(64);
});
