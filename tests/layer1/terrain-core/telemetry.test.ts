import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

test("telemetry exposes generationTimeMs, triangleCount, textureCount, lastError", () => {
  const t = createTerrainLayer();
  t.generate();
  const tel = t.telemetry();
  assert.ok(tel.generationTimeMs >= 0);
  // 511x511 quads * 2 triangles = 522242 for the default 512 grid.
  assert.equal(tel.triangleCount, 511 * 511 * 2);
  assert.ok(tel.textureCount > 0);
  assert.equal(tel.lastError, null);
});

test("triangle count reflects generated topology at a custom world size", () => {
  const t = createTerrainLayer({ worldSize: { vertices: 64, meters: 64 } });
  t.generate();
  assert.equal(t.telemetry().triangleCount, 63 * 63 * 2);
  assert.equal(t.snapshot().triangleCount, 63 * 63 * 2);
});

test("textureCount differs by biome material profile and is metadata-only", () => {
  const alpine = createTerrainLayer();
  alpine.setParams({ biome: "alpine" });
  const caribbean = createTerrainLayer();
  caribbean.setParams({ biome: "caribbean" });
  assert.ok(alpine.telemetry().textureCount > 0);
  assert.ok(caribbean.telemetry().textureCount > alpine.telemetry().textureCount);
});

test("lastError is populated after a failed validation and after a failed load", () => {
  const t = createTerrainLayer();
  t.setParams({ seed: 1.5 });
  const err = t.telemetry().lastError;
  assert.ok(err);
  assert.equal(err!.field, "seed");

  assert.throws(() => t.deserialize("[oops"));
  const err2 = t.telemetry().lastError;
  assert.ok(err2);
  assert.equal(err2!.code, "SERIALIZE_INVALID_JSON");
});

test("telemetry snapshot is a copy; mutation cannot corrupt accumulator", () => {
  const t = createTerrainLayer();
  t.generate();
  const tel = t.telemetry() as { triangleCount: number };
  tel.triangleCount = -1;
  assert.notEqual(t.telemetry().triangleCount, -1);
});

test("generation-complete payload carries matching telemetry", () => {
  const t = createTerrainLayer();
  let payloadTri = 0;
  t.on("generation-complete", (p) => {
    payloadTri = p.telemetry.triangleCount;
  });
  t.generate();
  assert.equal(payloadTri, t.telemetry().triangleCount);
});
