/*
 * M-P2 near-budget ceiling + final geometry caps (spec-layer1-performance-mp2.md §5).
 *
 * Browser-free, GPU-free. The ceiling is a pure function of (terrain, plan,
 * camera, margin, vertexCount), so every AC runs under the repo-local Node
 * toolchain with no WebGL context and must be reproducible across runs.
 *
 * The predicted per-region triangle count + bounding sphere come from the SAME
 * shared regionMeshTopology + sphereFromPositions + estimateDrawnTriangles path
 * the mesh builder and the M-P1b sweep/HUD use, so the ceiling prediction equals
 * the reported drawn (M-P2-AC-01 / §6.6). The sweep's builtTriangles stays the
 * BASE (uncapped) world geometry so the ceiling is proven to cut SUBMITTED work,
 * not the world (P-AC-03).
 *
 * ACs asserted here:
 *   AC-01 near-dominant ceiling does real work (off > cap, on <= cap, demote>0,
 *         closest near region stays stride 1, built floor unchanged).
 *   AC-02 absolute worst-case sweep stays <= 250k scaled.
 *   AC-03 non-near-dominant mid pose demotes to <= 150k.
 *   AC-04 default boot pose does not fire and stays <= 20k.
 *   AC-05 ceiling-induced mixed-stride boundary stays crack-free; no skybox relief.
 *   AC-06 determinism: identical sweeps + identical demotion set.
 *   AC-07 larger-world (1024^2) caps scale by vertex-count ratio and are respected.
 *   AC-08 profile (VIS-stand-in) poses are unperturbed by the ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import {
  planLodRegions,
  buildLodRegionMeshes,
  edgeVertexKeys,
  regionBounds,
  effectiveStrideForRegion,
  defaultLodConfig,
} from '../../../src/engine/layer1/renderer/lod.ts';
import {
  applyNearBudgetCeiling,
  predictDrawn,
  scaleCaps,
  scaleCap,
  PERF_CAPS,
  DEFAULT_VERTEX_COUNT,
} from '../../../src/engine/layer1/renderer/budget-ceiling.ts';
import { makeFrustumCamera, buildFrustum } from '../../../src/engine/layer1/renderer/frustum-cull.ts';
import { runLodSweep, PRESET_POSES } from '../../../src/engine/layer1/renderer/lod-sweep.ts';

// Boot path matches the profile: 512^2 default world, alpine preset, seed 1337.
function makeProfileTerrain(vertices = 512, meters = 512) {
  const t = createTerrainLayer({ worldSize: { vertices, meters } });
  t.setParams({ biome: 'alpine', seed: 1337 });
  t.generate();
  return t;
}

// Margin the sweep/HUD use (one region span), so ceiling prediction == reported.
function marginFor(vertexGrid: number, worldMeters: number): number {
  const regionSpan = Math.max(1, Math.floor((vertexGrid - 1) / 8));
  return regionSpan * (worldMeters / (vertexGrid - 1));
}

function poseResult(report, label) {
  const p = report.poses.find((r) => r.label === label);
  assert.ok(p, 'pose ' + label + ' missing from sweep report');
  return p;
}

const ALLNEAR = PRESET_POSES.find((p) => p.label === 'allnear');
assert.ok(ALLNEAR, 'allnear preset must exist');

// === AC-01: near-dominant ceiling does real work ===
test('M-P2-AC-01: allnear near-dominant pose is capped (off > cap, on <= cap, demote > 0)', () => {
  const terrain = makeProfileTerrain();
  const caps = scaleCaps(512 * 512);
  const off = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: false });
  const on = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: true });

  const offAll = poseResult(off, 'allnear');
  const onAll = poseResult(on, 'allnear');

  // Ceiling-off proves the uncapped near regime exceeds the near-dominant cap.
  assert.ok(offAll.drawnTriangles > caps.nearDominant, 'ceiling-off allnear must exceed the near-dominant cap (got ' + offAll.drawnTriangles + ')');
  // Ceiling-on brings it under the cap and actually demotes regions.
  assert.ok(onAll.drawnTriangles <= caps.nearDominant, 'ceiling-on allnear drawn must be <= 200000 (got ' + onAll.drawnTriangles + ')');
  assert.equal(onAll.capClass, 'near-dominant', 'allnear must classify near-dominant');
  assert.equal(onAll.nearDominant, true, 'allnear nearDominant flag');
  assert.ok((onAll.demotionCount ?? 0) > 0, 'a pose over the cap must demote at least one region');
  assert.equal(onAll.budgetUnmet, false, 'the near ceiling must reach the cap without cascade exhaustion');
  // Built floor unchanged: the ceiling cuts submitted work, not the world.
  assert.ok(onAll.builtTriangles >= 515000 && onAll.builtTriangles <= 530000, 'allnear built must stay near the ~522k M-P3 non-overlap floor (got ' + onAll.builtTriangles + ')');
  assert.equal(onAll.builtTriangles, offAll.builtTriangles, 'built must be identical with the ceiling on vs off (world unchanged)');
});

test('M-P2-AC-01b: farthest-near-first preserves the closest near region at stride 1', () => {
  const terrain = makeProfileTerrain();
  const margin = marginFor(512, 512);
  const base = planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: ALLNEAR.camera, config: ALLNEAR.configOverride });
  const frustum = buildFrustum(makeFrustumCamera(ALLNEAR.camera));
  const res = applyNearBudgetCeiling(base, { terrain, frustum, marginM: margin, vertexCount: 512 * 512 });
  const r = base.regionSpan;
  const near = base.regions.filter((rg) => rg.tier === 'near').sort((a, b) => a.centerDistance - b.centerDistance);
  assert.ok(near.length > 0, 'allnear must have near regions');
  // The closest near region keeps full detail even though the ceiling fired.
  assert.equal(effectiveStrideForRegion(res.plan, near[0], r), 1, 'closest near region must remain stride 1');
  // The farthest near regions are the ones demoted (farthest-first ordering).
  assert.ok(res.plan.budgetStride && res.plan.budgetStride.size > 0, 'ceiling must demote some far near regions');
});

// === AC-02: absolute worst-case sweep stays under the absolute cap ===
test('M-P2-AC-02: pathological camera sweep respects the absolute 250k cap', () => {
  const terrain = makeProfileTerrain();
  const margin = marginFor(512, 512);
  const caps = scaleCaps(512 * 512);
  const poses = [
    { label: 'horizon', camera: { x: 0, y: 5, z: 250, targetX: 0, targetY: 5, targetZ: -250 } },
    { label: 'down', camera: { x: 0, y: 450, z: 0, targetX: 0, targetY: 0, targetZ: 0 } },
    { label: 'wide', camera: { x: 0, y: 380, z: 400, targetX: 0, targetY: 0, targetZ: 0 } },
    { label: 'tight', camera: { x: 0, y: 25, z: 60, targetX: 0, targetY: 25, targetZ: -40 } },
    { label: 'allnear', camera: ALLNEAR.camera, config: ALLNEAR.configOverride },
    { label: 'dolly', camera: { x: 0, y: 40, z: 120, targetX: 0, targetY: 60, targetZ: 0 } },
  ];
  let maxDrawn = 0;
  let worst = '';
  for (const p of poses) {
    const base = planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: p.camera, config: p.config ?? {} });
    const frustum = buildFrustum(makeFrustumCamera(p.camera));
    const res = applyNearBudgetCeiling(base, { terrain, frustum, marginM: margin, vertexCount: 512 * 512 });
    const drawn = predictDrawn(terrain, res.plan, frustum, margin).total;
    assert.equal(res.unmet, false, p.label + ' must not exhaust the cascade');
    assert.ok(drawn <= caps.absolute, p.label + ' drawn must be <= 250000 (got ' + drawn + ')');
    if (drawn > maxDrawn) { maxDrawn = drawn; worst = p.label; }
  }
  assert.ok(maxDrawn <= caps.absolute, 'worst-case max drawn must be <= 250000 (got ' + maxDrawn + ' at ' + worst + ')');
});

// M-P2-AC-03: non-near-dominant over-cap pose demotes via the mid cascade.
//
// M-P3 note: removing the region-grid over-build drops the whole-grid all-mid
// pose ~18% (the 1.23x densification is gone), so it no longer clears the
// frozen 150k mid cap by geometry. The frozen cap table and the ceiling's
// mid->far cascade are unchanged (M-P2 caps are Jordan-frozen; this is NOT a
// cap retarget). To keep the cascade's behavioral contract exercised against
// the LOWER M-P3 floor, we drive it with the module's test-only `caps` override
// (the same hook the ceiling-off comparison uses, budget-ceiling §3.1/§6.6),
// set below the pose's uncapped drawn. The production PERF_CAPS.mid value is
// still asserted verbatim in the scaleCap test.
test('M-P2-AC-03: non-near-dominant pose over the mid cap demotes via mid cascade', () => {
  const terrain = makeProfileTerrain();
  const margin = marginFor(512, 512);
  const caps = scaleCaps(512 * 512);
  // All-mid, top-down: sees the whole grid, no near tier (so NOT near-dominant).
  const cam = { x: 0, y: 520, z: 0.01, targetX: 0, targetY: 0, targetZ: 0 };
  const base = planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: cam, config: { nearM: 30, maxMidM: 5000, maxFarM: 5000 } });
  const frustum = buildFrustum(makeFrustumCamera(cam));
  const unc = predictDrawn(terrain, base, frustum, margin);
  assert.equal(unc.nearRegionCount, 0, 'test pose must have no near regions (non-near-dominant)');
  // Self-calibrating test cap below the uncapped drawn so the cascade must fire
  // against the post-M-P3 floor (production caps untouched).
  const testMid = Math.floor(unc.total * 0.6);
  assert.ok(unc.total > testMid, 'test pose must start above the test mid cap (got ' + unc.total + ')');
  const res = applyNearBudgetCeiling(base, { terrain, frustum, marginM: margin, vertexCount: 512 * 512, caps: { ...caps, mid: testMid } });
  assert.equal(res.nearDominant, false, 'all-mid pose must not classify near-dominant');
  assert.equal(res.capClass, 'mid', 'non-near-dominant pose uses the mid cap');
  const capped = predictDrawn(terrain, res.plan, frustum, margin).total;
  assert.ok(capped <= testMid, 'ceiling must bring a mid pose to <= the active mid cap (got ' + capped + ' vs ' + testMid + ')');
  assert.ok(res.demotionCount > 0, 'a mid pose over the cap must demote (cascade mid->far)');
  assert.equal(res.unmet, false, 'mid cascade must reach the cap');
});

// === AC-04: default boot pose must not fire ===
test('M-P2-AC-04: default boot pose stays <= 20k with zero demotions (no regression)', () => {
  const terrain = makeProfileTerrain();
  const report = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: true });
  const d = poseResult(report, 'default');
  const caps = scaleCaps(512 * 512);
  assert.ok(d.drawnTriangles <= PERF_CAPS.default, 'default drawn must be <= 20000 (got ' + d.drawnTriangles + ')');
  assert.equal(d.demotionCount, 0, 'default pose must not fire the ceiling (zero demotions)');
  assert.equal(d.nearDominant, false, 'default pose must not classify near-dominant');
  assert.ok(d.drawnTriangles <= d.builtTriangles, 'default drawn <= built');
  assert.ok(caps.default === 20000, 'default cap constant must remain 20000');
});

// === AC-05: seam integrity for ceiling-induced transitions ===
test('M-P2-AC-05: demoted near region adjacent to an un-demoted near region stays crack-free + no skybox relief', () => {
  const terrain = makeProfileTerrain();
  const margin = marginFor(512, 512);
  const base = planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: ALLNEAR.camera, config: ALLNEAR.configOverride });
  const frustum = buildFrustum(makeFrustumCamera(ALLNEAR.camera));
  const res = applyNearBudgetCeiling(base, { terrain, frustum, marginM: margin, vertexCount: 512 * 512 });
  const plan = res.plan;
  const meshes = buildLodRegionMeshes(terrain, { plan });
  const r = plan.regionSpan;
  const byKey = new Map<string, (typeof meshes)[number]>();
  for (const m of meshes) byKey.set(m.region.cx + ',' + m.region.cz, m);

  // No tier mutation and no skybox demotion as budget relief.
  for (const rg of plan.regions) {
    assert.equal(rg.tier, 'near', 'ceiling must not change tiers (allnear stays all-near)');
    assert.ok(effectiveStrideForRegion(plan, rg, r) <= 4, 'no region may demote past the far floor (stride 4)');
  }

  // Find a shared edge between a demoted near region and an un-demoted near
  // region (mixed-stride boundary) and assert their shared vertices are equal.
  let mixedFound = false;
  for (const rg of plan.regions) {
    const selfStride = effectiveStrideForRegion(plan, rg, r);
    const neighbors: Array<[number, number, 'right' | 'left', 'left' | 'right' | 'bottom' | 'top', 'top' | 'bottom']> = [
      [rg.cx + 1, rg.cz, 'right', 'left', null],
      [rg.cx - 1, rg.cz, 'left', 'right', null],
      [rg.cx, rg.cz + 1, 'bottom', 'top', null],
      [rg.cx, rg.cz - 1, 'top', 'bottom', null],
    ].filter((n) => n[0] !== null);
    for (const [nx, nz, selfEdge, nEdge] of neighbors as Array<[number, number, 'right' | 'left' | 'bottom' | 'top', 'left' | 'right' | 'top' | 'bottom']>) {
      const nb = byKey.get(nx + ',' + nz);
      if (!nb) continue;
      if (effectiveStrideForRegion(plan, nb.region, r) === selfStride) continue; // same stride, trivially fine
      mixedFound = true;
      const a = edgeVertexKeys(byKey.get(rg.cx + ',' + rg.cz)!.buffers, selfEdge, regionBounds(plan, rg.cx, rg.cz));
      const b = edgeVertexKeys(nb.buffers, nEdge, regionBounds(plan, nx, nz));
      assert.deepEqual(a, b, 'mixed-stride boundary at region (' + rg.cx + ',' + rg.cz + ') ' + selfEdge + ' must keep identical shared vertices');
    }
  }
  assert.ok(mixedFound, 'a demotion must create at least one mixed-stride near/near boundary to prove stitching holds');
});

// === AC-06: determinism with the ceiling enabled ===
test('M-P2-AC-06: two identical sweeps are deep-equal (tier + budget + drawn)', () => {
  const terrain = makeProfileTerrain();
  const a = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: true });
  const b = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: true });
  assert.deepEqual(a, b, 'two ceiling-on sweeps of the same terrain + poses must be deep-equal');
});

test('M-P2-AC-06b: identical demotion set + budget-stride state across runs', () => {
  const terrain = makeProfileTerrain();
  const margin = marginFor(512, 512);
  const base = planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: ALLNEAR.camera, config: ALLNEAR.configOverride });
  const frustum = buildFrustum(makeFrustumCamera(ALLNEAR.camera));
  const runOnce = () => {
    const res = applyNearBudgetCeiling(base, { terrain, frustum, marginM: margin, vertexCount: 512 * 512 });
    const strideEntries = [...(res.plan.budgetStride ?? new Map<string, number>())].sort((x, y) => x[0] < y[0] ? -1 : 1);
    return { strideEntries, predicted: res.predictedDrawn, demotions: res.demotionCount };
  };
  assert.deepEqual(runOnce(), runOnce(), 'the demotion set and predicted drawn must be identical across runs');
});

// === AC-07: larger-world cap scaling ===
test('M-P2-AC-07: 1024^2 caps scale by vertex-count ratio and are respected', () => {
  // Ratio guard (pure) first: 1024^2 is 4x the default vertex count.
  const scaled = scaleCaps(1024 * 1024);
  assert.equal(scaled.nearDominant, scaleCap(PERF_CAPS.nearDominant, 1024 * 1024));
  assert.equal(scaled.nearDominant, PERF_CAPS.nearDominant * 4, 'near-dominant cap scales 4x at 1024^2');
  assert.equal(scaled.absolute, PERF_CAPS.absolute * 4, 'absolute cap scales 4x at 1024^2');
  assert.equal(scaleCap(PERF_CAPS.mid, DEFAULT_VERTEX_COUNT), PERF_CAPS.mid, 'default grid keeps the exact base cap');
  // Same vertex count => same cap (larger world at 512^2 does not get a bigger cap).
  assert.equal(scaleCap(PERF_CAPS.mid, 512 * 512), 150000, 'cap is a function of vertex count, not world meters');

  // CI ratio guard: a 1024^2 allnear sweep uses the scaled near-dominant cap.
  const terrain = makeProfileTerrain(1024, 1024);
  const report = runLodSweep(terrain, [ALLNEAR]);
  const all = poseResult(report, 'allnear');
  assert.equal(all.activeCap, scaled.nearDominant, '1024^2 allnear must run against the scaled near-dominant cap (' + scaled.nearDominant + ')');
  assert.ok(all.drawnTriangles <= scaled.nearDominant, '1024^2 allnear drawn must respect the scaled cap (got ' + all.drawnTriangles + ')');
});

// === AC-08: profile (VIS-stand-in) poses unperturbed by the ceiling ===
test('M-P2-AC-08: non-near-dominant profile poses are unchanged by the ceiling', () => {
  const terrain = makeProfileTerrain();
  const off = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: false });
  const on = runLodSweep(terrain, PRESET_POSES, { ceilingEnabled: true });
  for (const label of ['default', 'seamcheck', 'dolly']) {
    const o = poseResult(off, label);
    const n = poseResult(on, label);
    assert.equal(n.nearDominant, false, label + ' must not classify near-dominant');
    assert.equal(n.demotionCount, 0, label + ' ceiling must not demote (VIS geometry unperturbed)');
    assert.equal(n.drawnTriangles, o.drawnTriangles, label + ' drawn must be identical ceiling-on vs -off');
    assert.equal(n.builtTriangles, o.builtTriangles, label + ' built must be identical ceiling-on vs -off');
  }
});
