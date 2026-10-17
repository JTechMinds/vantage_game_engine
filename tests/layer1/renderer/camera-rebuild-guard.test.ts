/*
 * M-P1a camera-change rebuild guard (spec-layer1-performance-mp1a.md §5).
 *
 * Browser-free, GPU-free. The renderer is NOT mounted (no WebGL context), so
 * ctx.scene stays null and buildLodRegionMeshes/uploadRegionMeshes are skipped
 * on the headless path. The rebuild GUARD, however, runs before that scene
 * guard: ctx.rebuildCount is bumped exactly when the plan signature or the
 * geometry epoch changes, and ctx.renderCount is bumped on every renderOnce.
 * Those two non-enumerable devOnly counters (renderer.rebuildStats()) are the
 * observable the ACs assert on — they falsify the 0-FPS cause directly:
 * renders track camera calls, rebuilds collapse to <=1 per distinct plan.
 *
 * ACs asserted here:
 *   PA-1a-01 short-circuit: an identical-pose burst rebuilds once, renders N.
 *   PA-1a-02 rebuild-on-change: a tier-crossing pose rebuilds; repeats do not.
 *   PA-1a-03 epoch invalidation: rebuildFromSnapshot forces one rebuild at an
 *          identical pose (the stale-geometry / false-short-circuit guard, R1).
 *   PA-1a-04 counters unperturbed: the M-P0 sweep report is still deterministic.
 *   PA-1a-05 determinism: two renderers replay the identical rebuild trace.
 *   PA-1a-07 no public widening: rebuildStats is non-enumerable (renderer-status
 *          asserts the closed method set; here we assert the key is hidden).
 *   PA-1a-08 coalescing (soft, code-contract form per §5): the demo shell routes
 *          every pointer/wheel move through one cameraDirty flag consumed in the
 *          rAF tick(); the raw handlers never call renderer.setCamera directly.
 *
 * The crux (R2 / §3.1): two DIFFERENT camera distances that leave every region
 * in the same tier must share a plan signature — the continuous distance is
 * deliberately excluded so a sub-tier pan rebuilds nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import { createTerrainRenderer } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';
import { runLodSweep, PRESET_POSES } from '../../../src/engine/layer1/renderer/lod-sweep.ts';
import { planLodRegions } from '../../../src/engine/layer1/renderer/lod.ts';
import { planSignature } from '../../../src/engine/layer1/renderer/wiring.ts';

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}

function makeProfileTerrain() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: 'alpine', seed: 1337 });
  t.generate();
  return t;
}

function makeRenderer() {
  return createTerrainRenderer({ terrain: makeProfileTerrain(), canvas: makeCanvas() });
}

function stats(renderer: any) {
  return renderer.rebuildStats();
}

// Two very distant poses: every region is beyond maxFarM, so both plan to the
// SAME tier map (all skybox) despite different camera distances. A close pose
// has a mixed tier map. These exercise the distance-exclusion crux.
const POSE_FAR_A = { x: 0, y: 900, z: 0, targetX: 0, targetY: 0, targetZ: 0 };
const POSE_FAR_B = { x: 0, y: 1200, z: 0, targetX: 0, targetY: 0, targetZ: 0 };
const POSE_CLOSE = { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 };

function planFor(pose: any) {
  return planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: pose });
}

// === Crux premise (R2): distance is excluded from the signature ===

test('M-P1a crux: two different-distance poses with identical tiers share a signature', () => {
  const sa = planSignature(planFor(POSE_FAR_A));
  const sb = planSignature(planFor(POSE_FAR_B));
  const sc = planSignature(planFor(POSE_CLOSE));
  assert.equal(sa, sb, 'far A and far B keep every region skybox -> identical signature despite distance');
  assert.notEqual(sa, sc, 'a close pose changes the tier map -> different signature');
});

// === PA-1a-01: short-circuit (the 0-FPS fix) ===

test('M-P1a PA-1a-01: an identical-pose burst rebuilds once but renders N times', () => {
  const r = makeRenderer();
  const before = stats(r);
  assert.equal(before.rebuildCount, 0, 'a fresh renderer has not built yet');
  const N = 12;
  for (let i = 0; i < N; i++) r.setCamera(POSE_CLOSE);
  const after = stats(r);
  assert.equal(after.rebuildCount - before.rebuildCount, 1, 'only the first pose builds; the rest short-circuit');
  assert.equal(after.renderCount - before.renderCount, N, 'every setCamera still re-rendered the view (renderOnce ran)');
});

// === PA-1a-01b: sub-tier pan (different coords, same tiers) rebuilds nothing ===

test('M-P1a PA-1a-01b: a sub-tier pan (different distance, same tiers) skips the rebuild', () => {
  const r = makeRenderer();
  r.setCamera(POSE_FAR_A); // builds
  const afterFirst = stats(r).rebuildCount;
  r.setCamera(POSE_FAR_B); // different distance, same tiers -> must short-circuit
  assert.equal(stats(r).rebuildCount, afterFirst, 'a same-tier pan rebuilds nothing (distance excluded)');
});

// === PA-1a-02 (M-P5 strong form): tier-crossing moves rebuild NOTHING ===
//
// M-P5 pre-builds every resident tier ONCE at load/epoch, so a tier-crossing
// camera move is a pure tier-selection + visible flip: rebuildCount stays FLAT
// for ANY camera movement (spec 3.2, strong-form P-AC-09). This replaces the
// pre-M-P5 expectation that a tier-crossing move forced one rebuild.

test('M-P5 PA-1a-02: a tier-crossing move rebuilds NOTHING (flat rebuild counter)', () => {
  const r = makeRenderer();
  r.setCamera(POSE_FAR_A); // cold path: one pre-build event
  const afterCold = stats(r).rebuildCount;
  assert.equal(afterCold, 1, 'the first pose performs exactly one full pre-build');
  r.setCamera(POSE_CLOSE); // crosses into a mixed tier map -> NO rebuild (M-P5)
  assert.equal(stats(r).rebuildCount, afterCold, 'a tier-crossing move rebuilds nothing (tiers pre-built; P-AC-09 strong form)');
  r.setCamera(POSE_FAR_A); // cross back -> still no rebuild
  assert.equal(stats(r).rebuildCount, afterCold, 'crossing back out of a mixed tier set rebuilds nothing');
  r.setCamera(POSE_CLOSE);
  assert.equal(stats(r).rebuildCount, afterCold, 'any further tier change keeps the counter flat');
  // P-AC-13: after the cold pre-build every resident tier is present (3 x regionCount).
  const st = stats(r);
  assert.equal(st.preBuiltComplete, true, 'spec 3.1: pre-build marked complete after the cold pass');
  assert.equal(st.residentMeshCount, 0, 'headless (unmounted) path builds no GPU meshes; residency proven on the mounted path');
});

// === PA-1a-03: epoch invalidation (R1 stale-geometry guard) ===

test('M-P1a PA-1a-03: rebuildFromSnapshot forces one rebuild at an identical pose', () => {
  const r = makeRenderer();
  r.setCamera(POSE_CLOSE);
  const before = stats(r);
  assert.equal(before.renderCount > 0, true, 'sanity: a camera call rendered');
  r.rebuildFromSnapshot(); // authoritative geometry change -> bumps geometryEpoch
  assert.equal(stats(r).geometryEpoch, before.geometryEpoch + 1, 'rebuildFromSnapshot bumps the geometry epoch');
  r.setCamera(POSE_CLOSE); // SAME pose, SAME signature, but epoch moved -> must rebuild
  const after = stats(r);
  assert.equal(after.rebuildCount, before.rebuildCount + 1, 'epoch mismatch forces a rebuild despite an unchanged signature');
});

// === PA-1a-04: M-P0 sweep counters unperturbed ===

test('M-P1a PA-1a-04: the M-P0 sweep report stays deterministic (counters unperturbed)', () => {
  const terrain = makeProfileTerrain();
  const r1 = runLodSweep(terrain, PRESET_POSES);
  const r2 = runLodSweep(terrain, PRESET_POSES);
  assert.deepEqual(r1, r2, 'sweep report is byte-identical across runs');
  const all = r1.poses.find((p: any) => p.label === 'allnear');
  assert.ok(all.builtTriangles >= 515000 && all.builtTriangles <= 530000, 'allnear still in the M-P3 baseline bracket [515k,530k]');
});

// === PA-1a-05: determinism of the guard logic ===

test('M-P1a PA-1a-05: two renderers replay an identical rebuild/render trace', () => {
  const sequence = [POSE_CLOSE, POSE_CLOSE, POSE_FAR_A, POSE_FAR_B, POSE_CLOSE, POSE_FAR_A];
  const trace = (r: any) => {
    const out: Array<{ r: number; d: number }> = [];
    let prev = stats(r);
    for (const pose of sequence) {
      r.setCamera(pose);
      const cur = stats(r);
      out.push({ r: cur.rebuildCount - prev.rebuildCount, d: cur.renderCount - prev.renderCount });
      prev = cur;
    }
    return out;
  };
  assert.deepEqual(trace(makeRenderer()), trace(makeRenderer()), 'pure guard logic -> identical per-pose rebuild/render deltas');
});

// === PA-1a-07: rebuild counter does not widen the public surface ===

test('M-P1a PA-1a-07: rebuildStats is non-enumerable (public surface unchanged)', () => {
  const r = makeRenderer();
  const keys = Object.keys(r);
  assert.equal(keys.includes('rebuildStats'), false, 'rebuildStats must not appear in the enumerable public surface');
  assert.equal(typeof (r as any).rebuildStats, 'function', 'yet it stays reachable as a devOnly diagnostic');
});

// === PA-1a-08: demo coalescing (soft — code-contract form per §5) ===

test('M-P1a PA-1a-08: demo routes every camera move through one cameraDirty flag in tick()', () => {
  const demoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo/terrain-demo.ts');
  const src = readFileSync(demoPath, 'utf8');
  // cameraFromOrbit must flag dirty and NOT call setCamera directly.
  const start = src.indexOf('function cameraFromOrbit');
  assert.ok(start >= 0, 'cameraFromOrbit present');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.equal(body.includes('cameraDirty = true'), true, 'cameraFromOrbit sets the coalescing flag');
  assert.equal(body.includes('renderer.setCamera'), false, 'cameraFromOrbit must not call setCamera directly');
  // The rAF tick must consume the flag with exactly one setCamera call.
  const tickStart = src.indexOf('requestAnimationFrame(function tick');
  assert.ok(tickStart >= 0, 'tick loop present');
  const tickBody = src.slice(tickStart, src.indexOf('\n});', tickStart));
  assert.equal(tickBody.includes('if (cameraDirty)'), true, 'tick consumes the cameraDirty flag');
  const calls = (tickBody.match(/renderer\.setCamera/g) || []).length;
  assert.equal(calls, 1, 'tick issues exactly one setCamera per frame (<=1 rebuild/render per frame)');
});
