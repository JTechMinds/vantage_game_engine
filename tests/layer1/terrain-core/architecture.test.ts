import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(here, "../../../src/engine/layer1/terrain");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Strip line and block comments so doc text cannot false-positive the scans.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Import specifiers that Layer 1 core must never reference. */
const FORBIDDEN = [
  "three",
  "@react-three",
  "react",
  "@dimforge/rapier",
  "rapier",
  "cannon",
  "babylon",
  "pixi",
  "document",
  "window.",
  "navigator",
  "canvas",
  "webgl",
  "physics",
  "collision",
  "entities",
  "entity/",
  "combat",
  "inventory",
  "gameplay",
  "camera",
  "objects/",
  "layer2",
  "layer-2",
];

test("no core module imports UI, renderer, gameplay, physics, combat, inventory, objects, or Layer 2+ systems", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(coreRoot)) {
    const src = stripComments(readFileSync(file, "utf8"));
    const importLines = src.split("\n").filter((line) => /^\s*import\s/.test(line) || /require\(/.test(line));
    for (const line of importLines) {
      const lower = line.toLowerCase();
      for (const bad of FORBIDDEN) {
        if (lower.includes(bad)) violations.push(`${file}: ${line.trim()} (${bad})`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("no core module references DOM globals in executable code", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(coreRoot)) {
    const code = stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .join("\n");
    for (const globalRef of ["document.", "window.", "navigator.", "localStorage", "fetch(", "XMLHttpRequest"]) {
      if (code.includes(globalRef)) violations.push(`${file}: ${globalRef}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("no core module uses Math.random inside generation paths", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(coreRoot)) {
    if (file.endsWith("terrain-layer.ts")) continue; // randomize() seed pick is the sole allowed use
    const src = stripComments(readFileSync(file, "utf8"));
    if (src.includes("Math.random")) violations.push(file);
  }
  assert.deepEqual(violations, []);
});

test("public barrel exports exactly the public surface and no internals", async () => {
  const api = await import("../../../src/engine/layer1/terrain/index.ts");
  const names = Object.keys(api).sort();
  assert.ok(names.includes("createTerrainLayer"));
  assert.ok(names.includes("DEFAULT_TERRAIN_PARAMS"));
  assert.ok(names.includes("TerrainErrorCode"));
  for (const forbidden of [
    "DeterministicHeightfieldGenerator",
    "BilinearHeightfieldSampler",
    "BIOME_PROFILES",
    "valueNoise",
    "fbm",
    "ridged",
    "hash2",
    "createSeededRng",
    "TerrainEventBus",
    "VersionedJsonTerrainSerializer",
  ]) {
    assert.ok(!(forbidden in api), `internal symbol "${forbidden}" must not be re-exported publicly`);
  }
});

test("importing the public entry point has no side effects on shared state", async () => {
  const before = JSON.stringify(Object.keys(globalThis).sort());
  await import("../../../src/engine/layer1/terrain/index.ts");
  const after = JSON.stringify(Object.keys(globalThis).sort());
  assert.equal(after, before);
});
