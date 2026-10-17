import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

const SAMPLE_POINTS: [number, number][] = [
  [-100, -100], [-37, 12], [0, 0], [42, -63], [99, 99], [127.9, 127.9], [-128, 0], [5, 5],
];

function fingerprint(t: ReturnType<typeof createTerrainLayer>): string {
  const snap = t.snapshot();
  const heights = SAMPLE_POINTS.map(([x, z]) => t.sampleHeight(x, z).toFixed(9));
  return JSON.stringify({ snap, heights });
}

test("two independent instances with same seed+params produce identical snapshots", () => {
  const a = createTerrainLayer();
  const b = createTerrainLayer();
  a.setParams({ seed: 1337, biome: "alpine", mountainAggression: 7, elevation: 6 });
  b.setParams({ seed: 1337, biome: "alpine", mountainAggression: 7, elevation: 6 });
  a.generate();
  b.generate();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(
    SAMPLE_POINTS.map(([x, z]) => a.sampleHeight(x, z)),
    SAMPLE_POINTS.map(([x, z]) => b.sampleHeight(x, z)),
  );
});

test("repeated generation on one instance with same seed+params is identical", () => {
  const t = createTerrainLayer();
  t.setParams({ seed: 99, biome: "caribbean" });
  t.generate();
  const first = fingerprint(t);
  t.generate();
  const second = fingerprint(t);
  assert.equal(second, first);
});

test("generate() alone is idempotent and does not emit terrain-changed", () => {
  const t = createTerrainLayer();
  t.generate();
  let changed = 0;
  t.on("terrain-changed", () => changed++);
  t.generate();
  assert.equal(changed, 0);
});

test("changing seed produces a different terrain snapshot", () => {
  const a = createTerrainLayer();
  const b = createTerrainLayer();
  a.setParams({ seed: 1 });
  b.setParams({ seed: 2 });
  a.generate();
  b.generate();
  assert.notDeepEqual(a.snapshot(), b.snapshot());
});

test("determinism survives serialization round-trip", () => {
  const a = createTerrainLayer();
  a.setParams({ seed: 7, biome: "water", mountainAggression: 6, riverAggression: 4 });
  a.generate();
  const json = a.serialize();
  const b = createTerrainLayer();
  b.deserialize(json);
  assert.deepEqual(b.snapshot(), a.snapshot());
  for (const [x, z] of SAMPLE_POINTS) {
    assert.equal(b.sampleHeight(x, z), a.sampleHeight(x, z));
  }
});
