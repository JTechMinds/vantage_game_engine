import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import {
  lightingForTime,
  skyStateForTime,
  waterStateFromWind,
  windDirectionToRadians,
} from "../../../src/engine/layer1/renderer/materials.ts";
import { buildTerrainMesh } from "../../../src/engine/layer1/renderer/mesh.ts";
import { computeMaterialWeightAttribute } from "../../../src/engine/layer1/renderer/wiring.ts";

// Small fast preset for the weight integration checks.
const GRID = 64;
const METERS = 256;

function makeTerrain(seed = 7) {
  const t = createTerrainLayer();
  t.setParams({ seed, biome: "caribbean", elevation: 5, mountainAggression: 5 });
  t.generate();
  return t;
}

/* ---------------- Lighting (spec §4, L1-AC-060) ---------------- */

test("noon sun is above the horizon, night sun is at or below it", () => {
  const noon = lightingForTime(12);
  const night = lightingForTime(0);
  assert.ok(noon.sunDir[1] > 0, "noon sun should be above the horizon plane");
  assert.ok(night.sunDir[1] <= 0.05, "night sun should not be high in the sky");
  // Sun direction is a unit-ish vector, all finite.
  for (const v of noon.sunDir) assert.ok(Number.isFinite(v));
});

test("night sun color is dimmer than noon sun color", () => {
  const luminance = (c: readonly number[]) => c[0] + c[1] + c[2];
  const noon = lightingForTime(12);
  const night = lightingForTime(0);
  assert.ok(
    luminance(night.sunColor) < luminance(noon.sunColor),
    "night direct sun must be darker than daytime sun (L1-AC-060)",
  );
});

test("lighting is continuous across a small time-of-day step (no snapping)", () => {
  const a = lightingForTime(11.8);
  const b = lightingForTime(12.2);
  const maxDelta = Math.max(
    ...a.sunDir.map((v, i) => Math.abs(v - b.sunDir[i])),
    ...a.sunColor.map((v, i) => Math.abs(v - b.sunColor[i])),
  );
  assert.ok(maxDelta < 0.25, `lighting jumped ${maxDelta} over a 0.02 step`);
});

/* ---------------- Sky (spec §5, L1-AC-060) ---------------- */

test("sky gradient changes between day and night", () => {
  const day = skyStateForTime(12, 3, 180);
  const night = skyStateForTime(0, 3, 180);
  const zenithDelta = Math.abs(day.zenithColor[1] - night.zenithColor[1]);
  assert.ok(zenithDelta > 0.01, "sky zenith must visibly differ at night vs day");
  for (const v of [...day.zenithColor, ...day.horizonColor]) {
    assert.ok(Number.isFinite(v));
  }
});

/* ---------------- Water wind response (spec §5, L1-AC-066/090) ---------------- */

test("wind intensity raises ripple amplitude and speed (L1-AC-066)", () => {
  const calm = waterStateFromWind(0, 0, "caribbean");
  const windy = waterStateFromWind(10, 0, "caribbean");
  assert.ok(
    windy.rippleAmplitude > calm.rippleAmplitude,
    "stronger wind must increase ripple amplitude",
  );
  assert.ok(
    windy.rippleSpeed >= calm.rippleSpeed,
    "stronger wind must not slow ripple motion",
  );
  // Calm water keeps a residual (non-frozen, low) motion per spec §5 edge cases.
  assert.ok(calm.rippleSpeed >= 0 && Number.isFinite(calm.rippleSpeed));
});

test("wind orientation is continuous across the 0/360-degree boundary (spec §5)", () => {
  const justUnder = waterStateFromWind(5, 359, "caribbean").windDirectionRad;
  const justOver = waterStateFromWind(5, 1, "caribbean").windDirectionRad;
  // Orientation is consumed as cos/sin, so compare the unit vectors, not the
  // raw radians (which legitimately wrap).
  const a = [Math.cos(justUnder), Math.sin(justUnder)];
  const b = [Math.cos(justOver), Math.sin(justOver)];
  const delta = Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.ok(delta < 0.05, `wind direction snapped across 0/360 (delta ${delta})`);
});

test("windDirectionToRadians maps cardinal degrees correctly", () => {
  assert.ok(Math.abs(windDirectionToRadians(0)) < 1e-6);
  assert.ok(Math.abs(windDirectionToRadians(180) - Math.PI) < 1e-6);
  assert.ok(Number.isFinite(windDirectionToRadians(45)));
});

/* ---------------- Material weights (spec §4, §11.2) ---------------- */

test("material weight attribute is finite, 4-wide, and sums to at most 1", () => {
  const t = makeTerrain();
  const snap = t.snapshot();
  const buffers = buildTerrainMesh(t, {
    worldWidth: METERS,
    worldDepth: METERS,
    vertexGrid: GRID,
    lodLevel: "near",
  });
  const weights = computeMaterialWeightAttribute(
    buffers,
    t.getParams(),
    snap.heightMin,
    snap.heightMax,
  );
  assert.equal(weights.length, buffers.vertexCount * 4);
  for (let i = 0; i < buffers.vertexCount; i += 1) {
    const o = i * 4;
    const sum = weights[o] + weights[o + 1] + weights[o + 2] + weights[o + 3];
    assert.ok(
      Number.isFinite(sum) && sum <= 1.0001 && sum >= -1e-4,
      `vertex ${i} weight sum out of range: ${sum}`,
    );
    for (let c = 0; c < 4; c += 1) {
      assert.ok(Number.isFinite(weights[o + c]) && weights[o + c] >= -1e-4);
    }
  }
});

test("material weights are deterministic for the same snapshot (L1-AC-153)", () => {
  const t = makeTerrain(42);
  const snap = t.snapshot();
  const buffers = buildTerrainMesh(t, {
    worldWidth: METERS,
    worldDepth: METERS,
    vertexGrid: GRID,
    lodLevel: "near",
  });
  const a = computeMaterialWeightAttribute(buffers, t.getParams(), snap.heightMin, snap.heightMax);
  const b = computeMaterialWeightAttribute(buffers, t.getParams(), snap.heightMin, snap.heightMax);
  assert.deepEqual(Array.from(a), Array.from(b));
});
