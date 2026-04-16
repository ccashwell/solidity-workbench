#!/usr/bin/env node
/**
 * Rasterize packages/extension/resources/icon.svg to
 * packages/extension/resources/icon.png at 128x128 (the VS Code
 * Marketplace-recommended size).
 *
 * Run via `pnpm build:icon` from the repo root. Checked-in PNG is
 * refreshed whenever the SVG changes; CI verifies nothing is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SVG_PATH = resolve(__dirname, "../packages/extension/resources/icon.svg");
const PNG_PATH = resolve(__dirname, "../packages/extension/resources/icon.png");

const svg = readFileSync(SVG_PATH, "utf-8");

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 128 },
  background: "rgba(0, 0, 0, 0)",
});

const png = resvg.render().asPng();
writeFileSync(PNG_PATH, png);

console.log(`Wrote ${PNG_PATH} (${png.length} bytes)`);
