// Discovery: find every TollGate a maintainer owns, from the routers' own
// CEP-6 announcements. There is no registry and no curator — the router is the
// source of truth.
//
// Kind 11316 is a REGULAR replaceable kind, so `#p` filtering works on it (unlike
// the gift-wrap kinds). We still filter client-side as well: a relay is allowed
// to return more than we asked for, and "an event addressed to someone else must
// never be rendered as one of your routers" is a correctness property, not a
// performance tweak.

import { ANN_CLASS_TAG, ANN_D_SLUG, ANN_SERVER_KIND, ANN_TOOLS_KIND } from "./config.js";

/** All values of `name` among an event's tags. @param {any} evt @param {string} name */
export function tagValues(evt, name) {
  const tags = Array.isArray(evt?.tags) ? evt.tags : [];
  return tags.filter((t) => Array.isArray(t) && t[0] === name && typeof t[1] === "string").map((t) => t[1]);
}

/** First value of `name`, or null. @param {any} evt @param {string} name */
export function firstTagValue(evt, name) {
  const values = tagValues(evt, name);
  return values.length ? values[0] : null;
}

/**
 * Is this event one of our service's announcements at all? The `d` slug and the
 * namespaced `t` class are the two halves of "this is a tollgate-cvm", and an
 * unrelated 11316 must not become a router card.
 * @param {any} evt
 */
export function isTollgateAnnouncement(evt) {
  if (evt?.kind !== ANN_SERVER_KIND) return false;
  const d = firstTagValue(evt, "d");
  const classes = tagValues(evt, "t");
  return d === ANN_D_SLUG || classes.includes(ANN_CLASS_TAG);
}

/**
 * The `p` tag is the discovery key: it names the maintainer who owns the
 * router.
 *
 * NOTE (measured against the router's own source): `maintainer_npub` is stored
 * and published as a bech32 `npub1…`, while a NIP-07 extension hands the
 * dashboard a 64-char hex pubkey, and `#p` is conventionally hex. So the
 * dashboard accepts EITHER spelling here and queries the relay with both, which
 * keeps working whichever way the router is fixed.
 *
 * @param {any} evt
 * @param {{hex: string, npub?: string|null}} maintainer
 */
export function isAddressedToMaintainer(evt, maintainer) {
  const values = tagValues(evt, "p");
  if (!values.length) return false;
  return values.some((v) => v === maintainer.hex || (maintainer.npub && v === maintainer.npub));
}

/** The dedupe key of a replaceable announcement: (kind, author pubkey, d). */
export function announcementKey(evt) {
  return `${evt.kind}:${evt.pubkey}:${firstTagValue(evt, "d") ?? ""}`;
}

/**
 * Parse one announcement into the router descriptor the UI renders.
 *
 * Nothing here is invented: every field is either a tag the router published or
 * a value from the event itself. A missing `relays` tag yields `null`, not a
 * guessed default, because guessing would make the dashboard query relays the
 * router may never have published to.
 *
 * @param {any} evt
 */
export function parseAnnouncement(evt) {
  let content = {};
  try {
    content = JSON.parse(evt.content ?? "{}");
  } catch {
    content = {};
  }
  const relays = Array.isArray(content.relays) ? content.relays.filter((r) => typeof r === "string") : null;
  return {
    /** The router's hex pubkey — its CVM address. */
    pubkey: evt.pubkey,
    d: firstTagValue(evt, "d") ?? ANN_D_SLUG,
    name: typeof content.name === "string" ? content.name : (firstTagValue(evt, "name") ?? ANN_D_SLUG),
    about: typeof content.about === "string" ? content.about : (firstTagValue(evt, "about") ?? ""),
    relays,
    announcedAt: evt.created_at ?? null,
    /** Raw announcement, kept so the UI can show exactly what the router said. */
    event: evt,
  };
}

/**
 * The maintainer's fleet: every tollgate they own, newest announcement per
 * router.
 *
 * @param {any[]} events
 * @param {{hex: string, npub?: string|null}} maintainer
 * @returns {ReturnType<typeof parseAnnouncement>[]}
 */
export function selectRouters(events, maintainer) {
  const byKey = new Map();
  for (const evt of events ?? []) {
    if (!isTollgateAnnouncement(evt)) continue;
    // Client-side p filter — the event must name THIS maintainer.
    if (!isAddressedToMaintainer(evt, maintainer)) continue;
    const key = announcementKey(evt);
    const prev = byKey.get(key);
    if (!prev || (evt.created_at ?? 0) > (prev.created_at ?? 0)) byKey.set(key, evt);
  }
  return [...byKey.values()]
    .map(parseAnnouncement)
    .sort((a, b) => (b.announcedAt ?? 0) - (a.announcedAt ?? 0));
}

/**
 * Build the discovery REQ filters for a maintainer.
 *
 * Two filters, because the `p` tag's spelling is not settled (see
 * `isAddressedToMaintainer`): one for hex, one for bech32. A relay matches tag
 * values literally, so sending both costs one extra filter and removes a whole
 * class of "no routers found" false negatives.
 *
 * @param {{hex: string, npub?: string|null}} maintainer
 */
export function discoveryFilters(maintainer) {
  const filters = [{ kinds: [ANN_SERVER_KIND], "#p": [maintainer.hex] }];
  if (maintainer.npub && maintainer.npub !== maintainer.hex) {
    filters.push({ kinds: [ANN_SERVER_KIND], "#p": [maintainer.npub] });
  }
  return filters;
}

/** True when the event is a tools-list announcement for this service. */
export function isToolsAnnouncement(evt) {
  return evt?.kind === ANN_TOOLS_KIND && firstTagValue(evt, "d") === ANN_D_SLUG;
}

/**
 * Run discovery against a transport and return the maintainer's fleet.
 *
 * Resolves on EOSE (every relay has finished replaying) or on the timeout —
 * whichever comes first. A timeout is NOT an error: a relay that never EOSEs
 * still may have delivered announcements, and an empty fleet is reported as an
 * empty fleet, never as a fabricated one.
 *
 * @param {any} transport
 * @param {{hex: string, npub?: string|null}} maintainer
 * @param {{timeoutMs?: number, onEvent?: (evt: any) => void}} [opts]
 * @returns {Promise<{routers: any[], events: any[], filters: any[], timedOut: boolean}>}
 */
export async function collectRouters(transport, maintainer, { timeoutMs = 12_000, onEvent } = {}) {
  const events = [];
  const filters = discoveryFilters(maintainer);
  let timedOut = false;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);
    let sub;
    try {
      sub = transport.subscribe(filters, {
        onevent(evt) {
          events.push(evt);
          onEvent?.(evt);
        },
        oneose() {
          clearTimeout(timer);
          finish();
        },
      });
    } catch {
      clearTimeout(timer);
      finish();
      return;
    }
    // Safety net: a subscription that never EOSEs must not hold the UI forever.
    setTimeout(() => {
      try {
        sub?.close?.();
      } catch {
        /* already closed */
      }
    }, timeoutMs + 500);
  });

  return { routers: selectRouters(events, maintainer), events, filters, timedOut };
}
