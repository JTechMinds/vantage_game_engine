import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";

test("generation-started and generation-complete fire around generate() with payloads", () => {
  const t = createTerrainLayer();
  const order: string[] = [];
  let startedPayload: { seed: number; biome: string; worldSize: { vertices: number } } | null = null;
  let completePayload: { snapshot: { generated: boolean }; telemetry: { triangleCount: number } } | null = null;
  t.on("generation-started", (p) => {
    order.push("started");
    startedPayload = p;
  });
  t.on("generation-complete", (p) => {
    order.push("complete");
    completePayload = p;
  });
  t.generate();
  assert.deepEqual(order, ["started", "complete"]);
  assert.equal(startedPayload!.biome, "highlands");
  assert.equal(startedPayload!.worldSize.vertices, 512);
  assert.equal(completePayload!.snapshot.generated, true);
  assert.ok(completePayload!.telemetry.triangleCount > 0);
});

test("terrain-changed fires on setParams with normalized params payload", () => {
  const t = createTerrainLayer();
  const seen: { source: string; seed: number; biome: string }[] = [];
  t.on("terrain-changed", (p) => seen.push({ source: p.source, seed: p.seed, biome: p.biome }));
  t.setParams({ biome: "desert" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.source, "setParams");
  assert.equal(seen[0]!.biome, "desert");
});

test("terrain-changed fires for renderer-only fields without regeneration", () => {
  const t = createTerrainLayer();
  t.generate();
  let genStarted = 0;
  let changed = 0;
  t.on("generation-started", () => genStarted++);
  t.on("terrain-changed", () => changed++);
  t.setParams({ timeOfDay: 22, windIntensity: 8 });
  assert.equal(changed, 1);
  assert.equal(genStarted, 0, "renderer-facing fields must not rebuild geometry");
});

test("failed setParams emits error event and no terrain-changed", () => {
  const t = createTerrainLayer();
  const errors: { code: string; field?: string }[] = [];
  let changed = 0;
  t.on("error", (p) => errors.push({ code: p.code, field: p.field }));
  t.on("terrain-changed", () => changed++);
  t.setParams({ elevation: -3 });
  assert.equal(changed, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.field, "elevation");
});

test("randomize and reset emit terrain-changed with matching sources", () => {
  const t = createTerrainLayer();
  const sources: string[] = [];
  t.on("terrain-changed", (p) => sources.push(p.source));
  t.randomize();
  t.reset();
  assert.deepEqual(sources, ["randomize", "reset"]);
});

test("unsubscribe stops delivery; handler exceptions are isolated", () => {
  const t = createTerrainLayer();
  let hits = 0;
  const off = t.on("terrain-changed", () => hits++);
  t.on("terrain-changed", () => {
    throw new Error("bad handler");
  });
  t.setParams({ biome: "water" });
  assert.equal(hits, 1, "other listeners still run despite the throwing handler");
  off();
  t.setParams({ biome: "desert" });
  assert.equal(hits, 1, "unsubscribed listener must not fire");
});

test("wireframe toggle emits terrain-changed without regeneration", () => {
  const t = createTerrainLayer();
  let gen = 0;
  t.on("generation-started", () => gen++);
  t.setWireframe(true);
  assert.equal(t.getParams().wireframe, true);
  assert.equal(gen, 0);
});
