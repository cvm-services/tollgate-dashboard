// Protocol constants and the tool catalog — the single place the dashboard
// encodes facts about the router side (`tollgate-cvm`) and ContextVM.
//
// Everything here is a copy of a fact verified in the router's own source
// (`src/cmd/tollgate-cvm/announce.go`, `tools.go`, `serve.go`) or in the CVM
// spec. When the router's surface changes, this file is what must change with
// it — and `lib/tools.js` renders writes from the write list below, so a tool
// missing here is a tool the dashboard cannot call.

/** ContextVM message kind: a NIP-59 gift wrap. The rumor inside is kind 25910. */
export const GIFT_WRAP_KIND = 1059;
/** Ephemeral gift wraps (20000-30000) — some peers use these instead. */
export const EPHEMERAL_GIFT_WRAP_KIND = 21059;
/** The CVM rumor kind (JSON-RPC 2.0 in `content`). Never published bare. */
export const RUMOR_KIND = 25910;

/** CEP-6 server announcement (regular replaceable, keyed by kind+pubkey+d). */
export const ANN_SERVER_KIND = 11316;
/** CEP-6 tools-list announcement. */
export const ANN_TOOLS_KIND = 11317;

/**
 * The `d` slug and class tag every tollgate-cvm announcement carries. These are
 * half of the dedupe/classification key; the class tag is what makes a gift
 * wrap with kind 11316 from a random repo obviously not ours.
 */
export const ANN_D_SLUG = "tollgate-control-plane";
export const ANN_CLASS_TAG = "cvm:service:tollgate-control-plane";

/**
 * Relays the routers announce on by default.
 *
 * MUST match `tollgate-cvm`'s own default relay set, otherwise the dashboard
 * queries relays the routers never published to and reports "no routers found"
 * for a fleet that exists. `relay.contextvm.org` is deliberately absent: it is
 * unreachable (DNS/TLS timeout) and hangs connections.
 */
export const DEFAULT_RELAYS = [
  "wss://relay2.contextvm.org",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

/** Discovered-announcement fan-in wait, per relay batch. */
export const DISCOVERY_TIMEOUT_MS = 12_000;

/** One CVM tool call's budget. The server answers in well under a second when
 * the router is up; 30s is the point at which "unreachable" is the honest
 * reading. Mirrors the reference browser client's timeout. */
export const CALL_TIMEOUT_MS = 30_000;

/**
 * Fixed message the NIP-07 extension is asked to sign to derive the CVM client
 * key. Versioned: changing it changes every user's client identity, so it must
 * only ever be bumped with a documented reason (it is a NIP-59 shared-secret
 * input, and a bump means routers see a caller they have never seen before —
 * harmless for reads, but a write authorization that keyed on caller identity
 * would need re-doing).
 */
export const CLIENT_KEY_MESSAGE = "tollgate-dashboard-cvm-client-v1";

/**
 * The router's tool surface, split read/write exactly as `tools.go` declares it.
 *
 * DELIBERATELY ABSENT, and must stay absent: `drain`, `fund`, `ssl`. `drain`
 * returns spendable ecash (publishing it to a relay is a money-printing bug),
 * `fund` pushes a token through a relay, and `ssl` returns credential material.
 * The dashboard does not merely avoid calling them — it never renders a control
 * for a tool that is not in this list.
 */
export const READ_TOOLS = [
  { name: "status", label: "Status", group: "Core", description: "Service status: uptime, running state, config/wallet/network health" },
  { name: "health", label: "Health", group: "Core", description: "Liveness probe: healthy only when components are up" },
  { name: "version", label: "Version", group: "Core", description: "Version, commit and build info of the running service" },
  { name: "wallet_balance", label: "Wallet balance", group: "Wallet", description: "Wallet balance in sats (no secrets)" },
  { name: "wallet_info", label: "Wallet info", group: "Wallet", description: "Wallet info: balance and addresses (no key material)" },
  { name: "config_get", label: "Config", group: "Config", description: "Current configuration (secrets redacted by the service)" },
  { name: "config_schema", label: "Config schema", group: "Config", description: "Every config field, its type and editability" },
  { name: "private_status", label: "Private network", group: "Network", description: "Private network state: SSID, enabled" },
  { name: "upstream_list", label: "Upstreams", group: "Network", description: "Configured upstream STA interfaces" },
  { name: "upstream_known", label: "Known upstreams", group: "Network", description: "Known upstream networks from the last scan" },
  { name: "upstream_scan", label: "Scan upstreams", group: "Network", description: "Scan for upstream WiFi networks now (read-only)" },
];

/** Maintainer-only tools. Each one renders behind an explicit confirm step. */
export const WRITE_TOOLS = [
  { name: "config_set", label: "Set config key", group: "Config", description: "Set one config key (e.g. maintainer_npub)", args: ["key", "value"] },
  { name: "private_enable", label: "Enable private network", group: "Network", description: "Enable the private network", args: [] },
  { name: "private_disable", label: "Disable private network", group: "Network", description: "Disable the private network", args: [] },
  { name: "private_rename", label: "Rename private network", group: "Network", description: "Rename the private network", args: ["ssid"] },
];

/** Names the dashboard must never call or render, kept here as an assertion
 * target so a regression fails a test rather than shipping a control. */
export const FORBIDDEN_TOOLS = ["drain", "fund", "ssl"];

/** @param {string} name */
export function isWriteTool(name) {
  return WRITE_TOOLS.some((t) => t.name === name);
}
