/*
 * LOD tier-boundary stitch regression (M-T2 s7.17).
 *
 * Headless MECHANISM guard for the crack Gate VIS found as sky leaking through
 * the terrain at 512x512 (commit b2619f8): adjacent LOD regions did not keep
 * identical shared-edge vertices, so the two tiers left a gap. Asserts every
 * horizontally/vertically adjacent region pair keeps byte-identical boundary
 * vertices (world XZ + Y) with the real review camera, at BOTH the shipped
 * 512 default and the 1024 stretch preset. A mismatch is a crack. This is the
 * geometry twin of the rendered-pixel gate (renderer seamCheck readPixels
 * enclosed-hole count; before/after browser screenshots FAIL holes=34 broken /
 * PASS 0 fixed in the evidence doc).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer, DEFAULT_WORLD_SIZE, type TerrainWorldSize } from '../../../src/engine/layer1/terrain/index.ts';
import { planLodRegions, buildLodRegionMeshes, defaultLodConfig } from '../../../src/engine/layer1/renderer/lod.ts';
import { DEFAULT_CAMERA_POSE } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';

function stitchHasCracks(worldSize: TerrainWorldSize): { cracks: string[]; checks: number; tiers: Set<string> } {
  const terrain = createTerrainLayer({ worldSize });
  terrain.generate();
  const snap = terrain.snapshot();
  const worldMeters = snap.worldSize.meters;
  const vertexGrid = snap.worldSize.vertices;
  const base = defaultLodConfig(worldMeters);
  const plan = planLodRegions({ worldWidth: worldMeters, worldDepth: worldMeters, vertexGrid, camera: DEFAULT_CAMERA_POSE });
  const meshes = buildLodRegionMeshes(terrain, { plan });
  const tiers = new Set(plan.regions.map((rg) => rg.tier));
  const Rspan = plan.regionSpan;
  const halfW = plan.worldWidth / 2;
  const halfD = plan.worldDepth / 2;
  const regionWorld = plan.worldWidth / plan.regionsPerAxis;
  const byKey = new Map<string, (typeof meshes)[number]>();
  for (const m of meshes) byKey.set(m.region.cx + ',' + m.region.cz, m);
  function edgePositions(m: (typeof meshes)[number], edge: 'left' | 'right' | 'top' | 'bottom'): string[] {
    const { cx, cz } = m.region;
    const pos = m.buffers.positions;
    const out: string[] = [];
    for (let i = 0; i < m.buffers.vertexCount; i += 1) {
      const wx = pos[i * 3], wy = pos[i * 3 + 1], wz = pos[i * 3 + 2];
      const kx = ((wx + halfW) / regionWorld - cx) * Rspan;
      const kz = ((wz + halfD) / regionWorld - cz) * Rspan;
      const onEdge =
        edge === 'left' ? Math.abs(kx) < 1e-6 :
        edge === 'right' ? Math.abs(kx - Rspan) < 1e-6 :
        edge === 'top' ? Math.abs(kz) < 1e-6 :
        Math.abs(kz - Rspan) < 1e-6;
      if (onEdge) out.push(wx.toFixed(6) + ',' + wy.toFixed(6) + ',' + wz.toFixed(6));
    }
    return out.sort();
  }
  let checks = 0;
  const cracks: string[] = [];
  for (const region of plan.regions) {
    const { cx, cz } = region;
    const here = byKey.get(cx + ',' + cz);
    if (!here) continue;
    const right = byKey.get((cx + 1) + ',' + cz);
    if (right) {
      checks += 1;
      const a = edgePositions(here, 'right'), b = edgePositions(right, 'left');
      if (a.join('|') !== b.join('|') && cracks.length < 8) cracks.push('right edge ' + cx + ',' + cz);
    }
    const bottom = byKey.get(cx + ',' + (cz + 1));
    if (bottom) {
      checks += 1;
      const a = edgePositions(here, 'bottom'), b = edgePositions(bottom, 'top');
      if (a.join('|') !== b.join('|') && cracks.length < 8) cracks.push('bottom edge ' + cx + ',' + cz);
    }
  }
  return { cracks, checks, tiers };
}

test('LOD adjacent regions keep identical shared-boundary vertices (512 default, no crack, s7.17)', () => {
  const { cracks, checks, tiers } = stitchHasCracks(DEFAULT_WORLD_SIZE);
  assert.ok(tiers.size >= 2, 'plan must be mixed-tier or the seam bug is masked (got ' + [...tiers].join(',') + ')');
  assert.ok(checks > 50, 'too few adjacent-edge checks to be meaningful (' + checks + ')');
  assert.equal(cracks.length, 0, cracks.length + ' cracked region edge(s) (sky would leak through tier boundary): ' + cracks.join(' | '));
});

test('LOD adjacent regions keep identical shared-boundary vertices (1024 stretch preset, no crack, s7.17)', () => {
  const { cracks, checks, tiers } = stitchHasCracks({ vertices: 1024, meters: 1024 });
  assert.ok(tiers.size >= 2, 'plan must be mixed-tier or the seam bug is masked (got ' + [...tiers].join(',') + ')');
  assert.ok(checks > 50, 'too few adjacent-edge checks to be meaningful (' + checks + ')');
  assert.equal(cracks.length, 0, cracks.length + ' cracked region edge(s) (sky would leak through tier boundary): ' + cracks.join(' | '));
});
