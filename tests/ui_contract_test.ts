/**
 * Source contracts for the shipped dashboard.
 *
 * These are the claims a reviewer should be able to check without a browser:
 * no key field, no CDN, no forbidden tool, and every module the app imports
 * actually exists in the repo (a missing file is a 404 at runtime on an nsite,
 * where nobody is watching the console).
 *
 * Run: `deno test --allow-read tests/ui_contract_test.ts`.
 */
import { strict as assert } from "node:assert";
import {
  ANN_CLASS_TAG,
  ANN_D_SLUG,
  ANN_SERVER_KIND,
  DEFAULT_RELAYS,
  FORBIDDEN_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from "../lib/config.js";

const read = (p: string) => Deno.readTextFileSync(new URL(`../${p}`, import.meta.url));

const INDEX = read("index.html");
const APP = read("app.js");
const CSS = read("style.css");
const VENDOR_ENTRY = read("vendor/nostr-entry.js");

/** Relative ES module specifiers in a file. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
}

Deno.test("login is NIP-07 only: there is no key field anywhere", () => {
  assert.equal(INDEX.match(/<input/gi), null, "the document carries no input element at all");
  assert.equal(INDEX.match(/<form[^>]*>[\s\S]*?<input/gi), null);
  assert.equal(INDEX.match(/type\s*=\s*"password"/gi), null, "no password field");
  assert.equal(APP.match(/nsec1/g), null, "no nsec literal in the app");
  assert.equal(APP.match(/type="password"/g), null);
  // The only inputs the app creates are write-tool arguments.
  const inputs = [...APP.matchAll(/<input ([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of inputs) {
    assert.match(attrs, /data-arg=/, `unexpected input: ${attrs}`);
  }
  assert.match(INDEX, /NIP-07/);
  assert.match(INDEX, /private key never enters this page/);
});

Deno.test("the app tells the user to install a NIP-07 extension when there is none", () => {
  assert.match(APP, /No NIP-07 extension found/);
  assert.match(APP, /Alby, nos2x/);
});

Deno.test("no CDN and no network fetch: every dependency is vendored", () => {
  for (const [name, src] of [["index.html", INDEX], ["app.js", APP], ["style.css", CSS]] as const) {
    const external = [...src.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    // The only permitted absolute URLs are documentation links in comments.
    const offenders = external.filter((u) => !/^https:\/\/(www\.)?(github|docs?|spec|nostr|contextvm)/.test(u));
    assert.deepEqual(offenders, [], `${name} references an external URL: ${offenders.join(", ")}`);
  }
  assert.match(INDEX, /src="app\.js"/);
  assert.match(VENDOR_ENTRY, /nostr-tools\/pure/);
  assert.match(VENDOR_ENTRY, /nostr-tools\/pool/);
  assert.match(VENDOR_ENTRY, /nostr-tools\/nip44/);
});

Deno.test("every module the app imports exists in the repo", () => {
  const specs = [...importsOf(APP)];
  assert.ok(specs.length >= 6, "the app should import its lib modules");
  for (const spec of specs) {
    const path = new URL(`../${spec.replace(/^\.\//, "")}`, import.meta.url);
    assert.ok(Deno.statSync(path).isFile, `${spec} does not exist`);
  }
});

Deno.test("the tool catalog never contains a money or credential tool", () => {
  const names = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name);
  for (const forbidden of FORBIDDEN_TOOLS) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must never be callable from the dashboard`);
  }
  // And the router's own surface is what we render, read/write split intact.
  assert.deepEqual(WRITE_TOOLS.map((t) => t.name).sort(), [
    "config_set",
    "private_disable",
    "private_enable",
    "private_rename",
    "service_restart",
    "service_start",
    "service_stop",
  ]);
  for (const t of WRITE_TOOLS) assert.ok(t.args, `${t.name} must declare its arguments`);
  for (const t of READ_TOOLS) assert.equal(t.args, undefined, `${t.name} is a read tool and takes no arguments`);
});

Deno.test("write tools are confirm-gated through a real modal dialog", () => {
  assert.match(INDEX, /<dialog id="confirm-dialog">/);
  assert.match(INDEX, /id="confirm-tool"/);
  assert.match(INDEX, /id="confirm-args"/);
  assert.match(INDEX, /id="confirm-router"/);
  assert.match(APP, /dlg\.showModal\(\)/, "the gate must be modal, not a styled div");
  assert.match(APP, /returnValue === "send"/, "only an explicit Send confirms");
  // The write path cannot bypass the gate: runWrite awaits confirmWrite first.
  const idx = APP.indexOf("async function runWrite");
  assert.ok(idx > -1);
  const body = APP.slice(idx, idx + 900);
  assert.ok(body.indexOf("confirmWrite") < body.indexOf("state.cvm.call"), "confirm BEFORE sending");
});

Deno.test("the dashboard says 'no routers found' rather than inventing one", () => {
  assert.match(APP, /No routers found for this npub\./);
  assert.match(APP, /Unreachable: /);
  assert.match(APP, /Nothing is shown for this router because nothing was measured/);
});

Deno.test("discovery constants match the router's own announcements", () => {
  assert.equal(ANN_SERVER_KIND, 11316);
  assert.equal(ANN_D_SLUG, "tollgate-control-plane");
  assert.equal(ANN_CLASS_TAG, "cvm:service:tollgate-control-plane");
  assert.deepEqual(DEFAULT_RELAYS, [
    "wss://relay2.contextvm.org",
    "wss://relay.primal.net",
    "wss://nos.lol",
  ]);
  // relay.contextvm.org is unreachable (DNS/TLS timeout) — never ship it.
  assert.equal(DEFAULT_RELAYS.includes("wss://relay.contextvm.org"), false);
});

Deno.test("the gift-wrap subscription is broad and filtered client-side", () => {
  assert.match(APP, /new CvmClient\(/);
  const cvm = read("lib/cvm.js");
  assert.match(cvm, /kinds: \[GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND\], limit: 0/);
  assert.match(cvm, /pTag\[1\] !== this\.clientPubkey/);
  assert.match(read("lib/transport.js"), /Promise\.allSettled/, "one dead relay must not fail a publish");
});

Deno.test("reads are fanned out with allSettled so one dead tool cannot blank a router", () => {
  const idx = APP.indexOf("async function refreshRouter");
  assert.ok(idx > -1);
  assert.match(APP.slice(idx, idx + 700), /Promise\.allSettled\(/);
});

Deno.test("the page states that it shows real data only", () => {
  assert.match(INDEX, /Real data only/);
  assert.match(INDEX, /never\s+shows a plausible-looking value/);
});
