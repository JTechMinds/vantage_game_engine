import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

test("each numeric knob rejects values outside its documented range", () => {
  const t = createTerrainLayer();
  const cases: [string, number][] = [
    ["timeOfDay", 24],
    ["timeOfDay", -0.5],
    ["mountainAggression", -1],
    ["mountainAggression", 10.5],
    ["valleyAggression", -0.1],
    ["valleyAggression", 11],
    ["riverAggression", -2],
    ["riverAggression", 10.01],
    ["elevation", 11],
    ["elevation", -1],
    ["windIntensity", 10.5],
    ["windIntensity", -0.5],
  ];
  for (const [field, value] of cases) {
    const r = t.validate({ [field]: value });
    assert.equal(r.valid, false, `${field}=${value} should be invalid`);
    assert.equal(r.errors[0]!.code, "range");
    assert.equal(r.errors[0]!.field, field);
    assert.equal(r.errors[0]!.value, value);
  }
});

test("boundary values 0 and 10 are valid; timeOfDay fractional valid, 24 invalid", () => {
  const t = createTerrainLayer();
  assert.equal(t.validate({ mountainAggression: 0, valleyAggression: 10, riverAggression: 5.5, elevation: 0 }).valid, true);
  assert.equal(t.validate({ timeOfDay: 12.75 }).valid, true);
  assert.equal(t.validate({ timeOfDay: 24 }).valid, false);
});

test("non-finite numbers, wrong types, and unknown enum values rejected", () => {
  const t = createTerrainLayer();
  assert.equal(t.validate({ elevation: Number.NaN }).valid, false);
  assert.equal(t.validate({ elevation: Number.POSITIVE_INFINITY }).valid, false);
  assert.equal(t.validate({ elevation: "5" as unknown as number }).valid, false);
  assert.equal(t.validate({ elevation: null as unknown as number }).valid, false);
  assert.equal(t.validate({ biome: "tundra" as never }).valid, false);
  assert.equal(t.validate({ biome: 3 as never }).valid, false);
  assert.equal(t.validate({ wireframe: "yes" as unknown as boolean }).valid, false);
  assert.equal(t.validate({ wireframe: 1 as unknown as boolean }).valid, false);
});

test("seed rejects non-integers and unsafe integers", () => {
  const t = createTerrainLayer();
  assert.equal(t.validate({ seed: 1.5 }).valid, false);
  assert.equal(t.validate({ seed: Number.MAX_SAFE_INTEGER + 10 }).valid, false);
  assert.equal(t.validate({ seed: -2147483648 }).valid, true);
  assert.equal(t.validate({ seed: 0 }).valid, true);
});

test("unknown top-level fields in patches are rejected with unknown-field", () => {
  const t = createTerrainLayer();
  const r = t.validate({ seed: 7, humidity: 0.5 } as never);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === "unknown-field" && e.field === "humidity"));
});

test("windDirection is normalized into [0, 360)", () => {
  const t = createTerrainLayer();
  t.setParams({ windDirection: 540 });
  assert.equal(t.getParams().windDirection, 180);
  t.setParams({ windDirection: -90 });
  assert.equal(t.getParams().windDirection, 270);
  t.setParams({ windDirection: 359.5 });
  assert.equal(t.getParams().windDirection, 359.5);
});

test("valid partial patches apply atomically and leave other fields intact", () => {
  const t = createTerrainLayer();
  const before = t.getParams();
  t.setParams({ mountainAggression: 8 });
  const after = t.getParams();
  assert.equal(after.mountainAggression, 8);
  assert.equal(after.seed, before.seed);
  assert.equal(after.biome, before.biome);
  assert.equal(after.timeOfDay, before.timeOfDay);
});

test("failed patch leaves prior terrain parameters and heightfield unchanged", () => {
  const t = createTerrainLayer();
  t.generate();
  const before = { ...t.getParams() };
  const h0 = t.sampleHeight(10, 10);
  const err = t.validate({ mountainAggression: 99, valleyAggression: 9 });
  assert.equal(err.valid, false);
  t.setParams({ mountainAggression: 99, valleyAggression: 9 });
  const after = { ...t.getParams() };
  assert.deepEqual(after, before, "no field of a failed patch may apply");
  assert.equal(t.sampleHeight(10, 10), h0, "heightfield must not change on failed patch");
});

test("failed validation populates telemetry.lastError with structured payload", () => {
  const t = createTerrainLayer();
  t.setParams({ elevation: 42 });
  const last = t.telemetry().lastError;
  assert.ok(last);
  assert.equal(last!.field, "elevation");
  assert.equal(last!.code, "range");
});
