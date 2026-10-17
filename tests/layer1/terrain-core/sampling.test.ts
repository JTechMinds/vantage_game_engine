import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

test("sampleHeight returns finite numbers for all in-world coordinates after generation", () => {
  const t = createTerrainLayer();
  t.generate();
  for (let i = 0; i < 200; i++) {
    const x = (i / 199) * 512 - 256;
    const z = ((i * 7) % 199) / 199 * 512 - 256;
    const h = t.sampleHeight(x, z);
    assert.ok(Number.isFinite(h), `finite required at ${x},${z}`);
  }
});

test("sampleHeight is deterministic for the same instance and coordinates", () => {
  const t = createTerrainLayer();
  t.generate();
  const a = t.sampleHeight(13.5, -44.25);
  const b = t.sampleHeight(13.5, -44.25);
  assert.equal(a, b);
});

test("sampleHeight does not mutate terrain state", () => {
  const t = createTerrainLayer();
  t.generate();
  const before = JSON.stringify(t.snapshot());
  t.sampleHeight(0, 0);
  t.sampleHeight(-100, 100);
  assert.equal(JSON.stringify(t.snapshot()), before);
});

test("sampleHeight interpolates between grid samples rather than snapping to vertices", () => {
  // cell = 512/511 ~ 1.00196. Two adjacent vertex columns differ; the midpoint
  // must lie strictly between them, proving interpolation.
  const t = createTerrainLayer();
  t.setParams({ seed: 3, biome: "alpine", mountainAggression: 9 });
  t.generate();
  const cell = 512 / 511;
  // Step along +x from the west edge looking for a neighboring pair with a gap.
  let found = false;
  for (let k = 0; k < 100 && !found; k++) {
    const x0 = -256 + k * cell;
    const x1 = x0 + cell;
    const z = -40;
    const h0 = t.sampleHeight(x0, z);
    const h1 = t.sampleHeight(x1, z);
    if (Math.abs(h1 - h0) > 0.05) {
      const mid = t.sampleHeight(x0 + cell / 2, z);
      const lo = Math.min(h0, h1);
      const hi = Math.max(h0, h1);
      assert.ok(mid > lo && mid < hi, `mid ${mid} must be strictly between ${h0} and ${h1}`);
      found = true;
    }
  }
  assert.ok(found, "expected at least one neighboring vertex pair with a height gap");
});

test("outside-bounds sampling is stable, finite, clamped to the nearest edge", () => {
  const t = createTerrainLayer();
  t.generate();
  const edgeWest = t.sampleHeight(-256, 0);
  assert.equal(t.sampleHeight(-10000, 0), edgeWest);
  assert.equal(t.sampleHeight(-256 - 1e-9, 0), edgeWest, "policy: clamp to edge height");
  const edgeEast = t.sampleHeight(256, 0);
  assert.equal(t.sampleHeight(10000, 0), edgeEast);
  const corner = t.sampleHeight(-256, -256);
  assert.equal(t.sampleHeight(-999, -999), corner);
  assert.ok(Number.isFinite(t.sampleHeight(1e12, -1e12)));
  // Repeated calls are stable.
  assert.equal(t.sampleHeight(-500, 500), t.sampleHeight(-500, 500));
});

test("sampleHeight returns the exact vertex height at grid vertices", () => {
  const t = createTerrainLayer();
  t.generate();
  const cell = 512 / 511;
  const x = -256 + 10 * cell;
  const z = -256 + 20 * cell;
  const atVertex = t.sampleHeight(x, z);
  const near = t.sampleHeight(x + 1e-12, z);
  assert.ok(Math.abs(atVertex - near) < 1e-6);
});

test("sampleHeight before generation throws a structured NOT_GENERATED error", () => {
  const t = createTerrainLayer();
  assert.throws(() => t.sampleHeight(0, 0), (err: Error & { code?: string }) => err.code === "NOT_GENERATED");
});
