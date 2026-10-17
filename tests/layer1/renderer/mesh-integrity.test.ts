import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import { buildTerrainMesh, checkMeshIntegrity } from "../../../src/engine/layer1/renderer/mesh.ts";
import {
  buildLodRegionMeshes,
  planLodRegions,
  defaultLodConfig,
  type LodPlan,
} from "../../../src/engine/layer1/renderer/lod.ts";
import type { TerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import type { RegionMeshResult } from "../../../src/engine/layer1/renderer/lod.ts";
import type { CameraPose } from "../../../src/engine/layer1/renderer/types.ts";

const GRID = 256;
const METERS = 256;

function makeTerrain(seed = 4242): TerrainLayer {
  const t = createTerrainLayer({ worldSize: { vertices: GRID, meters: METERS } });
  t.setParams({ seed, biome: "alpine", elevation: 6, mountainAggression: 7 });
  t.generate();
  return t;
}

const CENTER_POSE: CameraPose = {
  x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0,
};

// Tight boundaries so a centered camera over a 256 m world yields multiple tiers.
const VARIED_CONFIG = { nearM: 20, maxMidM: 60, maxFarM: 120 };

test("near-tier base mesh passes every spec §3.8 integrity check", () => {
  const t = makeTerrain();
  const mesh = buildTerrainMesh(t, {
    worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID, lodLevel: "near",
  });
  const report = checkMeshIntegrity(mesh);
  assert.equal(report.pass, true, report.errors.join("; "));
  assert.equal(mesh.triangleCount, 2 * (GRID - 1) * (GRID - 1));
  assert.equal(mesh.vertexCount, GRID * GRID);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3);
});

test("mesh vertex heights equal the public sampleHeight seam (no secondary sampling path)", () => {
  const t = makeTerrain();
  const mesh = buildTerrainMesh(t, {
    worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID, lodLevel: "near",
  });
  const cell = METERS / (GRID - 1);
  for (let i = 0; i < mesh.vertexCount; i += 4013) { // strided sample across the grid
    const x = mesh.positions[i * 3];
    const z = mesh.positions[i * 3 + 2];
    // Snap to grid coordinate to cancel float32 storage error, then compare Y.
    const gx = Math.round((x + METERS / 2) / cell);
    const gz = Math.round((z + METERS / 2) / cell);
    const wx = -METERS / 2 + gx * cell;
    const wz = -METERS / 2 + gz * cell;
    const expected = t.sampleHeight(wx, wz);
    assert.ok(
      Math.abs(mesh.positions[i * 3 + 1] - expected) < 1e-3,
      `vertex ${i}: mesh Y ${mesh.positions[i * 3 + 1]} != sampleHeight ${expected}`,
    );
  }
});

test("same terrain snapshot produces identical mesh buffers (L1-AC-153 determinism)", () => {
  const t = makeTerrain();
  const opts = { worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID, lodLevel: "near" as const };
  const a = buildTerrainMesh(t, opts);
  const b = buildTerrainMesh(t, opts);
  assert.equal(Buffer.compare(Buffer.from(a.positions.buffer), Buffer.from(b.positions.buffer)), 0);
  assert.equal(Buffer.compare(Buffer.from(a.normals.buffer), Buffer.from(b.normals.buffer)), 0);
  assert.equal(Buffer.compare(Buffer.from(a.uvs.buffer), Buffer.from(b.uvs.buffer)), 0);
  assert.equal(Buffer.compare(Buffer.from(a.indices.buffer), Buffer.from(b.indices.buffer)), 0);
});

/**
 * Map quantized world (x,z) -> mesh Y for one region. Shared boundary
 * vertices appear in both adjacent region meshes; agreement there proves the
 * crack-free seam (spec §11.1: no T-junction gaps at tier boundaries).
 */
function regionHeightMap(result: RegionMeshResult): Map<string, number> {
  const map = new Map<string, number>();
  const { positions } = result.buffers;
  for (let i = 0; i < result.buffers.vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    map.set(`${x.toFixed(2)},${z.toFixed(2)}`, y);
  }
  return map;
}

test("LOD region meshes share identical heights along adjacent region boundaries (no cracking)", () => {
  const t = makeTerrain();
  const plan = planLodRegions({
    worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID,
    camera: CENTER_POSE, config: VARIED_CONFIG, regionsPerAxis: 4,
  });
  const meshes = buildLodRegionMeshes(t, { plan });
  const maps = new Map<string, Map<string, number>>();
  for (const m of meshes) maps.set(`${m.region.cx},${m.region.cz}`, regionHeightMap(m));

  const key = (cx: number, cz: number) => `${cx},${cz}`;
  let checked = 0;
  let variedTierAdjacencies = 0;

  for (const m of meshes) {
    const { cx, cz } = m.region;
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const neighbor = meshes.find((n) => n.region.cx === cx + dx && n.region.cz === cz + dz);
      if (!neighbor) continue;
      if (neighbor.region.tier !== m.region.tier) variedTierAdjacencies += 1;
      const mapA = maps.get(key(cx, cz))!;
      const mapB = maps.get(key(neighbor.region.cx, neighbor.region.cz))!;
      for (const [k, yA] of mapA) {
        const yB = mapB.get(k);
        if (yB === undefined) continue; // shared boundary vertices only
        assert.ok(
          Math.abs(yA - yB) < 1e-3,
          `seam mismatch at (${k}) between (${cx},${cz}/${m.region.tier}) and ` +
          `(${neighbor.region.cx},${neighbor.region.cz}/${neighbor.region.tier}): ${yA} vs ${yB}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, "no shared boundary vertices found between adjacent regions");
  assert.ok(variedTierAdjacencies > 0, "test config must produce adjacent regions with differing tiers");
});

test("LOD plan is deterministic for the same camera and world state", () => {
  const t = makeTerrain();
  const planArgs = {
    worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID,
    camera: CENTER_POSE, config: VARIED_CONFIG, regionsPerAxis: 4,
  };
  const a = planLodRegions(planArgs);
  const b = planLodRegions(planArgs);
  assert.deepEqual(a.regions, b.regions);
  assert.equal(a.regions.length, a.regionsPerAxis * a.regionsPerAxis);
  // Camera-near regions must not be coarser than far-region tiers.
  const centerRegion = a.regions.reduce((best, r) => {
    const d = (rc: typeof r) => Math.hypot((rc.cx + 0.5) * (METERS / 4) - METERS / 2, (rc.cz + 0.5) * (METERS / 4) - METERS / 2);
    return d(r) < d(best) ? r : best;
  });
  const rank: Record<string, number> = { near: 0, mid: 1, far: 2, skybox: 3 };
  const maxCenterRank = Math.max(...a.regions
    .filter((r) => r.cx === centerRegion.cx && r.cz === centerRegion.cz)
    .map((r) => rank[r.tier]));
  const cornerRank = rank[a.regions[a.regions.length - 1].tier];
  assert.ok(maxCenterRank <= cornerRank, "near regions must not be coarser than far regions");
});

test("LOD mesh construction never mutates terrain state or sampleHeight (L1-AC-154/157)", () => {
  const t = makeTerrain();
  const points: [number, number][] = [[-90, -40], [0, 0], [33, 77], [-12, 100]];
  const before = JSON.stringify({
    snap: t.snapshot(),
    h: points.map(([x, z]) => t.sampleHeight(x, z)),
  });
  const plan = planLodRegions({
    worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID,
    camera: CENTER_POSE, config: VARIED_CONFIG, regionsPerAxis: 4,
  });
  buildLodRegionMeshes(t, { plan });
  // Move the "camera" and re-plan repeatedly — still no terrain mutation.
  for (let i = 0; i < 3; i += 1) {
    const shifted = planLodRegions({
      worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID,
      camera: { ...CENTER_POSE, x: i * 10 }, config: VARIED_CONFIG, regionsPerAxis: 4,
    });
    buildLodRegionMeshes(t, { plan: shifted });
  }
  const after = JSON.stringify({
    snap: t.snapshot(),
    h: points.map(([x, z]) => t.sampleHeight(x, z)),
  });
  assert.equal(after, before);
});

test("default LOD config scales with world size (no hard-coded grid assumption)", () => {
  const small = defaultLodConfig(256);
  const big = defaultLodConfig(1024);
  assert.ok(big.nearM > small.nearM);
  assert.ok(big.maxMidM > small.maxMidM);
  assert.ok(big.maxFarM > small.maxFarM);
});

test("region meshes pass integrity bounds and index-range checks at every tier", () => {
  const t = makeTerrain();
  const plan: LodPlan = planLodRegions({
    worldWidth: METERS, worldDepth: METERS, vertexGrid: GRID,
    camera: CENTER_POSE, config: VARIED_CONFIG, regionsPerAxis: 4,
  });
  const meshes = buildLodRegionMeshes(t, { plan });
  assert.ok(meshes.length >= 1);
  for (const m of meshes) {
    const { positions, indices, vertexCount } = m.buffers;
    for (let i = 0; i < vertexCount; i += 1) {
      assert.ok(Number.isFinite(positions[i * 3 + 1]), "non-finite height in region mesh");
    }
    for (let i = 0; i < indices.length; i += 1) {
      assert.ok(indices[i] < vertexCount, "index out of range in region mesh");
    }
  }
});
