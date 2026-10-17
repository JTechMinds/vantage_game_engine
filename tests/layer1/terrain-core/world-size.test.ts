import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTerrainLayer,
  DEFAULT_WORLD_SIZE,
  WORLD_SIZE_PRESETS,
} from "../../../src/engine/layer1/terrain/index.ts";

/**
 * World-size coverage (spec: Grid Model + Serialization Boundary).
 * Default acceptance world is 512x512; 256 is the fast small-test preset,
 * 1024 the stretch preset. Payload worldSize is authoritative on restore.
 */

test("default world size is 512x512 in public state and payload", () => {
  assert.deepEqual({ ...DEFAULT_WORLD_SIZE }, { vertices: 512, meters: 512 });
  const t = createTerrainLayer();
  t.generate();
  assert.deepEqual(t.snapshot().worldSize, { vertices: 512, meters: 512 });
  const doc = JSON.parse(t.serialize());
  assert.deepEqual(doc.worldSize, { vertices: 512, meters: 512 });
});

test("WORLD_SIZE_PRESETS lists 256/512/1024", () => {
  assert.deepEqual(WORLD_SIZE_PRESETS.map((p) => p.vertices), [256, 512, 1024]);
});

test("determinism holds at the 512 default", () => {
  const a = createTerrainLayer();
  const b = createTerrainLayer();
  a.setParams({ seed: 2026, biome: "highlands", mountainAggression: 6 });
  b.setParams({ seed: 2026, biome: "highlands", mountainAggression: 6 });
  a.generate();
  b.generate();
  assert.deepEqual(a.snapshot(), b.snapshot());
  const pts: [number, number][] = [[-250, -250], [-37.5, 12], [0, 0], [42, -63], [249.9, 249.9]];
  assert.deepEqual(
    pts.map(([x, z]) => a.sampleHeight(x, z)),
    pts.map(([x, z]) => b.sampleHeight(x, z)),
  );
});

test("serialization round-trip at 512 restores snapshot and seam heights", () => {
  const a = createTerrainLayer();
  a.setParams({ seed: 777, biome: "alpine", elevation: 8 });
  a.generate();
  const b = createTerrainLayer();
  b.deserialize(a.serialize());
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.equal(b.snapshot().worldSize.vertices, 512);
  const pts: [number, number][] = [[0, 0], [-200, 150], [250, 250]];
  for (const [x, z] of pts) {
    assert.equal(b.sampleHeight(x, z), a.sampleHeight(x, z), `seam at ${x},${z}`);
  }
});

test("256 small-test preset remains available via options", () => {
  const t = createTerrainLayer({ worldSize: { vertices: 256, meters: 256 } });
  t.generate();
  assert.deepEqual(t.snapshot().worldSize, { vertices: 256, meters: 256 });
});

// --- deserialize worldSize contract (spec: Serialization Boundary) ---

function payloadWith(mutate: (doc: Record<string, unknown>) => void): string {
  const t = createTerrainLayer();
  t.setParams({ seed: 55 });
  t.generate();
  const doc = JSON.parse(t.serialize()) as Record<string, unknown>;
  mutate(doc);
  return JSON.stringify(doc);
}

test("successful deserialize yields snapshot().worldSize equal to payload worldSize", () => {
  // M-T3 config panel depends on this: displayed size == running size.
  const json = payloadWith(() => {});
  const expected = (JSON.parse(json) as { worldSize: unknown }).worldSize;
  const t = createTerrainLayer();
  t.deserialize(json);
  assert.deepEqual(t.snapshot().worldSize, expected);
});

test("deserialize applies a differing payload worldSize atomically (256)", () => {
  const json = payloadWith((doc) => {
    doc.worldSize = { vertices: 256, meters: 256 };
  });
  const t = createTerrainLayer(); // default 512
  t.generate();
  t.deserialize(json);
  assert.deepEqual(t.snapshot().worldSize, { vertices: 256, meters: 256 });
  assert.equal(t.snapshot().generated, true, "regenerated at payload size");
  assert.equal(t.telemetry().triangleCount, 255 * 255 * 2, "heightfield is the payload grid");
});

test("deserialize applies a differing payload worldSize atomically (1024)", () => {
  const json = payloadWith((doc) => {
    doc.worldSize = { vertices: 1024, meters: 1024 };
  });
  const t = createTerrainLayer();
  t.generate();
  t.deserialize(json);
  assert.deepEqual(t.snapshot().worldSize, { vertices: 1024, meters: 1024 });
  assert.equal(t.snapshot().generated, true);
});

test("missing payload worldSize is rejected and prior state is unchanged", () => {
  const t = createTerrainLayer();
  t.setParams({ seed: 31 });
  t.generate();
  const before = JSON.stringify(t.snapshot());
  const json = payloadWith((doc) => {
    delete doc.worldSize;
  });
  assert.throws(
    () => t.deserialize(json),
    (err: Error & { code?: string; field?: string }) =>
      err.code === "DESERIALIZE_INVALID_WORLD_SIZE" && err.field === "worldSize",
  );
  assert.equal(JSON.stringify(t.snapshot()), before, "prior state unchanged");
  assert.equal(t.telemetry().lastError?.code, "DESERIALIZE_INVALID_WORLD_SIZE");
});

test("non-finite payload worldSize components are rejected", () => {
  const t = createTerrainLayer();
  t.generate();
  const before = JSON.stringify(t.snapshot());
  const badPayloads: unknown[] = [
    { vertices: Number.NaN, meters: 512 },
    { vertices: 512, meters: Number.POSITIVE_INFINITY },
    { vertices: 512.5, meters: 512 },
  ];
  for (const bad of badPayloads) {
    const json = payloadWith((doc) => {
      doc.worldSize = bad;
    });
    assert.throws(
      () => t.deserialize(json),
      (err: Error & { code?: string }) => err.code === "DESERIALIZE_INVALID_WORLD_SIZE",
      `must reject ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(JSON.stringify(t.snapshot()), before, "prior state unchanged");
});

test("payload worldSize outside supported presets is rejected", () => {
  const t = createTerrainLayer();
  t.generate();
  const before = JSON.stringify(t.snapshot());
  const badPayloads: unknown[] = [
    { vertices: 384, meters: 384 },
    { vertices: 128, meters: 128 },
    { vertices: 2048, meters: 2048 },
  ];
  for (const bad of badPayloads) {
    const json = payloadWith((doc) => {
      doc.worldSize = bad;
    });
    assert.throws(
      () => t.deserialize(json),
      (err: Error & { code?: string }) => err.code === "DESERIALIZE_INVALID_WORLD_SIZE",
      `must reject ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(JSON.stringify(t.snapshot()), before, "prior state unchanged");
});

test("non-object payload worldSize is rejected", () => {
  const t = createTerrainLayer();
  t.generate();
  const before = JSON.stringify(t.snapshot());
  for (const bad of ["512", null, 512, [512, 512], undefined]) {
    const json = payloadWith((doc) => {
      if (bad === undefined) delete doc.worldSize;
      else doc.worldSize = bad;
    });
    assert.throws(
      () => t.deserialize(json),
      (err: Error & { code?: string }) => err.code === "DESERIALIZE_INVALID_WORLD_SIZE",
      `must reject ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(JSON.stringify(t.snapshot()), before, "prior state unchanged");
});
