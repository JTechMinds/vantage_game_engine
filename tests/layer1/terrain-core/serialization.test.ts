import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

test("serialize produces valid JSON with schema version, layer, seed, biome, knobs, timestamp", () => {
  const t = createTerrainLayer();
  t.setParams({ seed: 77, biome: "alpine", mountainAggression: 8, windDirection: 270 });
  t.generate();
  const doc = JSON.parse(t.saveConfig("alpine-run-1"));
  assert.equal(doc.schemaVersion, "1.0.0");
  assert.equal(doc.layer, "layer1-terrain");
  assert.equal(doc.seed, 77);
  assert.equal(doc.biome, "alpine");
  assert.equal(doc.displayName, "alpine-run-1");
  assert.ok(typeof doc.createdAt === "string" && !Number.isNaN(Date.parse(doc.createdAt)));
  for (const key of ["timeOfDay", "mountainAggression", "valleyAggression", "riverAggression", "elevation", "windIntensity", "windDirection", "wireframe"]) {
    assert.ok(key in doc.parameters, `parameters.${key} must be serialized`);
  }
  assert.equal(doc.parameters.mountainAggression, 8);
});

test("round-trip restores identical parameters, snapshot, and sampleHeight results", () => {
  const a = createTerrainLayer();
  a.setParams({ seed: 1234, biome: "caribbean", mountainAggression: 5, wireframe: true, timeOfDay: 6.5 });
  a.generate();
  const json = a.serialize();
  const b = createTerrainLayer();
  b.deserialize(json);
  assert.deepEqual({ ...b.getParams() }, { ...a.getParams() });
  assert.deepEqual(b.snapshot(), a.snapshot());
  for (const [x, z] of [[0, 0], [-64, 33], [100, -100]] as [number, number][]) {
    assert.equal(b.sampleHeight(x, z), a.sampleHeight(x, z));
  }
});

test("malformed JSON fails with a clear structured error and leaves state intact", () => {
  const t = createTerrainLayer();
  t.setParams({ seed: 5 });
  t.generate();
  const before = { ...t.getParams() };
  assert.throws(
    () => t.deserialize("{ not json"),
    (err: Error & { code?: string }) => err.code === "SERIALIZE_INVALID_JSON",
  );
  assert.deepEqual({ ...t.getParams() }, before, "failed load must not apply parameters");
});

test("missing required fields fail with field-level errors", () => {
  const t = createTerrainLayer();
  const good = JSON.parse(t.serialize());
  delete good.parameters;
  assert.throws(() => t.deserialize(JSON.stringify(good)), (err: Error & { code?: string; field?: string }) =>
    err.code === "DESERIALIZE_MISSING_FIELD" && err.field === "parameters");
  const noVersion = JSON.parse(t.serialize());
  delete noVersion.schemaVersion;
  assert.throws(() => t.deserialize(JSON.stringify(noVersion)), (err: Error & { code?: string }) =>
    err.code === "DESERIALIZE_MISSING_FIELD");
});

test("unsupported major schemaVersion is rejected with a clear error", () => {
  const t = createTerrainLayer();
  const doc = JSON.parse(t.serialize());
  doc.schemaVersion = "2.0.0";
  assert.throws(() => t.deserialize(JSON.stringify(doc)), (err: Error & { code?: string }) =>
    err.code === "DESERIALIZE_UNSUPPORTED_VERSION");
});

test("unknown future fields are tolerated without crashing", () => {
  const t = createTerrainLayer();
  t.setParams({ seed: 9, biome: "desert" });
  t.generate();
  const doc = JSON.parse(t.serialize());
  doc.futureTectonics = { enabled: true, plates: [1, 2, 3] };
  doc.parameters.humidity = 0.4;
  const json = JSON.stringify(doc);
  const b = createTerrainLayer();
  b.deserialize(json);
  assert.equal(b.getParams().seed, 9);
  assert.equal(b.getParams().biome, "desert");
});

test("invalid parameter values inside JSON produce structured parameter errors", () => {
  const t = createTerrainLayer();
  const doc = JSON.parse(t.serialize());
  doc.parameters.mountainAggression = 999;
  assert.throws(() => t.deserialize(JSON.stringify(doc)), (err: Error & { code?: string }) =>
    err.code === "DESERIALIZE_INVALID_PARAMETER");
});

test("deserialize emits terrain-changed and generation events", () => {
  const t = createTerrainLayer();
  const json = t.serialize();
  const events: string[] = [];
  t.on("generation-started", () => events.push("gen-start"));
  t.on("generation-complete", () => events.push("gen-done"));
  t.on("terrain-changed", () => events.push("changed"));
  t.deserialize(json);
  assert.deepEqual(events, ["gen-start", "gen-done", "changed"]);
});
