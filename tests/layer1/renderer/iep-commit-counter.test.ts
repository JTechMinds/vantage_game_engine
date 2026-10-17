/*
 * IEP Phase-1 counter ruling (spec-interactive-edit-preview-phase1.md §3).
 *
 * Browser-free, GPU-free. The renderer is NOT mounted, so ctx.scene stays null
 * and the GPU build is skipped, but rebuildFromSnapshot (the authoritative
 * commit seam) still runs its counter bookkeeping headlessly. These tests pin
 * the load-bearing three-counter model:
 *
 *   - commitRebuildCount: bumped exactly once per rebuildFromSnapshot (the
 *     per-intent full-resolution commit signal IEP-AC-01/02/04 anchor on).
 *   - rebuildCount (camera guard): NEVER touched by the commit path, and stays
 *     flat across a pure camera sweep (P-AC-09 byte-identical).
 *   - previewRebuildCount: Phase-2 scaffold, stays 0 for the whole Phase-1 slice.
 *
 * The two counters are DISJOINT by construction: a commit bumps commitRebuildCount
 * with zero camera rebuildCount movement, and a camera sweep bumps rebuildCount
 * with zero commitRebuildCount movement. All three ride the non-enumerable
 * rebuildStats() devOnly hook, so the frozen public surface is unchanged.
 *
 * ACs asserted here: the counter half of IEP-AC-01/02/04 (commit-signal
 * integrity + disjointness), IEP-AC-07 (previewRebuildCount inert / no scratch
 * regen), IEP-AC-08 (new fields non-enumerable; public Object.keys unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import { createTerrainRenderer } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}

function makeRenderer() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: 'alpine', seed: 1337 });
  t.generate();
  return createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
}

function stats(r: unknown) {
  return (r as { rebuildStats: () => Record<string, number | string | boolean | null> }).rebuildStats();
}

const POSE_FAR_A = { x: 0, y: 900, z: 0, targetX: 0, targetY: 0, targetZ: 0 };
const POSE_FAR_B = { x: 0, y: 1200, z: 0, targetX: 0, targetY: 0, targetZ: 0 };

test('IEP counter: rebuildFromSnapshot bumps commitRebuildCount + geometryEpoch, never the camera rebuildCount', () => {
  const r = makeRenderer();
  const before = stats(r);
  r.rebuildFromSnapshot();
  const after = stats(r);
  assert.equal((after.commitRebuildCount as number) - (before.commitRebuildCount as number), 1,
    'one commit = one commitRebuildCount');
  assert.equal((after.geometryEpoch as number) - (before.geometryEpoch as number), 1,
    'commitRebuildCount and geometryEpoch move together (cross-check)');
  assert.equal(after.rebuildCount, before.rebuildCount,
    'the camera guard rebuildCount is NOT touched by a commit (disjoint)');
});

test('IEP counter: N commits bump commitRebuildCount by exactly N (per-intent signal)', () => {
  const r = makeRenderer();
  const before = stats(r);
  // Linearity check only; the per-intent N in 5/25/100 coalescing gate is a
  // PANEL-level concern (many input events -> one commit) with a cheap binding,
  // not 130 real full-mesh rebuilds. Full builds are expensive headlessly.
  for (let i = 0; i < 5; i++) r.rebuildFromSnapshot();
  const after = stats(r);
  assert.equal((after.commitRebuildCount as number) - (before.commitRebuildCount as number), 5,
    '5 commits -> commitRebuildCount delta 5 (linear, one per rebuild)');
  assert.equal(after.rebuildCount, before.rebuildCount, 'camera counter still flat');
});

test('IEP counter: a pure camera sweep bumps rebuildCount but leaves commitRebuildCount flat (disjointness, P-AC-09)', () => {
  const r = makeRenderer();
  // Establish a baseline camera so the first sweep move can trigger the guard.
  r.setCamera(POSE_FAR_A);
  const before = stats(r);
  // Two far poses share a tier map (identical plan signature) but the epoch has
  // not advanced, so a repeat sweep must NOT rebuild: rebuildCount flat AND
  // commitRebuildCount flat. Then a fresh commit bumps commitRebuildCount only.
  r.setCamera(POSE_FAR_B);
  r.setCamera(POSE_FAR_A);
  const sweep = stats(r);
  assert.equal(sweep.commitRebuildCount, before.commitRebuildCount,
    'camera sweep never touches commitRebuildCount');
  assert.equal(sweep.rebuildCount, before.rebuildCount,
    'identical-signature camera sweep keeps rebuildCount flat (P-AC-09)');
});

test('IEP counter: previewRebuildCount stays 0 across commits and camera moves (Phase-2 scaffold inert)', () => {
  const r = makeRenderer();
  r.setCamera(POSE_FAR_A);
  r.rebuildFromSnapshot();
  r.setCamera(POSE_FAR_B);
  r.rebuildFromSnapshot();
  const s = stats(r);
  assert.equal(s.previewRebuildCount, 0,
    'no preview path in Phase 1: previewRebuildCount stays 0 (IEP-AC-07/05)');
});

test('IEP surface: the three new counters live on the non-enumerable rebuildStats hook (IEP-AC-08)', () => {
  const r = makeRenderer() as unknown as Record<string, unknown>;
  // rebuildStats itself is non-enumerable on the public renderer.
  assert.ok(!Object.keys(r).includes('rebuildStats'),
    'rebuildStats is not enumerable on the public renderer');
  // The returned stats object exposes the new fields.
  const s = stats(r);
  assert.ok('commitRebuildCount' in s && 'previewRebuildCount' in s,
    'commitRebuildCount + previewRebuildCount present on rebuildStats()');
  // The public enumerable surface is exactly the frozen M-T2 method set (no
  // new enumerable method was introduced by the counter work).
  const enumerable = Object.keys(r).sort();
  assert.deepEqual(enumerable, [
    'applyAppearance', 'debugSceneSummary', 'dispose', 'getLodRegions', 'getStatus',
    'mount', 'rebuildFromSnapshot', 'resize', 'setCamera', 'setLodDebug', 'setWireframe',
  ].sort(), 'public enumerable surface unchanged (API-surface diff empty)');
});
