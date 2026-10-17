/*
 * M-P3 stitching-integrity guard (P-AC-06).
 *
 * M-P3 replaces the uniform region partition with an exact integer partition
 * of the base grid (spansAxis), so the last region along each axis has span
 * 63 while the others have 64 (512) / 127 vs 128 (1024). That variable-span
 * boundary is the new crack risk: the old uniform reconstruction
 * (worldWidth/regionsPerAxis) is no longer partition-correct, so this guard
 * rebuilds each vertex's local grid coordinate from the authoritative
 * partition fields (cellStartX + kx*cell) and asserts:
 *
 *   1. The partition sums to vertexGrid-1 exactly on both axes (no gap/overlap
 *      in the world tiling -> the built total is the non-overlap floor).
 *   2. Every horizontally/vertically adjacent region pair keeps byte-identical
 *      shared-boundary vertices (world XZ + Y). A mismatch is a crack (sky
 *      leaks through) — the geometry twin of the renderer seamCheck pixel gate.
 *   3. No T-junctions: the shared boundary vertex SETS are equal (same cardinality
 *      and elements), so neither side carries a stray vertex the other lacks.
 *
 * Covers both the uniform and the variable-span boundary explicitly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer, DEFAULT_WORLD_SIZE, type TerrainWorldSize } from '../../../src/engine/layer1/terrain/index.ts';
import { planLodRegions, buildLodRegionMeshes } from '../../../src/engine/layer1/renderer/lod.ts';
import { DEFAULT_CAMERA_POSE } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';

type Mesh = ReturnType<typeof buildLodRegionMeshes>[number];

function mp3Stitch(worldSize: TerrainWorldSize): {
  cracks: string[]; checks: number; tiers: Set<string>;
  variableSpanBoundaryChecked: boolean; sumOk: boolean;
} {
  const terrain = createTerrainLayer({ worldSize });
  terrain.generate();
  const snap = terrain.snapshot();
  const worldMeters = snap.worldSize.meters;
  const vertexGrid = snap.worldSize.vertices;
  const plan = planLodRegions({ worldWidth: worldMeters, worldDepth: worldMeters, vertexGrid, camera: DEFAULT_CAMERA_POSE });
  const meshes = buildLodRegionMeshes(terrain, { plan });
  const tiers = new Set(plan.regions.map((rg) => rg.tier));

  // Partition sums to the full base-grid extent on both axes (exact tiling).
  const sumX = plan.spansAxis.reduce((a, b) => a + b, 0);
  const sumOk = sumX === vertexGrid - 1 && plan.spansAxis.length === plan.regionsPerAxis;

  const cell = plan.worldWidth / (vertexGrid - 1);
  const byKey = new Map<string, Mesh>();
  for (const m of meshes) byKey.set(m.region.cx + ',' + m.region.cz, m);

  // Partition-correct edge vertices: decode local grid coord from the world
  // position, then test membership against THIS region's own span. A vertex
  // belongs to the region's edge if its local grid coord equals 0 or spanX/spanZ.
  function edgePositions(m: Mesh, edge: 'left' | 'right' | 'top' | 'bottom'): string[] {
    const { cellStartX, cellStartZ, spanX, spanZ } = m.region;
    const pos = m.buffers.positions;
    const out: string[] = [];
    for (let i = 0; i < m.buffers.vertexCount; i += 1) {
      const wx = pos[i * 3], wy = pos[i * 3 + 1], wz = pos[i * 3 + 2];
      const kx = Math.round((wx + plan.worldWidth / 2) / cell - cellStartX);
      const kz = Math.round((wz + plan.worldDepth / 2) / cell - cellStartZ);
      const onEdge =
        edge === 'left' ? kx === 0 :
        edge === 'right' ? kx === spanX :
        edge === 'top' ? kz === 0 :
        kz === spanZ;
      if (onEdge) out.push(wx.toFixed(6) + ',' + wy.toFixed(6) + ',' + wz.toFixed(6));
    }
    return out.sort();
  }

  let checks = 0;
  let variableSpanBoundaryChecked = false;
  const cracks: string[] = [];
  const last = plan.regionsPerAxis - 1;
  for (const region of plan.regions) {
    const { cx, cz } = region;
    const here = byKey.get(cx + ',' + cz);
    if (!here) continue;
    const right = byKey.get((cx + 1) + ',' + cz);
    if (right) {
      checks += 1;
      if (cx === last - 1 || cx === last) variableSpanBoundaryChecked = true;
      const a = edgePositions(here, 'right'), b = edgePositions(right, 'left');
      if (a.length !== b.length || a.join('|') !== b.join('|')) {
        if (cracks.length < 8) cracks.push('right/left ' + cx + ',' + cz + ' (' + a.length + ' vs ' + b.length + ')');
      }
    }
    const bottom = byKey.get(cx + ',' + (cz + 1));
    if (bottom) {
      checks += 1;
      if (cz === last - 1 || cz === last) variableSpanBoundaryChecked = true;
      const a = edgePositions(here, 'bottom'), b = edgePositions(bottom, 'top');
      if (a.length !== b.length || a.join('|') !== b.join('|')) {
        if (cracks.length < 8) cracks.push('bottom/top ' + cx + ',' + cz + ' (' + a.length + ' vs ' + b.length + ')');
      }
    }
  }
  return { cracks, checks, tiers, variableSpanBoundaryChecked, sumOk };
}

test('M-P3 P-AC-06: exact partition tiling + crack-free variable-span stitching (512)', () => {
  const { cracks, checks, tiers, variableSpanBoundaryChecked, sumOk } = mp3Stitch(DEFAULT_WORLD_SIZE);
  assert.ok(sumOk, 'spansAxis must tile [0, vertexGrid-1] exactly (no gap/overlap)');
  assert.ok(tiers.size >= 2, 'plan must be mixed-tier or the seam bug is masked (got ' + [...tiers].join(',') + ')');
  assert.ok(checks > 50, 'too few adjacent-edge checks to be meaningful (' + checks + ')');
  assert.ok(variableSpanBoundaryChecked, 'the variable-span boundary (last column/row) must be exercised');
  assert.equal(cracks.length, 0, cracks.length + ' cracked region edge(s) (T-junction or sky leak at a tier/region boundary): ' + cracks.join(' | '));
});

test('M-P3 P-AC-06: exact partition tiling + crack-free variable-span stitching (1024)', () => {
  const { cracks, checks, tiers, variableSpanBoundaryChecked, sumOk } = mp3Stitch({ vertices: 1024, meters: 1024 });
  assert.ok(sumOk, 'spansAxis must tile [0, vertexGrid-1] exactly (no gap/overlap)');
  assert.ok(tiers.size >= 2, 'plan must be mixed-tier or the seam bug is masked (got ' + [...tiers].join(',') + ')');
  assert.ok(checks > 50, 'too few adjacent-edge checks to be meaningful (' + checks + ')');
  assert.ok(variableSpanBoundaryChecked, 'the variable-span boundary (last column/row) must be exercised');
  assert.equal(cracks.length, 0, cracks.length + ' cracked region edge(s) (T-junction or sky leak at a tier/region boundary): ' + cracks.join(' | '));
});
