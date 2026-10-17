import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer, type BiomeId } from "../../../src/engine/layer1/terrain/index.ts";

const BIOMES: BiomeId[] = ["desert", "highlands", "alpine", "water", "caribbean"];

function gridStats(t: ReturnType<typeof createTerrainLayer>): { min: number; max: number; variance: number } {
  let min = Infinity;
  let max = -Infinity;
  const values: number[] = [];
  for (let iz = 0; iz < 32; iz++) {
    for (let ix = 0; ix < 32; ix++) {
      const x = -127 + (254 * ix) / 31;
      const z = -127 + (254 * iz) / 31;
      const h = t.sampleHeight(x, z);
      assert.ok(Number.isFinite(h), `sampleHeight must be finite, got ${h}`);
      if (h < min) min = h;
      if (h > max) max = h;
      values.push(h);
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { min, max, variance };
}

test("every supported biome generates a finite heightfield with sane metadata", () => {
  for (const biome of BIOMES) {
    const t = createTerrainLayer();
    t.setParams({ biome, seed: 5 });
    const snap = t.snapshot();
    assert.equal(snap.generated, true, `${biome} generated after geometry patch`);
    assert.ok(Number.isFinite(snap.heightMin) && Number.isFinite(snap.heightMax), biome);
    assert.equal(snap.biome, biome);
    assert.ok(snap.triangleCount > 0, biome);
    assert.ok(snap.textureCount > 0, biome);
    gridStats(t);
  }
});

test("mountain aggression 0 produces lower peak variance than mountain aggression 10", () => {
  const low = createTerrainLayer();
  const high = createTerrainLayer();
  low.setParams({ mountainAggression: 0, seed: 3, biome: "highlands" });
  high.setParams({ mountainAggression: 10, seed: 3, biome: "highlands" });
  const lowStats = gridStats(low);
  const highStats = gridStats(high);
  assert.ok(
    highStats.variance > lowStats.variance * 2,
    `expected high-mountain variance (${highStats.variance.toFixed(1)}) >> low (${lowStats.variance.toFixed(1)})`,
  );
});

test("elevation scaling changes height range without producing NaN or infinite values", () => {
  const low = createTerrainLayer();
  const high = createTerrainLayer();
  low.setParams({ elevation: 0, seed: 8 });
  high.setParams({ elevation: 10, seed: 8 });
  const lowRange = gridStats(low);
  const highRange = gridStats(high);
  assert.ok(highRange.max - highRange.min > lowRange.max - lowRange.min);
  assert.ok(Number.isFinite(highRange.max) && Number.isFinite(lowRange.min));
});

test("valley and river aggression change measurable terrain features without breaking continuity", () => {
  const base = createTerrainLayer();
  const valleys = createTerrainLayer();
  base.setParams({ valleyAggression: 0, riverAggression: 0, seed: 11, biome: "highlands" });
  valleys.setParams({ valleyAggression: 10, riverAggression: 10, seed: 11, biome: "highlands" });
  const b = gridStats(base);
  const v = gridStats(valleys);
  assert.notEqual(b.min.toFixed(6), v.min.toFixed(6), "valleys/river must move the low point");
  // Continuity: adjacent samples never jump absurdly (no holes/cliffs from carving).
  for (let iz = 0; iz < 16; iz++) {
    for (let ix = 0; ix < 16; ix++) {
      const x = -120 + ix * 15;
      const z = -120 + iz * 15;
      const h = valleys.sampleHeight(x, z);
      const hn = valleys.sampleHeight(x + 7.5, z);
      assert.ok(Math.abs(hn - h) < 60, `continuity violated at ${x},${z}: ${h} -> ${hn}`);
    }
  }
});

test("biome selection changes height profile and material metadata", () => {
  const profiles: Record<string, ReturnType<typeof gridStats> & { textures: number; water: number }> = {};
  for (const biome of BIOMES) {
    const t = createTerrainLayer();
    t.setParams({ biome, seed: 21 });
    profiles[biome] = { ...gridStats(t), textures: t.snapshot().textureCount, water: t.snapshot().waterFraction };
  }
  // Alpine sits higher than desert/highlands at identical knobs.
  assert.ok(profiles.alpine!.max > profiles.desert!.max + 10, "alpine peaks should tower over desert");
  assert.ok(profiles.alpine!.max > profiles.highlands!.max, "alpine peaks should tower over highlands");
  // Water-bearing biomes produce water regions; dry biomes do not.
  assert.ok(profiles.water!.water > 0.05, "water biome must produce water regions");
  assert.ok(profiles.caribbean!.water > 0.05, "caribbean must produce water regions (island ring)");
  assert.equal(profiles.desert!.water, 0);
  assert.equal(profiles.highlands!.water, 0);
  assert.equal(profiles.alpine!.water, 0);
  // Material metadata differs per biome.
  assert.notEqual(profiles.caribbean!.textures, profiles.alpine!.textures);
});

test("generation completes under 2s for the default world size", () => {
  const t = createTerrainLayer();
  t.generate();
  assert.ok(t.telemetry().generationTimeMs < 2000, `generation took ${t.telemetry().generationTimeMs}ms`);
});

test("all knobs at extremes produce finite output for every biome", () => {
  for (const biome of BIOMES) {
    for (const extreme of [0, 10]) {
      const t = createTerrainLayer();
      t.setParams({ biome, seed: extreme, mountainAggression: extreme, valleyAggression: extreme, riverAggression: extreme, elevation: extreme });
      gridStats(t);
    }
  }
});
