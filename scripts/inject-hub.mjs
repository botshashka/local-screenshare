// Bakes the signaling hub host into a gitignored public/js/config.js from the
// SIGNALING_HUB env var, so a deploy can point the static pages at its hub
// without committing the host to source. Unset/empty ⇒ an empty file ⇒ the
// pages fall back to <meta> then same-origin (local server.ts). Runs last in
// `pnpm build`, after the browser bundles land in public/js/.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "js");
mkdirSync(outDir, { recursive: true });

const hub = (process.env.SIGNALING_HUB ?? "").trim();
writeFileSync(
  join(outDir, "config.js"),
  hub ? `window.__SIGNALING_HUB__ = ${JSON.stringify(hub)};\n` : "",
);
console.log(`[build] signaling hub: ${hub || "(none — pages use <meta>/same-origin)"}`);
