/*
 * M-T4 seam verification: builds the default LOD plan for the shipped camera
 * and asserts that every pair of horizontally/vertically adjacent regions keeps
 * byte-identical boundary vertices (world XZ + Y). A mismatch is a crack — the
 * exact defect the Gate VIS pixel check surfaced. Exit code 0 = watertight.
 */
import { createTerrainLayer, DEFAULT_WORLD_SIZE } from "../src/engine/layer1/terrain/index.ts";
import { planLodRegions, buildLodRegionMeshes, defaultLodConfig } from "../src/engine/layer1/renderer/lod.ts";
import { DEFAULT_CAMERA_POSE } from "../src/engine/layer1/renderer/terrain-renderer.ts";

const terrain = createTerrainLayer({ worldSize: DEFAULT_WORLD_SIZE });
terrain.generate();
const snap = terrain.snapshot();
const worldMeters = snap.worldSize.meters;
const vertexGrid = snap.worldSize.vertices;
const base = defaultLodConfig(worldMeters);
const plan = planLodRegions({ worldWidth: worldMeters, worldDepth: worldMeters, vertexGrid, camera: DEFAULT_CAMERA_POSE });
const meshes = buildLodRegionMeshes(terrain, { plan });

// Index region meshes by (cx,cz).
const byKey = new Map<string, typeof meshes[number]>();
for (const m of meshes) byKey.set(`${m.region.cx},${m.region.cz}`, m);

const R = plan.regionSpan;
const halfW = plan.worldWidth / 2;
const halfD = plan.worldDepth / 2;
const regionWorld = plan.worldWidth / plan.regionsPerAxis;

// Collect world positions of a region's four edge boundaries as a sorted key.
function edgePositions(m: typeof meshes[number], edge: "left" | "right" | "top" | "bottom"): string[] {
  const { cx, cz } = m.region;
  const pos = m.buffers.positions;
  const out: string[] = [];
  // Local boundary coordinate: left/right => kx=0/r varying kz; top/bottom => kz=0/r varying kx.
  for (let i = 0; i < m.buffers.vertexCount; i += 1) {
    const wx = pos[i * 3 + 0];
    const wy = pos[i * 3 + 1];
    const wz = pos[i * 3 + 2];
    // Local coords recovered from world: k = (world + half - cx*regionWorld)/regionWorld * R
    const kx = ((wx + halfW) / regionWorld - cx) * R;
    const kz = ((wz + halfD) / regionWorld - cz) * R;
    const onEdge =
      edge === "left" ? Math.abs(kx) < 1e-6 :
      edge === "right" ? Math.abs(kx - R) < 1e-6 :
      edge === "top" ? Math.abs(kz) < 1e-6 :
      Math.abs(kz - R) < 1e-6;
    if (onEdge) out.push(`${wx.toFixed(6)},${wy.toFixed(6)},${wz.toFixed(6)}`);
  }
  return out.sort();
}

// Count tiers present to prove the plan is mixed (else seam bug hides).
const tiers = new Set(plan.regions.map((r) => r.tier));
let checks = 0;
let mismatches = 0;
for (const region of plan.regions) {
  const { cx, cz } = region;
  const here = byKey.get(`${cx},${cz}`);
  if (!here) continue;
  // Right neighbor shares this region's right edge (kx=R) with neighbor's left edge (kx=0).
  const right = byKey.get(`${cx + 1},${cz}`);
  if (right) {
    checks += 1;
    const a = edgePositions(here, "right");
    const b = edgePositions(right, "left");
    if (a.join("|") !== b.join("|")) { mismatches += 1; if (mismatches <= 4) console.log("CRACK at right edge", cx, cz, "A:", a.length, "B:", b.length, "match:", a.filter((x) => b.includes(x)).length); }
  }
  const bottom = byKey.get(`${cx},${cz + 1}`);
  if (bottom) {
    checks += 1;
    const a = edgePositions(here, "bottom");
    const b = edgePositions(bottom, "top");
    if (a.join("|") !== b.join("|")) { mismatches += 1; if (mismatches <= 4) console.log("CRACK at bottom edge", cx, cz, "A:", a.length, "B:", b.length, "match:", a.filter((x) => b.includes(x)).length); }
  }
}
console.log("tiers present:", [...tiers].join(","), "| adjacent-edge checks:", checks, "| mismatches:", mismatches);
if (tiers.size < 2) console.log("WARN: plan not mixed-tier; seam bug would be masked");
process.exit(mismatches === 0 && tiers.size >= 2 ? 0 : 1);
