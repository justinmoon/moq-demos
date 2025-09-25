import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const DEFAULT_RELAY = process.env.PLAYWRIGHT_RELAY_URL ?? process.env.VITE_RELAY_URL ?? "https://moq.justinmoon.com/anon";
const PORT = process.env.PLAYWRIGHT_WEB_PORT ?? "4173";
const HOST = process.env.PLAYWRIGHT_WEB_HOST ?? "127.0.0.1";
const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bash -lc "APP_BASE='/' VITE_RELAY_URL='${DEFAULT_RELAY}' bun run build && APP_BASE='/' VITE_RELAY_URL='${DEFAULT_RELAY}' bunx --bun serve dist -l ${PORT}"`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: ROOT,
  },
});
