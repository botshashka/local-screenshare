import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Runs the test suite inside workerd (via Miniflare), so the Durable Object,
// WebSocket hibernation, and bindings behave as they do in production. The
// wrangler.toml supplies the ROOMS Durable Object binding + SQLite migration.
// (.mts so the ESM-only pool plugin loads — the worker package isn't type:module.)
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
});
