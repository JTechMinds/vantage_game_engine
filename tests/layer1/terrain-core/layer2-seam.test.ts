import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Layer 2 seam: import ONLY the public Layer 1 terrain API.
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

/**
 * Simulated Layer 2 consumer: places a marker at the correct terrain height
 * using only sampleHeight(x, z). It never learns grid dimensions, vertex
 * layout, material state, seed internals, or renderer mesh layout.
 */
function placeMarker(terrain: ReturnType<typeof createTerrainLayer>, x: number, z: number) {
  return { x, y: terrain.sampleHeight(x, z), z };
}

test("Layer 2 stub places a marker at correct height via public API only", () => {
  const terrain = createTerrainLayer();
  terrain.setParams({ seed: 42, biome: "highlands" });
  const marker = placeMarker(terrain, 33.2, -19.7);
  assert.ok(Number.isFinite(marker.y));
  assert.equal(marker.y, terrain.sampleHeight(33.2, -19.7));
});

test("seam remains valid after regeneration, round-trip, reset, and randomize", () => {
  const terrain = createTerrainLayer();
  terrain.generate();
  const m1 = placeMarker(terrain, 5, 5);

  terrain.generate();
  assert.equal(placeMarker(terrain, 5, 5).y, m1.y, "regeneration must not move the seam");

  const json = terrain.serialize();
  terrain.reset();
  terrain.deserialize(json);
  assert.equal(placeMarker(terrain, 5, 5).y, m1.y, "round-trip must restore identical heights");

  terrain.randomize();
  assert.ok(Number.isFinite(placeMarker(terrain, 5, 5).y), "randomize keeps the seam usable");
});

test("seam stub file imports no generation internals (static scan)", () => {
  // This very test file is the stub. Scan only actual import-statement lines
  // so the scanning code itself cannot self-match.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const importLines = src.split("\n").filter((line) => /^import\s/.test(line));
  assert.ok(importLines.length >= 1);
  for (const line of importLines) {
    const match = /from\s+"([^"]+)"/.exec(line);
    if (!match) continue; // e.g. `import { test } from "node:test"` still matches below
    const spec = match[1]!;
    if (spec.startsWith("node:")) continue;
    if (spec === "../../../src/engine/layer1/terrain/index.ts") continue;
    throw new Error(`seam stub must import only the public API; found ${spec}`);
  }
});
