import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer, DEFAULT_TERRAIN_PARAMS } from "../../../src/engine/layer1/terrain/index.ts";

test("createTerrainLayer works with no DOM/renderer/UI present", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.window, "undefined");
  const t = createTerrainLayer();
  assert.equal(typeof t.sampleHeight, "function");
  assert.equal(typeof t.generate, "function");
});

test("default parameters are present and valid", () => {
  const t = createTerrainLayer();
  const p = t.getParams();
  assert.deepEqual({ ...p }, { ...DEFAULT_TERRAIN_PARAMS });
  assert.equal(t.validate({}).valid, true);
});

test("getParams returns a frozen defensive copy (callers cannot mutate core state)", () => {
  const t = createTerrainLayer();
  const p = t.getParams() as { seed: number };
  assert.throws(() => {
    p.seed = 999;
  });
  assert.equal(t.getParams().seed, DEFAULT_TERRAIN_PARAMS.seed);
});

test("DEFAULT_TERRAIN_PARAMS is frozen", () => {
  assert.throws(() => {
    (DEFAULT_TERRAIN_PARAMS as { seed: number }).seed = 5;
  });
});

test("telemetry is safe before first generation", () => {
  const t = createTerrainLayer();
  const tel = t.telemetry();
  assert.equal(tel.generationTimeMs, 0);
  assert.equal(tel.lastError, null);
  assert.equal(tel.triangleCount, 0);
});

test("two instances are independent (no module-level singleton)", () => {
  const a = createTerrainLayer();
  const b = createTerrainLayer();
  a.setParams({ seed: 42 });
  assert.notEqual(a.getParams().seed, b.getParams().seed);
});
