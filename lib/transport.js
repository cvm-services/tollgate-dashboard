// CVM transport: relay I/O behind a seam so the client is testable with no
// network. The production implementation is nostr-tools' SimplePool; the test
// double is a plain object with the same three methods.
//
// `publish` resolves to the NUMBER OF RELAYS that accepted the event, because
// "published" without that number is a claim the dashboard cannot back up.

import { SimplePool } from "../vendor/nostr.mjs";

/**
 * @typedef {object} RelayTransport
 * @property {(event: any) => Promise<number>} publish resolves to relays reached
 * @property {(filter: any, handlers: any) => {close?: () => void}} subscribe
 * @property {() => void} close
 */

/**
 * Real transport over a set of relays.
 * @param {string[]} relays
 * @param {{SimplePoolImpl?: any}} [opts]
 * @returns {RelayTransport}
 */
export function createSimplePoolTransport(relays, { SimplePoolImpl = SimplePool } = {}) {
  const pool = new SimplePoolImpl();
  return {
    async publish(event) {
      // SimplePool.publish returns an ARRAY OF PROMISES (one per relay), not a
      // promise. Awaiting it directly is a no-op that publishes nothing and
      // reports success — a mistake that has shipped before in this estate.
      const results = await Promise.allSettled(pool.publish(relays, event));
      return results.filter((r) => r.status === "fulfilled").length;
    },
    subscribe(filter, handlers) {
      return pool.subscribeMany(relays, filter, handlers);
    },
    close() {
      try {
        pool.close(relays);
      } catch {
        /* already closed */
      }
    },
  };
}
