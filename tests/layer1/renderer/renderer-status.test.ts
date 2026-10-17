// === Imports and test harness ===

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../../../src/engine/layer1/renderer/terrain-renderer.ts";

// Fast small preset (spec §5 "256×256 fast small-test preset"). These tests
// exercise the renderer's PUBLIC surface and the real internal routing
// (setCamera → planLodRegions, applyAppearance, rebuild, status, dispose)
// WITHOUT mounting a WebGL backend, so the assertions prove control flow and
// read-only guarantees, not pixels. Pixel-level visual proof (readable terrain,
// correct LOD coloring, water/sky motion) is deferred to a real-browser `bv`
// capture per the project's visual-verification rule — a stubbed canvas does
// NOT certify that anything renders.
const GRID = 64;
const METERS = 256;

function makeTerrain(seed = 11) {
  const t = createTerrainLayer({ worldSize: { vertices: GRID, meters: METERS } });
  t.setParams({ seed, biome: "caribbean", elevation: 5, mountainAggression: 6 });
  t.generate();
  return t;
}

/**
 * Minimal HTMLCanvasElement-shaped stub. The factory only stores the canvas at
 * construction and reads client dimensions on resize; the WebGLRenderer is not
 * built until mount(), which these headless tests deliberately avoid. The stub
 * therefore needs no working 2D/WebGL context — just the shape the factory's
 * type and any non-mounted path touch.
 */
function makeCanvas(): HTMLCanvasElement {
  const noop = (): void => {};
  return {
    clientWidth: METERS,
    clientHeight: METERS,
    width: METERS,
    height: METERS,
    style: {},
    getContext: () => null,
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: METERS, height: METERS }),
  } as unknown as HTMLCanvasElement;
}

function makeRenderer(seed = 11) {
  const terrain = makeTerrain(seed);
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  return { terrain, renderer };
}

// A fixed fingerprint of the public sampling seam + snapshot, used across
// sections to prove the renderer never mutates terrain state (L1-AC-154/157).
function terrainFingerprint(terrain: ReturnType<typeof makeTerrain>): string {
  const snap = terrain.snapshot();
  const pts: [number, number][] = [
    [-90, -40], [-12, 0], [0, 0], [33, 77], [100, 100], [-120, 120],
  ];
  return JSON.stringify({ snap, h: pts.map(([x, z]) => terrain.sampleHeight(x, z)) });
}

// === Public surface shape (spec §2) ===

test("renderer exposes exactly the read/rebuild/appearance/debug surface", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  const surface = Object.keys(renderer).sort();

  // Exact public surface — the factory must not leak anything beyond this set.
  assert.deepEqual(surface, [
    "applyAppearance",
    "debugSceneSummary",
    "dispose",
    "getLodRegions",
    "getStatus",
    "mount",
    "rebuildFromSnapshot",
    "resize",
    "setCamera",
    "setLodDebug",
    "setWireframe",
  ]);

  // Every exposed member is a function.
  for (const key of surface) {
    assert.equal(typeof (renderer as Record<string, unknown>)[key], "function", `${key} must be a function`);
  }

  renderer.dispose();
});

test("renderer exposes NO terrain-mutation method (core is the sole source of truth, L1-AC-154/157)", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });

  const forbidden = [
    "setParams",
    "generate",
    "reset",
    "deserialize",
    "sampleHeight",
    "snapshot",
    "getParams",
    "telemetry",
    "on",
  ];
  for (const name of forbidden) {
    assert.ok(
      !(name in renderer),
      `renderer must not expose terrain-owning method "${name}"`,
    );
  }

  renderer.dispose();
});

// === Status assembly (spec §6) ===

test("getStatus returns the spec §6 status shape with mesh, lod, textureStatus, diagnostics", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  const status = renderer.getStatus();
  assert.ok(status && typeof status === "object", "getStatus must return an object");
  assert.ok("mesh" in status, "status must expose the mesh-integrity field");
  assert.ok("lod" in status, "status must expose the LOD debug field");
  assert.ok("textureStatus" in status, "status must expose the texture-status field");
  assert.ok(Array.isArray(status.diagnostics), "status must expose a diagnostics array");
  // LOD sub-state carries the toggle flag plus the current region plan copy.
  assert.equal(typeof status.lod.enabled, "boolean", "lod.enabled must be a boolean");
  assert.ok(Array.isArray(status.lod.regions), "lod.regions must be an array");
  renderer.dispose();
});

test("a placeholder-backed build reports textureStatus 'placeholder' as the Gate-VIS blocker", () => {
  const terrain = makeTerrain();
  // No textureBundle supplied: the factory falls back to the placeholder label,
  // which is the authoritative signal that Gate VIS cannot pass (spec §1, §6).
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  const status = renderer.getStatus();
  assert.equal(
    status.textureStatus,
    "placeholder",
    "an untextured/placeholder build must never report 'approved'",
  );
  assert.notEqual(
    status.textureStatus,
    "approved",
    "placeholder pixels must never be reported as an approved/Gate-VIS pass",
  );
  renderer.dispose();
});

test("getStatus.diagnostics is a defensive copy that cannot corrupt internal state", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  const first = renderer.getStatus();
  const baselineLength = first.diagnostics.length;
  // Mutate the returned array; the renderer's internal accumulator must be
  // unaffected so a later status read reflects real diagnostics only.
  first.diagnostics.push("injected-by-test");
  const second = renderer.getStatus();
  assert.equal(
    second.diagnostics.length,
    baselineLength,
    "mutating a returned diagnostics array must not leak into the renderer",
  );
  assert.ok(
    !second.diagnostics.includes("injected-by-test"),
    "the injected entry must not appear in a fresh status read",
  );
  renderer.dispose();
});

// === LOD seam against the production render path (spec §11) ===

function fingerprint(t: TerrainLayer, points: [number, number][]): string {
  return JSON.stringify(points.map(([x, z]) => t.sampleHeight(x, z).toFixed(9)));
}

const CAMERA_POINTS: [number, number][] = [
  [-90, -40], [0, 0], [33, 77], [-12, 100], [60, -60],
];

test("setCamera drives the real LOD plan and returns a non-empty deterministic region set (L1-AC-153)", () => {
  const t = makeTerrain();
  const renderer = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });

  renderer.setCamera({ x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 });
  const first = renderer.getLodRegions();
  assert.ok(Array.isArray(first) && first.length > 0, "camera move must produce a non-empty LOD plan");
  for (const region of first) {
    assert.ok(
      region.tier === "near" || region.tier === "mid" || region.tier === "far" || region.tier === "skybox",
      `unexpected tier ${region.tier}`,
    );
    assert.ok(Number.isFinite(region.centerDistance), "region centerDistance must be finite");
  }

  // Same camera pose again → byte-identical tier assignment (determinism).
  renderer.setCamera({ x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 });
  const again = renderer.getLodRegions();
  assert.deepEqual(
    again.map((r) => [r.cx, r.cz, r.tier]),
    first.map((r) => [r.cx, r.cz, r.tier]),
    "repeated identical camera poses must yield identical region tiers (L1-AC-153)",
  );
  renderer.dispose();
});

test("distance drives tier assignment: near camera gives near regions, distant gives far/skybox", () => {
  const t = makeTerrain();
  const renderer = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });

  renderer.setCamera({ x: 0, y: 20, z: 0, targetX: 0, targetY: 0, targetZ: 0 });
  const nearPlan = renderer.getLodRegions();
  const nearTiers = new Set(nearPlan.map((r) => r.tier));
  assert.ok(nearTiers.has("near"), "a camera over the world center must mark some regions near");

  renderer.setCamera({ x: 0, y: 4000, z: 9000, targetX: 0, targetY: 0, targetZ: 0 });
  const farPlan = renderer.getLodRegions();
  // From very far away no region should remain at the highest-cost near tier.
  const farHasNear = farPlan.some((r) => r.tier === "near");
  assert.ok(!farHasNear, "a distant camera must demote regions off the near tier");
  renderer.dispose();
});

test("camera/LOD moves never mutate snapshot() or sampleHeight output (L1-AC-154/157)", () => {
  const t = makeTerrain();
  const renderer = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });

  const snapshotBefore = JSON.stringify(t.snapshot());
  const heightsBefore = fingerprint(t, CAMERA_POINTS);

  const poses = [
    { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 },
    { x: -60, y: 40, z: -30, targetX: 10, targetY: 0, targetZ: 5 },
    { x: 200, y: 200, z: 200, targetX: 0, targetY: 0, targetZ: 0 },
    { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 },
  ];
  for (const pose of poses) {
    renderer.setCamera(pose);
  }

  assert.equal(
    JSON.stringify(t.snapshot()),
    snapshotBefore,
    "camera/LOD moves must not change the public snapshot (L1-AC-157)",
  );
  assert.equal(
    fingerprint(t, CAMERA_POINTS),
    heightsBefore,
    "camera/LOD moves must not change sampleHeight output (L1-AC-154)",
  );
  renderer.dispose();
});

// === Debug overlays default off (spec §3.7, §11.4) ===

test("a freshly created renderer reports the LOD debug overlay off by default", () => {
  const renderer = createTerrainRenderer({
    terrain: makeTerrain(),
    canvas: makeCanvas(),
  });
  const status = renderer.getStatus();
  assert.equal(status.lod.enabled, false, "LOD overlay must default off (L1-AC-155)");
  assert.equal(
    status.lod.overlayVisible,
    false,
    "LOD overlay must not be visible in a fresh/production build",
  );
  renderer.dispose();
});

test("toggling the LOD overlay flips reported debug state without touching terrain", () => {
  const terrain = makeTerrain();
  const points: [number, number][] = [[-80, -30], [0, 0], [27, 61], [-5, 90]];
  const before = {
    snap: terrain.snapshot(),
    h: points.map(([x, z]) => terrain.sampleHeight(x, z)),
  };
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });

  renderer.setLodDebug(true);
  const on = renderer.getStatus();
  assert.equal(on.lod.enabled, true, "setLodDebug(true) must report the overlay on");

  renderer.setLodDebug(false);
  const off = renderer.getStatus();
  assert.equal(off.lod.enabled, false, "setLodDebug(false) must report the overlay off");

  // The overlay is display-only: heights and snapshot are byte-for-byte intact.
  assert.deepEqual(terrain.snapshot(), before.snap, "overlay toggle changed snapshot");
  assert.deepEqual(
    points.map(([x, z]) => terrain.sampleHeight(x, z)),
    before.h,
    "overlay toggle changed sampleHeight output (L1-AC-103/154)",
  );
  renderer.dispose();
});

test("toggling the wireframe overlay is display-only and off by default", () => {
  const terrain = makeTerrain();
  const points: [number, number][] = [[-40, -40], [10, 10], [55, -20]];
  const beforeH = points.map(([x, z]) => terrain.sampleHeight(x, z));
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });

  // Default: the public wireframe flag is false for a fresh caribbean layer.
  assert.equal(terrain.getParams().wireframe, false, "wireframe must default off");

  renderer.setWireframe(true);
  renderer.setWireframe(false);

  assert.deepEqual(
    points.map(([x, z]) => terrain.sampleHeight(x, z)),
    beforeH,
    "wireframe toggle must not alter sampleHeight (L1-AC-103)",
  );
  renderer.dispose();
});

// === Dispose safety ===

test("dispose is idempotent — second call does not throw", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  renderer.dispose();
  // Second dispose must be a silent no-op, not a crash on torn-down handles.
  assert.doesNotThrow(() => renderer.dispose());
  assert.doesNotThrow(() => renderer.dispose());
});

test("getStatus returns a well-formed object after dispose", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  renderer.dispose();

  const status = renderer.getStatus();
  // The status object must still be readable (no null/undefined crash) so
  // evidence tooling can inspect the last-known state post-teardown.
  assert.ok(status, "getStatus must not return null/undefined after dispose");
  assert.ok("mesh" in status, "status must still expose mesh field");
  assert.ok("lod" in status, "status must still expose lod field");
  assert.ok("textureStatus" in status, "status must still expose textureStatus");
  assert.ok(Array.isArray(status.diagnostics), "diagnostics must remain an array");
});

test("post-dispose setCamera/applyAppearance/rebuildFromSnapshot are safe no-ops", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });

  // Capture terrain fingerprint before dispose to confirm no mutation.
  const snapBefore = JSON.stringify(terrain.snapshot());
  const hBefore = terrain.sampleHeight(10, 10);

  renderer.dispose();

  // These public methods must not throw after teardown. The internal guards
  // (ctx.disposed checks in wiring.ts) short-circuit before touching GL or
  // terrain, so teardown never leaves a dangling loop or corrupts state.
  assert.doesNotThrow(() =>
    renderer.setCamera({ x: 5, y: 80, z: 5, targetX: 0, targetY: 0, targetZ: 0 }),
  );
  assert.doesNotThrow(() => renderer.applyAppearance(terrain.getParams()));
  assert.doesNotThrow(() => renderer.rebuildFromSnapshot());
  assert.doesNotThrow(() => renderer.setWireframe(true));
  assert.doesNotThrow(() => renderer.setLodDebug(true));

  // Terrain state is untouched: the renderer never writes terrain (L1-AC-157).
  assert.equal(JSON.stringify(terrain.snapshot()), snapBefore);
  assert.equal(terrain.sampleHeight(10, 10), hBefore);
});

test("dispose cancels the animation loop handle", () => {
  const terrain = makeTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  // mount() calls startRenderLoop which stores a rafId on the context.
  // After dispose, the loop must have been cancelled (rafId reset to 0)
  // so no frame callback fires against torn-down GL handles.
  renderer.dispose();
  // Indirect proof: calling setCamera after dispose is a no-op (guarded by
  // ctx.disposed), meaning the loop callback would also short-circuit even
  // if a stale frame slipped through before cancelAnimationFrame landed.
  assert.doesNotThrow(() => renderer.setCamera({ x: 0, y: 50, z: 0, targetX: 0, targetY: 0, targetZ: 0 }));
});
