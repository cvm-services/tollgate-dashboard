// tollgate-dashboard — the maintainer's view of every TollGate they own.
//
// The rules this file exists to enforce:
//   1. LOGIN IS NIP-07. No key material enters the page; see lib/nip07.js.
//   2. REAL DATA ONLY. A router that does not answer gets an explicit error
//      state. There is no demo mode, no placeholder balance, no synthetic
//      router. An empty fleet says "no routers found for this npub".
//   3. WRITES ARE CONFIRM-GATED. Nothing state-changing is published until the
//      operator confirms the exact tool and arguments in a modal dialog.
//   4. ROBUSTNESS. Broad gift-wrap subscription + client-side p filter, a 30s
//      per-call budget with a visible failure, a stale/unreachable banner per
//      router, and Promise.allSettled when fanning out reads.
//
// Everything that can be tested without a browser lives in ./lib/; this file is
// the wiring and the DOM.

import { nip19 } from "./vendor/nostr.mjs";
import {
  CALL_TIMEOUT_MS,
  DEFAULT_RELAYS,
  DISCOVERY_TIMEOUT_MS,
  READ_TOOLS,
  WRITE_TOOLS,
} from "./lib/config.js";
import { clientIdentity, resetClientIdentity } from "./lib/clientkey.js";
import { collectRouters } from "./lib/discovery.js";
import { CvmClient, CvmTimeoutError, CvmToolError, unwrapGiftWrap, wrapForRecipient } from "./lib/cvm.js";
import { NoNip07Provider, hasNip07, nip07Signer } from "./lib/nip07.js";
import { createSimplePoolTransport } from "./lib/transport.js";

/** A router's reading goes stale after this long without a successful call. */
export const STALE_AFTER_MS = 120_000;

/** Reads the dashboard performs per router, fanned out with allSettled. */
export const READS_PER_ROUTER = ["status", "wallet_balance", "private_status", "upstream_list", "config_get"];

/** Injected in tests (Playwright / DOM-level): `globalThis.__TOLLGATE_TEST__`. */
function hooks() {
  return globalThis.__TOLLGATE_TEST__ ?? {};
}

const $ = (id) => globalThis.document?.getElementById(id) ?? null;

const state = {
  /** {hex, npub} — the maintainer's identity (from NIP-07). */
  maintainer: null,
  /** {pubkey, method} — the derived CVM client identity. */
  client: null,
  /** The CvmClient instance. */
  cvm: null,
  transport: null,
  relays: DEFAULT_RELAYS,
  routers: [],
  discovery: { status: "idle", error: null, timedOut: false, filters: [], at: null },
  selected: null,
  lastRefresh: null,
};

// ---------------------------------------------------------------- formatting

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** @param {string} hex */
export function toNpub(hex) {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

/** @param {string} npub @param {number} [keep] */
export function shorten(value, keep = 10) {
  const s = String(value ?? "");
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-4)}`;
}

/** @param {any} value */
export function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The one-line summary shown for a tool result. Deliberately conservative: a
 * known shape gets a friendly rendering, anything else is shown as the router
 * sent it. Nothing is ever inferred.
 *
 * @param {string} tool
 * @param {{ok: boolean, data: any, message: string}} result
 */
export function summarize(tool, result) {
  const { data, message } = result ?? {};
  if (tool === "wallet_balance") {
    if (data && typeof data === "object" && "balance" in data) return `${formatValue(data.balance)} sats`;
    if (typeof data === "number" || typeof data === "string") return `${formatValue(data)} sats`;
  }
  if (tool === "private_status" && data && typeof data === "object") {
    const bits = [];
    if ("ssid" in data) bits.push(`ssid ${formatValue(data.ssid)}`);
    if ("enabled" in data) bits.push(`enabled ${formatValue(data.enabled)}`);
    if (bits.length) return bits.join(" · ");
  }
  if (tool === "upstream_list" && Array.isArray(data)) return `${data.length} configured`;
  if (data === null || data === undefined) return message ? String(message) : "—";
  return formatValue(data);
}

/** The router's state, derived only from what actually came back. */
export function routerState(router, now = Date.now()) {
  const panels = Object.values(router?.panels ?? {});
  if (router?.loading) return "loading";
  if (panels.length === 0) return "loading";
  const ok = panels.filter((p) => p?.ok).length;
  if (ok > 0) {
    if (router.lastContact && now - router.lastContact > STALE_AFTER_MS) return "stale";
    return "live";
  }
  if (panels.every((p) => p?.errorKind === "timeout")) return "unreachable";
  return "error";
}

/** @param {string} state */
function badgeText(s) {
  switch (s) {
    case "live": return "live";
    case "stale": return "stale";
    case "unreachable": return "unreachable";
    case "error": return "error";
    default: return "loading…";
  }
}

/**
 * The explicit reason a card is not showing live data. Never a value — always a
 * statement about the measurement.
 * @param {any} router
 */
export function stateNote(router, now = Date.now()) {
  const s = routerState(router, now);
  const failed = Object.entries(router?.panels ?? {}).filter(([, p]) => !p?.ok);
  if (s === "live" || s === "loading") return "";
  if (s === "stale") {
    const secs = Math.round((now - (router.lastContact ?? now)) / 1000);
    return `No successful call in ${secs}s — the numbers below are from the last answer, not now.`;
  }
  if (s === "unreachable") {
    const first = failed[0]?.[1];
    return `Unreachable: ${first?.error ?? "the router did not answer"} Nothing is shown for this router because nothing was measured.`;
  }
  const first = failed[0]?.[1];
  return `Error: ${first?.error ?? "the router refused the calls"}`;
}

// ------------------------------------------------------------------ rendering

function renderSession() {
  const el = $("session");
  if (!el) return;
  if (!state.maintainer) {
    el.innerHTML = '<p class="muted">Not signed in.</p>';
    return;
  }
  const methodLabel = state.client?.method === "ephemeral"
    ? "random per-session key (the extension would not sign the derivation message)"
    : "derived from your signature";
  el.innerHTML = `
    <p class="muted">Signed in as</p>
    <p class="mono pubkey" data-testid="session-npub">${escapeHtml(toNpub(state.maintainer.hex))}</p>
    <p class="fine">CVM client key: <span data-testid="client-method">${escapeHtml(methodLabel)}</span></p>
    <p class="fine mono">${escapeHtml(shorten(state.client?.pubkey ?? "", 12))}</p>
    <button type="button" data-action="signout">Sign out</button>
    <button type="button" data-action="reset-client">Reset client key</button>
  `;
}

function renderLoginPanel() {
  const panel = $("login-panel");
  const msg = $("login-message");
  const btn = $("signin");
  if (!panel || !msg || !btn) return;
  if (state.maintainer) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const win = hooks().win ?? globalThis;
  if (hasNip07(win)) {
    msg.textContent = "NIP-07 extension detected. Sign in to see your routers.";
    msg.className = "muted";
    btn.disabled = false;
  } else {
    msg.innerHTML = "No NIP-07 extension found. Install one (Alby, nos2x, or any NIP-07 signer) and reload — this dashboard has no key field by design.";
    msg.className = "error-text";
    btn.disabled = true;
  }
}

function renderDiscovery() {
  const panel = $("discovery-panel");
  const status = $("discovery-status");
  const detail = $("discovery-detail");
  const grid = $("routers");
  if (!panel || !grid) return;
  if (!state.maintainer) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const d = state.discovery;
  if (status) {
    status.textContent = d.status === "loading"
      ? `querying ${state.relays.length} relays…`
      : d.status === "error"
        ? `discovery failed: ${d.error}`
        : `${state.routers.length} router${state.routers.length === 1 ? "" : "s"}`;
  }
  if (detail) {
    const filters = d.filters?.length ? d.filters.map((f) => JSON.stringify(f)).join(" ") : "";
    detail.innerHTML = filters
      ? `Relays: <span class="mono">${escapeHtml(state.relays.join(", "))}</span><br>Filters: <span class="mono">${escapeHtml(filters)}</span>`
      : `Relays: <span class="mono">${escapeHtml(state.relays.join(", "))}</span>`;
  }

  if (d.status === "error") {
    grid.innerHTML = `<p class="error-text" data-testid="discovery-error">${escapeHtml(d.error ?? "discovery failed")}</p>`;
    return;
  }
  if (!state.routers.length) {
    grid.innerHTML = d.status === "loading"
      ? '<p class="muted">Looking for routers…</p>'
      : `<p class="muted" data-testid="empty-state">No routers found for this npub.</p>`;
    return;
  }
  const now = Date.now();
  grid.innerHTML = state.routers.map((r) => renderRouterCard(r, now)).join("");
}

function renderRouterCard(router, now) {
  const s = routerState(router, now);
  const note = stateNote(router, now);
  const facts = READS_PER_ROUTER.map((tool) => {
    const label = READ_TOOLS.find((t) => t.name === tool)?.label ?? tool;
    const p = router.panels?.[tool];
    // `data-tool` is present on EVERY cell, including the failures: a test (and
    // a reader of the DOM) must be able to point at a cell and ask "what does
    // this router say about this tool?" even when the answer is "nothing".
    if (!p) return `<div><dt>${escapeHtml(label)}</dt><dd class="muted" data-tool="${escapeHtml(tool)}">not fetched</dd></div>`;
    if (!p.ok) {
      return `<div><dt>${escapeHtml(label)}</dt><dd class="error-text" data-tool="${escapeHtml(tool)}" data-error="true">error: ${escapeHtml(p.error)}</dd></div>`;
    }
    return `<div><dt>${escapeHtml(label)}</dt><dd data-tool="${escapeHtml(tool)}">${escapeHtml(summarize(tool, p))}</dd></div>`;
  }).join("");

  return `
    <article class="card state-${s}" data-router="${escapeHtml(router.pubkey)}" data-testid="router-card">
      <div class="card-head">
        <span class="card-title">${escapeHtml(router.name)}</span>
        <span class="badge ${s}" data-testid="router-state">${escapeHtml(badgeText(s))}</span>
      </div>
      <span class="pubkey mono">${escapeHtml(toNpub(router.pubkey))}</span>
      ${note ? `<p class="error-text" data-testid="router-note">${escapeHtml(note)}</p>` : ""}
      <div class="facts">${facts}</div>
      <details>
        <summary class="fine">raw responses</summary>
        <pre class="output" data-testid="raw">${escapeHtml(JSON.stringify(
          { announcement: router.event?.content ?? null, panels: router.panels ?? {} },
          null,
          2,
        ))}</pre>
      </details>
      <div><button type="button" data-action="select" data-router="${escapeHtml(router.pubkey)}">Manage</button></div>
    </article>
  `;
}

function renderActions() {
  const panel = $("actions-panel");
  const host = $("actions");
  const title = $("actions-router");
  if (!panel || !host) return;
  const router = state.routers.find((r) => r.pubkey === state.selected);
  if (!router) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  if (title) title.textContent = router.name;

  host.innerHTML = WRITE_TOOLS.map((tool) => {
    const inputs = (tool.args ?? []).map((arg) =>
      `<input data-arg="${escapeHtml(arg)}" placeholder="${escapeHtml(arg)}" aria-label="${escapeHtml(arg)}">`).join("");
    return `
      <div class="action-group" data-write-group="${escapeHtml(tool.name)}">
        ${inputs}
        <button type="button" data-write="${escapeHtml(tool.name)}" title="${escapeHtml(tool.description)}">${escapeHtml(tool.label)}</button>
      </div>`;
  }).join("");
}

/** @param {any} tool */
function collectArgs(tool) {
  const args = {};
  const group = globalThis.document?.querySelector(`[data-write-group="${tool.name}"]`);
  for (const name of tool.args ?? []) {
    args[name] = group?.querySelector(`[data-arg="${name}"]`)?.value ?? "";
  }
  return args;
}

// ------------------------------------------------------------------- plumbing

/**
 * Ask the operator to confirm one write action. Resolves true only if the
 * dialog was submitted with the Send button.
 *
 * @param {{router: any, tool: any, args: Record<string, unknown>}} req
 */
export function confirmWrite({ router, tool, args }) {
  const dlg = $("confirm-dialog");
  if (!dlg) return Promise.resolve(false);
  const routerEl = $("confirm-router");
  const toolEl = $("confirm-tool");
  const argsEl = $("confirm-args");
  if (routerEl) routerEl.textContent = `${router.name} (${toNpub(router.pubkey)})`;
  if (toolEl) toolEl.textContent = tool.name;
  if (argsEl) argsEl.textContent = JSON.stringify(args, null, 2);

  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "send");
    };
    dlg.addEventListener("close", onClose);
    dlg.showModal();
  });
}

/** @param {any} router */
async function refreshRouter(router) {
  router.loading = true;
  renderDiscovery();
  const results = await Promise.allSettled(
    READS_PER_ROUTER.map((tool) => state.cvm.call(router.pubkey, tool)),
  );
  const panels = {};
  let anyOk = false;
  READS_PER_ROUTER.forEach((tool, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      panels[tool] = { ok: r.value.ok, data: r.value.data, message: r.value.message, error: r.value.error };
      if (r.value.ok) anyOk = true;
    } else {
      const err = r.reason;
      panels[tool] = {
        ok: false,
        error: err?.message ?? String(err),
        errorKind: err instanceof CvmTimeoutError ? "timeout" : "rpc",
      };
    }
  });
  router.panels = panels;
  router.loading = false;
  if (anyOk) router.lastContact = Date.now();
  renderDiscovery();
  return router;
}

/** Fan out the per-router reads. */
export async function refreshAll() {
  if (!state.cvm) return state.routers;
  await Promise.allSettled(state.routers.map((r) => refreshRouter(r)));
  state.lastRefresh = Date.now();
  renderDiscovery();
  return state.routers;
}

export async function discover() {
  if (!state.transport || !state.maintainer) return [];
  state.discovery = { status: "loading", error: null, timedOut: false, filters: [], at: null };
  renderDiscovery();
  try {
    const res = await collectRouters(state.transport, state.maintainer, {
      timeoutMs: hooks().discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
    });
    state.discovery = {
      status: "ready",
      error: null,
      timedOut: res.timedOut,
      filters: res.filters,
      at: Date.now(),
    };
    state.routers = res.routers.map((r) => ({ ...r, panels: {}, loading: false, lastContact: null }));
  } catch (err) {
    state.discovery = { status: "error", error: err?.message ?? String(err), timedOut: false, filters: [], at: Date.now() };
    state.routers = [];
  }
  renderDiscovery();
  return state.routers;
}

export async function signIn() {
  const h = hooks();
  const win = h.win ?? globalThis;
  try {
    const signer = await nip07Signer(win);
    const identity = await clientIdentity(signer, { storage: h.storage ?? globalThis.localStorage });
    state.maintainer = { hex: signer.pubkey, npub: toNpub(signer.pubkey) };
    state.client = { pubkey: identity.pubkey, method: identity.method };
    state.relays = h.relays ?? DEFAULT_RELAYS;
    state.transport = h.transportFactory ? h.transportFactory() : createSimplePoolTransport(state.relays);
    state.cvm = new CvmClient({
      secretKey: identity.secretKey,
      transport: state.transport,
      timeoutMs: h.callTimeoutMs ?? CALL_TIMEOUT_MS,
    });
    state.cvm.start();
    renderSession();
    renderLoginPanel();
    await discover();
    await refreshAll();
    return state;
  } catch (err) {
    const msg = $("login-message");
    if (msg) {
      msg.textContent = err instanceof NoNip07Provider
        ? "No NIP-07 extension found. Install one (Alby, nos2x) and reload."
        : `Sign-in failed: ${err?.message ?? err}`;
      msg.className = "error-text";
    }
    throw err;
  }
}

export function signOut() {
  state.cvm?.close();
  state.cvm = null;
  state.transport?.close?.();
  state.transport = null;
  state.maintainer = null;
  state.client = null;
  state.routers = [];
  state.selected = null;
  state.discovery = { status: "idle", error: null, timedOut: false, filters: [], at: null };
  renderSession();
  renderLoginPanel();
  renderDiscovery();
  renderActions();
}

/** Run one write tool, after the operator has confirmed it. */
async function runWrite(router, tool) {
  const args = collectArgs(tool);
  const out = $("action-result");
  const confirmed = await confirmWrite({ router, tool, args });
  if (!confirmed) {
    if (out) {
      out.hidden = false;
      out.textContent = `Cancelled: ${tool.name} was not sent.`;
    }
    return { sent: false };
  }
  if (out) {
    out.hidden = false;
    out.textContent = `Sending ${tool.name} ${JSON.stringify(args)}…`;
  }
  try {
    const result = await state.cvm.call(router.pubkey, tool.name, args);
    if (out) out.textContent = `${tool.name} → ${JSON.stringify(result, null, 2)}`;
    return { sent: true, result };
  } catch (err) {
    const message = err instanceof CvmToolError || err instanceof CvmTimeoutError
      ? `${tool.name} refused/failed: ${err.message}`
      : `${tool.name} failed: ${err?.message ?? err}`;
    if (out) out.textContent = message;
    return { sent: true, error: message };
  }
}

// --------------------------------------------------------------------- events

function wireEvents() {
  const doc = globalThis.document;
  if (!doc) return;

  $("signin")?.addEventListener("click", () => {
    signIn().catch(() => { /* the panel already shows the reason */ });
  });
  $("refresh")?.addEventListener("click", () => {
    refreshAll().catch(() => {});
  });

  doc.addEventListener("click", (evt) => {
    const btn = evt.target?.closest?.("[data-action],[data-write]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "signout") {
      signOut();
      return;
    }
    if (action === "reset-client") {
      const h = hooks();
      resetClientIdentity({ pubkey: state.maintainer.hex }, { storage: h.storage ?? globalThis.localStorage });
      if ($("action-result")) {
        $("action-result").hidden = false;
        $("action-result").textContent = "Client key forgotten. Sign in again to derive a new one.";
      }
      return;
    }
    if (action === "select") {
      state.selected = btn.getAttribute("data-router");
      renderActions();
      return;
    }
    const writeName = btn.getAttribute("data-write");
    if (writeName) {
      const tool = WRITE_TOOLS.find((t) => t.name === writeName);
      const router = state.routers.find((r) => r.pubkey === state.selected);
      if (tool && router) runWrite(router, tool).catch(() => {});
    }
  });
}

export async function boot() {
  wireEvents();
  renderLoginPanel();
  renderSession();
  const h = hooks();
  if (h.autoSignIn) {
    await signIn().catch(() => {});
  }
  if (h.autoRefresh !== false && state.cvm) {
    globalThis.setInterval(() => {
      if (globalThis.document?.hidden) return;
      refreshAll().catch(() => {});
    }, h.refreshMs ?? 60_000);
  }
}

// A single handle for the browser test suite: it can inject synthetic protocol
// events and drive the same code paths the UI uses.
globalThis.__tollgate = {
  state,
  signIn,
  signOut,
  discover,
  refreshAll,
  confirmWrite,
  wrapForRecipient,
  unwrapGiftWrap,
  READ_TOOLS,
  WRITE_TOOLS,
};

if (!hooks().noAutoStart) {
  boot().catch(() => { /* surfaced in the login panel */ });
}
