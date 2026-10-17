/*
 * M-P0 deterministic LOD sweep + observability baseline (P-AC-05 / P-AC-07).
 *
 * Browser-free, GPU-free. planLodRegions + buildLodRegionMeshes are pure
 * functions of camera pose + world size (L1-AC-153), so the sweep runs under
 * the repo-local Node toolchain with no WebGL context and must be byte-identical
 * across runs. This is the artifact Sarah certifies against.
 *
 * ACs asserted here (spec-layer1-performance-mp0.md §5.2):
 *   - P-AC-07: the debug render-stats string exposes a drawn= headline and a
 *     secondary built= with culled=off in the no-cull state (drawn==built).
 *   - P-AC-05: the same pose list swept twice yields deep-equal reports.
 *   - Baseline bracket: the four profile regimes land within tolerance of
 *     docs/profile-layer1-default-view.md (512^2, alpine, seed 1337).
 *
 * M-P0 culling is OFF, so drawn is a BUILT PROXY; postCull=false is the honest
 * signal. M-P1 flips postCull=true and makes drawn < built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import { createTerrainRenderer } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';
import { runLodSweep, PRESET_POSES } from '../../../src/engine/layer1/renderer/lod-sweep.ts';
import { formatRenderStats, computeBuiltTriangles } from '../../../src/engine/layer1/renderer/wiring.ts';

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}

// Boot path matches the profile: 512^2 default world, alpine preset, seed 1337.
function makeProfileTerrain() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: 'alpine', seed: 1337 });
  t.generate();
  return t;
}

function builtFor(report, label) {
  const p = report.poses.find((r) => r.label === label);
  assert.ok(p, 'pose ' + label + ' missing from sweep report');
  return p.builtTriangles;
}

// === P-AC-05: determinism (same pose list swept twice => deep-equal) ===

test('M-P0 P-AC-05: LOD sweep is deterministic across runs (byte-identical reports)', () => {
  const terrain = makeProfileTerrain();
  const a = runLodSweep(terrain, PRESET_POSES);
  const b = runLodSweep(terrain, PRESET_POSES);
  assert.deepEqual(a, b, 'two sweeps of the same terrain + poses must be deep-equal');
  assert.deepEqual(a.poses.map((p) => p.label), ['default', 'seamcheck', 'dolly', 'allnear']);
});

// === Baseline bracket (establishes the ~11k -> ~520k regime after M-P3 floor) ===

test('M-P0 baseline: four profile regimes within tolerance (512^2 alpine seed 1337)', () => {
  const terrain = makeProfileTerrain();
  const report = runLodSweep(terrain, PRESET_POSES);
  const d = builtFor(report, 'default');
  const s = builtFor(report, 'seamcheck');
  const y = builtFor(report, 'dolly');
  const n = builtFor(report, 'allnear');
  assert.ok(d <= 20000, 'default must stay at/below the P-AC-02 20k ceiling (got ' + d + ')');
  assert.ok(s >= 45000 && s <= 52000, 'seamcheck bracket [45k,52k] broken (got ' + s + ')');
  assert.ok(y >= 94000 && y <= 102000, 'dolly bracket [94k,102k] broken (got ' + y + ')');
  assert.ok(n >= 515000 && n <= 530000, 'allnear bracket [515k,530k] (M-P3 non-overlap floor ~522242) broken (got ' + n + ')');
});

test('M-P1b postCull flag is true and drawn<=built with culling engaged', () => {
  const terrain = makeProfileTerrain();
  const report = runLodSweep(terrain, PRESET_POSES);
  for (const p of report.poses) {
    assert.equal(p.postCull, true, p.label + ' must report postCull=true once M-P1b culling is engaged');
    assert.ok(p.drawnTriangles <= p.builtTriangles, p.label + ': drawn must never exceed built (estimator invariant)');
  }
  // Culling does real work: at least one preset pose drops below built.
  assert.ok(report.poses.some((p) => p.drawnTriangles < p.builtTriangles), 'culling must reject off-screen geometry on some pose');
  // P-AC-02: default view stays at/below the 20k ceiling AND at/below built.
  const d = report.poses.find((p) => p.label === 'default');
  assert.ok(d.drawnTriangles <= 20000, 'P-AC-02: default drawn must stay <= 20k (got ' + d.drawnTriangles + ')');
  assert.ok(d.drawnTriangles <= d.builtTriangles, 'P-AC-02: default drawn <= built');
  // maxDrawn now tracks the max DRAWN (post-cull), not the built sum.
  assert.equal(report.maxDrawn, Math.max(...report.poses.map((p) => p.drawnTriangles)), 'maxDrawn tracks max drawn once culling is on');
});

test('M-P0 allnear forces the whole grid to stride-1 near tier', () => {
  const terrain = makeProfileTerrain();
  const report = runLodSweep(terrain, PRESET_POSES);
  const all = report.poses.find((p) => p.label === 'allnear');
  assert.equal(all.tiers.near, 64, 'all-near must place all 64 regions (8x8 exact partition, M-P3) in the near tier');
  assert.equal(all.tiers.mid + all.tiers.far + all.tiers.skybox, 0, 'all-near leaves no mid/far/skybox regions');
});

test('M-P0 runLodSweep guards when the heightfield is not generated', () => {
  const terrain = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  assert.throws(
    () => runLodSweep(terrain, PRESET_POSES),
    /generated/,
    'runLodSweep must throw a clear generated-required error before planning',
  );
});

// === P-AC-07: HUD/debug string = drawn headline, built secondary, culled=off ===

// The renderer only carries a scene/camera once mounted (WebGL); the CI path
// never mounts, so debugSceneSummary() returns its no-scene guard. The P-AC-07
// copy is produced by the pure formatRenderStats() the summary delegates to
// (spec §5.2 allows asserting on the debugSceneSummaryInternal-shaped string).
test('M-P0 P-AC-07: formatRenderStats emits drawn= headline + built= secondary + culled=off', () => {
  const summary = formatRenderStats({ cam: { x: 317, y: 290, z: 0 }, meshes: 81, built: 14052, drawn: 14052, culled: false, bbox: 'bbox-x' });
  assert.match(summary, /cam\(/, 'cam(...) token must remain for evidence greps');
  assert.match(summary, /meshes=\d+/, 'meshes= token must remain');
  assert.match(summary, /bbox=/, 'bbox= token must remain');
  assert.match(summary, /drawn=\d+/, 'drawn= headline required');
  assert.match(summary, /built=\d+/, 'built= secondary required');
  assert.match(summary, /culled=off/, 'culled=off required while culling is off');
  const drawn = Number(summary.match(/drawn=(\d+)/)[1]);
  const built = Number(summary.match(/built=(\d+)/)[1]);
  assert.equal(drawn, built, 'drawn must equal built in the M-P0 no-cull state');
});

test('M-P0 P-AC-07: formatRenderStats flips culled=on when culling engaged (M-P1 forward-compat)', () => {
  const summary = formatRenderStats({ cam: { x: 0, y: 0, z: 0 }, meshes: 81, built: 14052, drawn: 9000, culled: true, bbox: 'b' });
  assert.match(summary, /culled=on/, 'culled=on once culling engaged');
  assert.match(summary, /drawn=9000 built=14052/, 'drawn < built once culling removes off-screen geometry');
});

test('M-P0 P-AC-07: unmounted renderer debugSceneSummary returns a graceful guard (no crash)', () => {
  const terrain = makeProfileTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  const summary = renderer.debugSceneSummary();
  assert.ok(/no-scene|no-terrain|drawn=/.test(summary), 'debugSceneSummary must return a guard or stats string, got: ' + summary);
  renderer.dispose();
});

test('M-P0 computeBuiltTriangles returns 0 with no terrain group (pre-mount guard)', () => {
  assert.equal(computeBuiltTriangles({ terrainGroup: null }), 0);
});

test('M-P0 devOnly renderStats hook is non-enumerable and reports drawn/built/culled', () => {
  const terrain = makeProfileTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  assert.ok(!Object.keys(renderer).includes('renderStats'), 'renderStats must not be enumerable on the public surface');
  assert.ok(!Object.keys(renderer).includes('lodSweep'), 'lodSweep must not be enumerable on the public surface');
  const stats = renderer.renderStats();
  assert.equal(stats.culled, false, 'renderStats.culled must be false in M-P0');
  assert.equal(stats.drawn, stats.built, 'renderStats drawn==built while culling off (no WebGL)');
  renderer.dispose();
});

test('M-P0 devOnly lodSweep hook runs the preset sweep on the renderer terrain', () => {
  const terrain = makeProfileTerrain();
  const renderer = createTerrainRenderer({ terrain, canvas: makeCanvas() });
  const report = renderer.lodSweep();
  assert.deepEqual(report.poses.map((p) => p.label), ['default', 'seamcheck', 'dolly', 'allnear']);
  assert.equal(builtFor(report, 'default'), builtFor(runLodSweep(terrain, PRESET_POSES), 'default'));
  renderer.dispose();
});
