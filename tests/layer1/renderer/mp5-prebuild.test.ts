/*
 * M-P5 pre-build-all-LOD-tiers (spec-layer1-performance-mp5.md §5).
 *
 * Browser-free, GPU-free. Asserts the build-once architecture and the fixed
 * shared-edge perimeter lattice WITHOUT a WebGL context:
 *   PM5-01  stitching preserved across all six {1,2,4} runtime tier pairs.
 *   P-AC-13 all tiers resident at first frame (3 x regionCount meshes baked).
 *   PM5-08  every region perimeter baked on the fine lattice P (stride 1) for
 *           BOTH near and far (positive fixed-lattice assertion).
 *   P-AC-09 rebuild counter FLAT across a camera sweep (strong form).
 *   P-AC-14 load-time bake measurement recorded (provisional, not a gate).
 *   P-AC-03/04 drawn assertions unchanged: drawn reflects the SELECTED tier.
 *   determinism: two bakes of the same plan are byte-identical.
 *
 * The stitching/residency/perimeter/determinism parts drive the real shipped
 * lod.ts bake (bakeAllTierMeshes / edgeVertexKeys / regionBounds), so they
 * certify the exact geometry the renderer uploads. The flat-rebuild part drives
 * the headless renderer's non-enumerable rebuildStats() counters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import { createTerrainRenderer } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';
import {
  planLodRegions,
  bakeAllTierMeshes,
  edgeVertexKeys,
  regionBounds,
  PREBUILD_TIERS,
} from '../../../src/engine/layer1/renderer/lod.ts';

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}
function makeTerrain() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: 'alpine', seed: 1337 });
  t.generate();
  return t;
}
const TIERS = ['near', 'mid', 'far'] as const;
const POSE = { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 };
function plan() {
  return planLodRegions({ worldWidth: 512, worldDepth: 512, vertexGrid: 512, camera: POSE });
}
function edgePair(a: any, b: any): [string, string] | null {
  if (b.cx === a.cx + 1 && b.cz === a.cz) return ['right', 'left'];
  if (a.cx === b.cx + 1 && a.cz === b.cz) return ['left', 'right'];
  if (b.cz === a.cz + 1 && b.cx === a.cx) return ['bottom', 'top'];
  if (a.cz === b.cz + 1 && a.cx === b.cx) return ['top', 'bottom'];
  return null;
}

// === PM5-01: stitching across all six {1,2,4} runtime tier pairs ===
test('M-P5 PM5-01: pre-built tiers stitch across every runtime tier pair', () => {
  const t = makeTerrain();
  const p = plan();
  const baked = bakeAllTierMeshes(t, p);
  let combos = 0;
  let mismatches = 0;
  for (const a of p.regions) {
    for (const b of p.regions) {
      if (Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz) !== 1) continue;
      const e = edgePair(a, b);
      if (!e) continue;
      const bA = regionBounds(p, a.cx, a.cz);
      const bB = regionBounds(p, b.cx, b.cz);
      for (const ta of TIERS) {
        for (const tb of TIERS) {
          const kA = edgeVertexKeys(baked.get(a.cx + ',' + a.cz)!.get(ta)!.buffers, e[0], bA);
          const kB = edgeVertexKeys(baked.get(b.cx + ',' + b.cz)!.get(tb)!.buffers, e[1], bB);
          combos += 1;
          const same = kA.length === kB.length && kA.every((v, i) => v === kB[i]);
          if (!same) mismatches += 1;
        }
      }
    }
  }
  assert.ok(combos > 0, 'sanity: some adjacent region pairs were compared');
  assert.equal(mismatches, 0, 'PM5-01: all six tier pairs must stitch crack-free without rebuild (got ' + mismatches + ' mismatches of ' + combos + ')');
});

// === P-AC-13: all tiers resident at first frame (3 x regionCount) ===
test('M-P5 P-AC-13: bakeAllTierMeshes bakes every region at all three resident tiers', () => {
  const t = makeTerrain();
  const p = plan();
  const baked = bakeAllTierMeshes(t, p);
  assert.equal(baked.size, p.regions.length, 'one outer entry per region');
  for (const byTier of baked.values()) {
    for (const tier of PREBUILD_TIERS) {
      assert.ok(byTier.has(tier), 'every region carries a ' + tier + '-tier mesh');
    }
    assert.equal(byTier.size, PREBUILD_TIERS.length, 'exactly the resident tiers per region');
  }
  assert.equal(baked.size * PREBUILD_TIERS.length, p.regions.length * 3, 'resident mesh count is 3 x regionCount');
});

// === PM5-08: fine-lattice perimeter for BOTH near and far ===
// The fixed shared-edge perimeter lattice bakes each region's shared edge on
// lattice P (stride 1). A far mesh interior is stride 4, so a boundary that is
// NOT densified would keep only ~span/4 boundary vertices. The densified far
// perimeter must equal the near perimeter vertex count (both 0..span).
test('M-P5 PM5-08: far-tier shared-edge vertex count equals the fine near lattice', () => {
  const t = makeTerrain();
  const p = plan();
  const baked = bakeAllTierMeshes(t, p);
  // Compare a region's own near vs far perimeter vertex count on the SAME edge.
  // Both must sit on lattice 1, so the counts match (the far interior is coarser
  // but its perimeter is densified to the fixed lattice).
  let checked = 0;
  for (const r of p.regions) {
    const bR = regionBounds(p, r.cx, r.cz);
    const nearRight = edgeVertexKeys(baked.get(r.cx + ',' + r.cz)!.get('near')!.buffers, 'right', bR);
    const farRight = edgeVertexKeys(baked.get(r.cx + ',' + r.cz)!.get('far')!.buffers, 'right', bR);
    const nearTop = edgeVertexKeys(baked.get(r.cx + ',' + r.cz)!.get('near')!.buffers, 'top', bR);
    const farTop = edgeVertexKeys(baked.get(r.cx + ',' + r.cz)!.get('far')!.buffers, 'top', bR);
    assert.equal(farRight.length, nearRight.length, 'far right perimeter == fine near lattice (region ' + r.cx + ',' + r.cz + ')');
    assert.equal(farTop.length, nearTop.length, 'far top perimeter == fine near lattice (region ' + r.cx + ',' + r.cz + ')');
    // And it is genuinely fine (span+1 boundary points), not collapsed to span/4.
    assert.ok(nearRight.length >= r.spanX, 'near perimeter is fine-grained (>= spanX+1 boundary points)');
    checked += 1;
  }
  assert.ok(checked > 0, 'sanity: perimeters were checked');
});

// === Determinism: two bakes of the same plan are byte-identical ===
test('M-P5 determinism: two bakes of the same plan produce identical buffers', () => {
  const t = makeTerrain();
  const p = plan();
  const a = bakeAllTierMeshes(t, p);
  const b = bakeAllTierMeshes(t, p);
  for (const [key, byTierA] of a) {
    const byTierB = b.get(key)!;
    for (const tier of TIERS) {
      const ba = byTierA.get(tier)!.buffers;
      const bb = byTierB.get(tier)!.buffers;
      assert.equal(ba.positions.length, bb.positions.length, tier + ' positions length match');
      assert.equal(ba.triangleCount, bb.triangleCount, tier + ' triangle count match');
      let same = true;
      for (let i = 0; i < ba.positions.length; i += 1) {
        if (ba.positions[i] !== bb.positions[i]) { same = false; break; }
      }
      assert.ok(same, tier + ' positions byte-identical across two bakes (region ' + key + ')');
    }
  }
});

// === P-AC-09: rebuild counter FLAT across a camera sweep ===
test('M-P5 P-AC-09: rebuildCount stays FLAT across a camera sweep after the cold pre-build', () => {
  const t = makeTerrain();
  const r = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  const st = () => (r as any).rebuildStats();
  r.setCamera(POSE); // cold path: one pre-build event
  const cold = st().rebuildCount;
  assert.equal(cold, 1, 'exactly one rebuild for the cold pre-build');
  // A wide sweep that crosses every tier boundary must NOT rebuild again.
  const sweep = [
    { x: 0, y: 20, z: 0, targetX: 0, targetY: 0, targetZ: 0 },     // deep near
    { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 },   // mixed
    { x: 0, y: 400, z: 600, targetX: 0, targetY: 0, targetZ: 0 },  // far
    { x: 0, y: 900, z: 900, targetX: 0, targetY: 0, targetZ: 0 },  // skybox->far
    { x: 0, y: 20, z: 0, targetX: 0, targetY: 0, targetZ: 0 },     // back to near
  ];
  for (const pose of sweep) r.setCamera(pose);
  assert.equal(st().rebuildCount, cold, 'P-AC-09 strong form: rebuildCount FLAT for any camera movement (no epoch change)');
  // An epoch bump (rebuildFromSnapshot) is the ONLY thing that re-pre-builds.
  r.rebuildFromSnapshot();
  r.setCamera(POSE);
  assert.equal(st().rebuildCount, cold + 1, 'an epoch change forces exactly one re-pre-build');
  r.dispose();
});

// === P-AC-14: load-time bake measurement recorded (provisional, not a gate) ===
test('M-P5 P-AC-14: full pre-build completes and its wall time is recorded', () => {
  const t = makeTerrain();
  const p = plan();
  const start = performance.now();
  const baked = bakeAllTierMeshes(t, p);
  const ms = performance.now() - start;
  assert.equal(baked.size * PREBUILD_TIERS.length, p.regions.length * 3, 'full pre-build produced all resident meshes');
  // Record the number in CI output. Provisional threshold: assert only that it
  // completes far under a generous ceiling so a runaway regression is caught,
  // but do NOT fail on the provisional target (spec 3.2 / OQ-2).
  // eslint-disable-next-line no-console
  console.log('M-P5 P-AC-14 load-time bake: ' + ms.toFixed(1) + ' ms for ' + (baked.size * PREBUILD_TIERS.length) + ' meshes (provisional)');
  assert.ok(ms < 60000, 'load-time bake must complete under a generous 60s ceiling (recorded, not gated)');
});

// === P-AC-03/04: drawn reflects the SELECTED tier (bounds unchanged) ===
test('M-P5 P-AC-03/04: a distant camera demotes the drawn tier set (selection input)', () => {
  const t = makeTerrain();
  const r = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  r.setCamera({ x: 0, y: 20, z: 0, targetX: 0, targetY: 0, targetZ: 0 });
  const nearTiers = new Set(r.getLodRegions().map((reg: any) => reg.tier));
  assert.ok(nearTiers.has('near'), 'camera over center marks some regions near');
  r.setCamera({ x: 0, y: 4000, z: 9000, targetX: 0, targetY: 0, targetZ: 0 });
  const farHasNear = r.getLodRegions().some((reg: any) => reg.tier === 'near');
  assert.ok(!farHasNear, 'a distant camera demotes every region off the near tier (drawn input)');
  r.dispose();
});
