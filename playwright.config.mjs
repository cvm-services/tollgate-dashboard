// Playwright runner for the dashboard's browser tests.
//
// Why a real browser at all: the properties this suite exists to protect are
// DOM properties — a login that has no key field, a confirm dialog that gates
// every write, an unreachable router that renders as an error instead of a
// plausible number. Source-level contracts cover the rest (tests/*_test.ts).
//
// NOTHING HERE TOUCHES A RELAY. Every test injects its own `window.nostr`
// extension double and its own relay transport, so the suite is hermetic and
// runs in a sandbox with no network. The relay URLs the page is given are
// deliberately unroutable (`wss://test.invalid`) — if the app ever opened a real
// socket, the suite would notice.
//
// Video is off (this is not evidence for a PR), traces and screenshots are kept
// on failure only.

import { defineConfig, devices } from "@playwright/test";

export const PORT = Number(process.env.PORT ?? 8099);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results/dashboard",
  use: {
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
  },
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 30_000,
    env: { PORT: String(PORT) },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT}` },
    },
  ],
});
