/**
 * Layer 1 M-T2 renderer — LOD tier selection and crack-free region stitching.
 *
 * LOD is a renderer concern (spec §11). This module consumes the public
 * terrain seam (`sampleHeight`) only. It never writes into terrain state,
 * never shadows or replaces `sampleHeight`, and introduces no secondary
 * sampling path (L1-AC-154, L1-AC-157). Tier assignment is a pure function of
 * camera pose + terrain world size, so the same inputs always produce the
 * same assignment (L1-AC-153).
 *
 * Seam strategy (spec §11.2 / §11.6): the world is split into rectangular
 * regions. Each region samples the heightfield at a stride derived from its
 * tier (near=1, mid=2, far=4, skybox=corners-only quad). Along every shared
 * region edge both sides keep exactly the same boundary vertices — the
 * multiples of lcm(ownStride, neighborStride) plus the edge endpoints — by
 * collapsing dropped boundary vertices to the nearest kept vertex along the
 * edge. Neighboring regions therefore share identical boundary positions, so
 * no cracks or T-junction gaps appear at tier boundaries.
 */

import type {
  CameraPose,
  LodConfig,
  LodRegion,
  LodTier,
  TerrainLayer,
  TerrainMeshBuffers,
} from "./types.ts";

/** Sampling stride (in base-grid vertex steps) per tier. Skybox = corners only. */
export const LOD_STRIDE_NEAR = 1;
export const LOD_STRIDE_MID = 2;
export const LOD_STRIDE_FAR = 4;

/** Default regions per axis; the plan reduces it if it exceeds the grid. */
export const DEFAULT_REGIONS_PER_AXIS = 8;

/**
 * Default tier boundaries scaled from world width (spec §11.1: a 512 m world
 * yields near ≤ 80, mid ≤ 200, far ≤ 400). Never hard-coded to 512.
 */
export function defaultLodConfig(worldWidthMeters: number): LodConfig {
  if (!Number.isFinite(worldWidthMeters) || worldWidthMeters <= 0) {
    throw new Error(`defaultLodConfig requires positive finite world width, received ${String(worldWidthMeters)}`);
  }
  return {
    nearM: (80 / 512) * worldWidthMeters,
    maxMidM: (200 / 512) * worldWidthMeters,
    maxFarM: (400 / 512) * worldWidthMeters,
  };
}

/** Pure tier lookup for a camera-to-region distance in meters (L1-AC-150). */
export function tierForDistance(distanceMeters: number, config: LodConfig): LodTier {
  if (!Number.isFinite(distanceMeters)) {
    throw new Error(`tierForDistance requires finite distance, received ${String(distanceMeters)}`);
  }
  if (distanceMeters <= config.nearM) return "near";
  if (distanceMeters <= config.maxMidM) return "mid";
  if (distanceMeters <= config.maxFarM) return "far";
  return "skybox";
}

export interface LodPlan {
  regionsPerAxis: number;
  /** Base-grid vertex span covered by one region (N-1 divided by regionsPerAxis). */
  regionSpan: number;
  /** M-P3: per-axis integer partition of [0, vertexGrid-1]; sums to vertexGrid-1 exactly. */
  spansAxis: number[];
  worldWidth: number;
  worldDepth: number;
  vertexGrid: number;
  config: LodConfig;
  regions: LodRegion[];
  /**
   * M-P2 budget override (INTERNAL, never on the public snapshot()).
   * Maps a region key (cx + "," + cz) to a coarser effective sampling stride
   * applied when the near-budget ceiling demotes that region. Absent key =>
   * the region keeps its tier stride. null/undefined => no demotion (default
   * behavior byte-identical to pre-M-P2).
   */
  budgetStride?: Map<string, number> | null;
}

export interface PlanLodOptions {
  worldWidth: number;
  worldDepth: number;
  vertexGrid: number;
  camera: CameraPose;
  config?: Partial<LodConfig>;
  regionsPerAxis?: number;
}

/**
 * Deterministic LOD plan: region grid + tier per region for this camera.
 * Same camera + same world state → identical plan every frame (L1-AC-153).
 */
export function planLodRegions(options: PlanLodOptions): LodPlan {
  const { worldWidth, worldDepth, vertexGrid } = options;
  if (!Number.isInteger(vertexGrid) || vertexGrid < 2) {
    throw new Error(`planLodRegions requires integer vertexGrid >= 2, received ${String(vertexGrid)}`);
  }
  const base = defaultLodConfig(worldWidth);
  const config: LodConfig = {
    nearM: options.config?.nearM ?? base.nearM,
    maxMidM: options.config?.maxMidM ?? base.maxMidM,
    maxFarM: options.config?.maxFarM ?? base.maxFarM,
  };

  let regionsPerAxis = options.regionsPerAxis ?? DEFAULT_REGIONS_PER_AXIS;
  if (!Number.isInteger(regionsPerAxis) || regionsPerAxis < 1) {
    throw new Error(`planLodRegions requires integer regionsPerAxis >= 1, received ${String(regionsPerAxis)}`);
  }
  // A region span below the far stride collapses to a single region.
  while (regionsPerAxis > 1 && Math.floor((vertexGrid - 1) / regionsPerAxis) < LOD_STRIDE_FAR) {
    regionsPerAxis = Math.max(1, Math.floor(regionsPerAxis / 2));
  }

  // M-P3: exact integer partition of N = vertexGrid - 1.
  const N = vertexGrid - 1;
  const baseSpan = Math.floor(N / regionsPerAxis);
  const rem = N % regionsPerAxis;
  const spansAxis: number[] = [];
  const boundaries: number[] = [0];
  for (let i = 0; i < regionsPerAxis; i += 1) {
    const s = baseSpan + (i < rem ? 1 : 0);
    spansAxis.push(s);
    boundaries.push(boundaries[i] + s);
  }

  const cellX = worldWidth / N;
  const cellZ = worldDepth / N;
  const halfW = worldWidth / 2;
  const halfD = worldDepth / 2;

  const out: LodRegion[] = [];
  for (let cz = 0; cz < regionsPerAxis; cz += 1) {
    for (let cx = 0; cx < regionsPerAxis; cx += 1) {
      const cellStartX = boundaries[cx];
      const cellStartZ = boundaries[cz];
      const spanX = spansAxis[cx];
      const spanZ = spansAxis[cz];
      const centerX = -halfW + (cellStartX + spanX / 2) * cellX;
      const centerZ = -halfD + (cellStartZ + spanZ / 2) * cellZ;
      const dx = options.camera.x - centerX;
      const dz = options.camera.z - centerZ;
      const dy = options.camera.y;
      const centerDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      out.push({
        cx, cz, centerX, centerZ,
        tier: tierForDistance(centerDistance, config),
        centerDistance,
        spanX, spanZ, cellStartX, cellStartZ,
      });
    }
  }

  const regionSpan = baseSpan + (rem > 0 ? 1 : 0);
  return { regionsPerAxis, regionSpan, spansAxis, worldWidth, worldDepth, vertexGrid, config, regions: out };
}

function strideForTier(tier: LodTier, regionSpan: number): number {
  switch (tier) {
    case "near":
      return LOD_STRIDE_NEAR;
    case "mid":
      return LOD_STRIDE_MID;
    case "far":
      return LOD_STRIDE_FAR;
    case "skybox":
      // Corners-only quad: stride equals the full span (>= both per-axis spans
      // so axisPoints collapses to endpoints on each axis).
      return regionSpan;
  }
}

/** Stride used for an out-of-grid neighbor (treated as skybox corners-only). */
export function regionSpanAsStride(r: number): number {
  return r;
}

/**
 * M-P2 effective sampling stride for a region: its tier stride unless the
 * near-budget ceiling recorded a coarser budgetStride override for it.
 * Pure over (plan, region). The public tier is untouched; only tessellation
 * density changes, so shared-boundary stitching still holds because both
 * sides consult this same function (M-P2-AC-05).
 *
 * M-P3: the skybox stride is the region's own max(spanX, spanZ) so the
 * corners-only quad covers both per-axis spans exactly.
 */
export function effectiveStrideForRegion(plan: LodPlan, region: LodRegion): number {
  const rSky = Math.max(region.spanX, region.spanZ);
  const base = strideForTier(region.tier, rSky);
  const map = plan.budgetStride;
  if (!map) return base;
  const ov = map.get(region.cx + "," + region.cz);
  if (ov === undefined) return base;
  // Never finer than the tier stride; ceiling only coarsens. Clamp to [1, rSky].
  const clamped = Math.max(1, Math.min(rSky, ov));
  return clamped > base ? clamped : base;
}

/** Effective stride at a neighbor grid coordinate (out-of-grid => skybox span). */
function strideAtCoord(plan: LodPlan, cx: number, cz: number, fallback: number): number {
  const region = plan.regions.find((rg) => rg.cx === cx && rg.cz === cz);
  if (!region) return regionSpanAsStride(fallback);
  return effectiveStrideForRegion(plan, region);
}

export interface RegionEdgeStrides { s: number; left: number; right: number; top: number; bottom: number; }

/**
 * Shared per-region edge-stride computation (self + lcm-refined neighbor kept
 * strides on each edge). Used by BOTH the mesh builder and the budget
 * estimator so predicted triangle count equals measured count (§6.6).
 *
 * M-P3: the kept stride along a vertical edge (left/right) collapses within
 * this region's spanZ; along a horizontal edge (top/bottom) within spanX.
 * Neighbors sharing a vertical edge share the same cz (hence spanZ), and
 * horizontal-edge neighbors share cx (hence spanX), so the lcm boundary
 * lattice agrees across the seam even with variable per-region spans.
 */
export function regionEdgeStrides(plan: LodPlan, region: LodRegion): RegionEdgeStrides {
  const rx = region.spanX;
  const rz = region.spanZ;
  const s = effectiveStrideForRegion(plan, region);
  return {
    s,
    left: edgeKeptStride(s, strideAtCoord(plan, region.cx - 1, region.cz, rz), rz),
    right: edgeKeptStride(s, strideAtCoord(plan, region.cx + 1, region.cz, rz), rz),
    top: edgeKeptStride(s, strideAtCoord(plan, region.cx, region.cz - 1, rx), rx),
    bottom: edgeKeptStride(s, strideAtCoord(plan, region.cx, region.cz + 1, rx), rx),
  };
}

export interface RegionTopology { vertexKeys: number[]; indices: number[]; }

/**
 * Pure region mesh topology: sampling points, crack-free boundary collapse,
 * and the degenerate-triangle-dropped index list. Heights are NOT sampled
 * here; the builder fills positions from the public seam using vertexKeys.
 * Extracted so the budget estimator predicts the exact same triangle count
 * the builder produces (M-P2-AC-01 / §6.6).
 *
 * M-P3: rx/rz are the per-axis base-grid cell spans. The sampling stride s is
 * shared across axes (1/2/4 for near/mid/far; >= both spans for skybox), but
 * the boundary-collapse endpoints and the vertex-key row stride are per-axis
 * so variable-span regions still emit byte-identical shared-boundary vertices.
 */
export function regionMeshTopology(
  s: number,
  leftKept: number,
  rightKept: number,
  topKept: number,
  bottomKept: number,
  rx: number,
  rz: number,
): RegionTopology {
  const xs = axisPoints(Math.min(s, rx), rx);
  const zs = axisPoints(Math.min(s, rz), rz);
  const keptX = (kx: number, kz: number): number => {
    if (kz === 0) return collapseAlongEdge(kx, topKept, rx);
    if (kz === rz) return collapseAlongEdge(kx, bottomKept, rx);
    return kx;
  };
  const keptZ = (kx: number, kz: number): number => {
    if (kx === 0) return collapseAlongEdge(kz, leftKept, rz);
    if (kx === rx) return collapseAlongEdge(kz, rightKept, rz);
    return kz;
  };
  const key = (cx2: number, cz2: number): number => cz2 * (rx + 1) + cx2;
  const vertexIndex = new Map<number, number>();
  const vertexKeys: number[] = [];
  const getVertex = (kx: number, kz: number): number => {
    const kk = key(keptX(kx, kz), keptZ(kx, kz));
    const existing = vertexIndex.get(kk);
    if (existing !== undefined) return existing;
    const idx = vertexKeys.length;
    vertexIndex.set(kk, idx);
    vertexKeys.push(kk);
    return idx;
  };
  const indices: number[] = [];
  const pushTri = (a: number, b: number, c: number): void => {
    if (a === b || b === c || a === c) return;
    indices.push(a, c, b);
  };
  for (let j = 0; j < zs.length - 1; j += 1) {
    for (let i = 0; i < xs.length - 1; i += 1) {
      const a = getVertex(xs[i], zs[j]);
      const b = getVertex(xs[i + 1], zs[j]);
      const c = getVertex(xs[i], zs[j + 1]);
      const d = getVertex(xs[i + 1], zs[j + 1]);
      pushTri(a, b, c);
      pushTri(c, b, d);
    }
  }
  return { vertexKeys, indices };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

function lcm(a: number, b: number): number {
  return Math.max(1, Math.abs((a / gcd(a, b)) * b));
}

/** Sample coordinates along one axis: multiples of stride plus the endpoint R. */
function axisPoints(stride: number, r: number): number[] {
  const pts: number[] = [];
  for (let k = 0; k < r; k += stride) pts.push(k);
  pts.push(r);
  return pts;
}

/**
 * Kept-boundary stride for a region edge: the greatest common refinement of
 * both sides' sampling so neighboring regions keep identical edge vertices.
 * `spanAxis` is this region's own per-axis span for that edge.
 */
function edgeKeptStride(selfStride: number, neighborStride: number, spanAxis: number): number {
  const l = lcm(selfStride, neighborStride);
  return l > spanAxis ? spanAxis + 1 : l; // > spanAxis means only endpoints survive.
}

/** Collapse a dropped boundary coordinate to the nearest kept multiple (deterministic). */
function collapseAlongEdge(k: number, kept: number, spanAxis: number): number {
  if (k === spanAxis) return spanAxis;
  if (kept > spanAxis) return 0;
  const q = Math.floor(k / kept + 0.5) * kept;
  // Overshoot: snap to the shared endpoint spanAxis (both sides keep it) so the
  // two regions' boundary vertex sets stay identical. Folding to spanAxis - kept
  // produced a stray vertex only one side emitted -> a one-vertex crack.
  return q > spanAxis ? spanAxis : q;
}

export interface RegionMeshResult {
  region: LodRegion;
  buffers: TerrainMeshBuffers;
}

export interface BuildLodMeshesOptions {
  plan: LodPlan;
  uvScaleMeters?: number;
}

/**
 * Build crack-free meshes for every region in the plan.
 *
 * Heights come exclusively from the public `sampleHeight` seam at the
 * region's sampling positions; material/blending weights are evaluated by the
 * shader at original world coordinates regardless of tier (spec §11.2).
 */
export function buildLodRegionMeshes(
  terrain: TerrainLayer,
  options: BuildLodMeshesOptions,
): RegionMeshResult[] {
  const { plan } = options;
  const uvScale = options.uvScaleMeters ?? 8;
  const halfW = plan.worldWidth / 2;
  const halfD = plan.worldDepth / 2;
  const N = plan.vertexGrid - 1;
  const cell = plan.worldWidth / N;

  const results: RegionMeshResult[] = [];
  for (const region of plan.regions) {
    // M-P3: per-region span replaces the plan-wide scalar.
    const rx = region.spanX;
    const rz = region.spanZ;
    const e = regionEdgeStrides(plan, region);
    const s = e.s;
    const topo = regionMeshTopology(e.s, e.left, e.right, e.top, e.bottom, rx, rz);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    // M-P3: index-space worldAt maps local grid coords through base-grid cell
    // indices, so region i's right edge (kx=rx) and region i+1's left edge
    // (kx=0) both resolve to -halfW + b_{i+1}*cell — byte-identical boundary.
    const worldAt = (kx: number, kz: number): [number, number] => [
      -halfW + (region.cellStartX + kx) * cell,
      -halfD + (region.cellStartZ + kz) * cell,
    ];

    // Fill positions/normals/uvs for each emitted vertex key by decoding the
    // kept boundary coordinate baked into the key and sampling the PUBLIC seam
    // only. The index list comes straight from the shared topology, so the
    // built triangle count is identical to the budget estimator's prediction.
    const step = cell * Math.max(1, Math.min(s, rx), Math.min(s, rz));
    for (const vk of topo.vertexKeys) {
      const cx2 = vk % (rx + 1);
      const cz2 = Math.floor(vk / (rx + 1));
      const [wx, wz] = worldAt(cx2, cz2);
      const y = terrain.sampleHeight(wx, wz);
      positions.push(wx, y, wz);
      const hL = terrain.sampleHeight(wx - step, wz);
      const hR = terrain.sampleHeight(wx + step, wz);
      const hD = terrain.sampleHeight(wx, wz - step);
      const hU = terrain.sampleHeight(wx, wz + step);
      const dx = (hR - hL) / (2 * step);
      const dz = (hU - hD) / (2 * step);
      const nx = -dx;
      const nz = -dz;
      const len = Math.sqrt(nx * nx + 1 + nz * nz) || 1;
      normals.push(nx / len, 1 / len, nz / len);
      uvs.push(wx / uvScale, wz / uvScale);
    }
    const indices = topo.indices;
    const buffers: TerrainMeshBuffers = {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
      vertexGrid: plan.vertexGrid,
      worldWidth: plan.worldWidth,
      worldDepth: plan.worldDepth,
      spacing: cell * Math.max(1, Math.min(s, rx), Math.min(s, rz)),
      lodLevel: region.tier,
    };
    results.push({ region, buffers });
  }
  return results;
}

/**
 * Test/verification helper: collect the world positions along one edge of a
 * region mesh as rounded "x,y,z" keys. Two neighboring regions produce equal
 * edge sets when the tier boundary is watertight (spec §11.6 vertex-sharing
 * assertion).
 */
export function edgeVertexKeys(
  buffers: TerrainMeshBuffers,
  edge: "left" | "right" | "top" | "bottom",
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  tol = 1e-3,
): string[] {
  const keys: string[] = [];
  for (let i = 0; i < buffers.vertexCount; i += 1) {
    const x = buffers.positions[i * 3];
    const y = buffers.positions[i * 3 + 1];
    const z = buffers.positions[i * 3 + 2];
    const onEdge =
      (edge === "left" && Math.abs(x - bounds.minX) <= tol) ||
      (edge === "right" && Math.abs(x - bounds.maxX) <= tol) ||
      (edge === "top" && Math.abs(z - bounds.minZ) <= tol) ||
      (edge === "bottom" && Math.abs(z - bounds.maxZ) <= tol);
    if (onEdge) keys.push(`${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`);
  }
  return keys.sort();
}

/** Region world-space bounds helper for tests and the debug overlay. */
export function regionBounds(plan: LodPlan, cx: number, cz: number): {
  minX: number; maxX: number; minZ: number; maxZ: number;
} {
  // M-P3: bounds derive from the integer partition boundaries, not a uniform
  // division, so variable-span regions report their exact world rect.
  const cellX = plan.worldWidth / (plan.vertexGrid - 1);
  const cellZ = plan.worldDepth / (plan.vertexGrid - 1);
  const halfW = plan.worldWidth / 2;
  const halfD = plan.worldDepth / 2;
  const bx = partitionBoundaries(plan.spansAxis);
  const bz = partitionBoundaries(plan.spansAxis);
  return {
    minX: -halfW + bx[cx] * cellX,
    maxX: -halfW + bx[cx + 1] * cellX,
    minZ: -halfD + bz[cz] * cellZ,
    maxZ: -halfD + bz[cz + 1] * cellZ,
  };
}

/** Prefix-sum boundaries [b_0..b_n] from a per-axis span partition. */
function partitionBoundaries(spans: number[]): number[] {
  const out = [0];
  for (let i = 0; i < spans.length; i += 1) out.push(out[i] + spans[i]);
  return out;
}


/* ==================================================================== */
/* M-P5: pre-build all LOD tiers (build-once; camera selects)           */
/*                                                                       */
/* Spec §3.1/§3.3: bake every region at every resident tier ONCE at load; */
/* the camera path only flips mesh visibility, so the rebuild counter is  */
/* FLAT for any camera movement (strong-form P-AC-09). To make ONE bake  */
/* per tier stitch against ANY runtime neighbor tier, every region        */
/* perimeter is baked on one fixed fine lattice P (stride 1) while the    */
/* interior coarsens to the tier stride. edgeVertexKeys then coincide for */
/* all six {1,2,4} runtime pairs. edgeKeptStride / collapseAlongEdge /    */
/* lcm are NOT used or modified here; the perimeter is emitted directly   */
/* on lattice 1 (spec §3.3 "the one additive build change"). Winding of   */
/* the boundary fan matches the interior quads so the surface stays       */
/* consistently oriented (mesh-integrity / seam-stitch tests enforce it). */
/* ==================================================================== */

/** Tiers pre-baked per region (skybox is never a runtime selection target). */
export const PREBUILD_TIERS: readonly LodTier[] = ["near", "mid", "far"];

/** Interior sampling stride for a resident tier (skybox never baked). */
function tierStride(tier: LodTier): number {
  if (tier === "near") return 1;
  if (tier === "mid") return 2;
  if (tier === "far") return 4;
  return 1;
}

/**
 * Densified region topology: interior sampled at tier stride `s`, the four
 * perimeter rows/cols emitted on the fixed fine lattice P (stride 1). Returns
 * the SAME vertex-key encoding as regionMeshTopology (`cz*(rx+1)+cx`) and an
 * index list, so the caller reuses the existing worldAt/sampleHeight/normal
 * fill byte-for-byte. Interior band quads keep the existing (A,C,B)/(C,D,B)
 * winding; a boundary quad is re-triangulated as a polygon fan whose ring
 * expands each boundary edge to unit steps (coarse edges contribute only their
 * two corners), with the ring orientation chosen to match the interior winding.
 */
export function densifiedRegionTopology(
  s: number,
  rx: number,
  rz: number,
): RegionTopology {
  const W = rx + 1;
  const key = (cx: number, cz: number): number => cz * W + cx;
  const vertexIndex = new Map<number, number>();
  const vertexKeys: number[] = [];
  const coordOf: number[] = []; // parallel: packed cx*BIG+cz for winding sign
  const getVertex = (cx: number, cz: number): number => {
    const kk = key(cx, cz);
    const existing = vertexIndex.get(kk);
    if (existing !== undefined) return existing;
    const idx = vertexKeys.length;
    vertexIndex.set(kk, idx);
    vertexKeys.push(kk);
    coordOf.push(cx * 100000 + cz);
    return idx;
  };
  // Coarse sample lines (multiples of s plus the endpoint), matching axisPoints.
  const xs: number[] = [];
  for (let x = 0; x < rx; x += s) xs.push(x);
  if (xs[xs.length - 1] !== rx) xs.push(rx);
  const zs: number[] = [];
  for (let z = 0; z < rz; z += s) zs.push(z);
  if (zs[zs.length - 1] !== rz) zs.push(rz);
  for (const z of zs) for (const x of xs) getVertex(x, z);
  // Fixed fine perimeter lattice P (stride 1) on all four boundary lines.
  for (let x = 0; x <= rx; x += 1) { getVertex(x, 0); getVertex(x, rz); }
  for (let z = 0; z <= rz; z += 1) { getVertex(0, z); getVertex(rx, z); }

  const indices: number[] = [];
  const signedZ = (a: number, b: number, c: number): number => {
    const ax = coordOf[a] / 100000, az = coordOf[a] % 100000;
    const bx = coordOf[b] / 100000, bz = coordOf[b] % 100000;
    const cxp = coordOf[c] / 100000, czp = coordOf[c] % 100000;
    return (bx - ax) * (czp - az) - (bz - az) * (cxp - ax);
  };
  // Interior triangles emit (a,c,b) like the base pushTri; normalize the fan to
  // the same (negative-in-xz) orientation per triangle.
  const emit = (a: number, b: number, c: number): void => {
    if (a === b || b === c || a === c) return;
    if (signedZ(a, c, b) >= 0) { indices.push(a, b, c); } else { indices.push(a, c, b); }
  };
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < zs.length - 1; j += 1) {
      const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1];
      const onLeft = x0 === 0, onRight = x1 === rx, onTop = z0 === 0, onBottom = z1 === rz;
      const A = getVertex(x0, z0), B = getVertex(x1, z0), C = getVertex(x0, z1), D = getVertex(x1, z1);
      if (!(onLeft || onRight || onTop || onBottom)) { emit(A, B, C); emit(C, B, D); continue; }
      // Polygon ring: boundary edges expand to unit steps, coarse edges keep corners.
      const ring: number[] = [];
      if (onTop) for (let x = x0; x < x1; x += 1) ring.push(getVertex(x, z0)); else ring.push(A);
      if (onRight) for (let z = z0; z < z1; z += 1) ring.push(getVertex(x1, z)); else ring.push(B);
      if (onBottom) for (let x = x1; x > x0; x -= 1) ring.push(getVertex(x, z1)); else ring.push(D);
      if (onLeft) for (let z = z1; z > z0; z -= 1) ring.push(getVertex(x0, z)); else ring.push(C);
      for (let t = 1; t < ring.length - 1; t += 1) emit(ring[0], ring[t], ring[t + 1]);
    }
  }
  return { vertexKeys, indices };
}

/**
 * Bake ONE region `(cx,cz)` at `tier` with its perimeter densified to the fixed
 * fine lattice P (interior at tier stride). GL-free and deterministic; heights
 * come only from the public sampleHeight seam. Region interior + boundary
 * vertices are byte-identical in position to a normal build; the only delta is
 * the extra fine perimeter ring (spec §3.3). The public buildLodRegionMeshes
 * signature and the stitching math are untouched.
 */
export function buildTierForRegion(
  terrain: TerrainLayer,
  plan: LodPlan,
  region: LodRegion,
  tier: LodTier,
  uvScaleMeters = 8,
): RegionMeshResult {
  const halfW = plan.worldWidth / 2;
  const halfD = plan.worldDepth / 2;
  const N = plan.vertexGrid - 1;
  const cell = plan.worldWidth / N;
  const rx = region.spanX;
  const rz = region.spanZ;
  const s = tierStride(tier);
  const topo = densifiedRegionTopology(s, rx, rz);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const worldAt = (kx: number, kz: number): [number, number] => [
    -halfW + (region.cellStartX + kx) * cell,
    -halfD + (region.cellStartZ + kz) * cell,
  ];
  const step = cell * Math.max(1, Math.min(s, rx), Math.min(s, rz));
  for (const vk of topo.vertexKeys) {
    const cx2 = vk % (rx + 1);
    const cz2 = Math.floor(vk / (rx + 1));
    const [wx, wz] = worldAt(cx2, cz2);
    const y = terrain.sampleHeight(wx, wz);
    positions.push(wx, y, wz);
    const hL = terrain.sampleHeight(wx - step, wz);
    const hR = terrain.sampleHeight(wx + step, wz);
    const hD = terrain.sampleHeight(wx, wz - step);
    const hU = terrain.sampleHeight(wx, wz + step);
    const dx = (hR - hL) / (2 * step);
    const dz = (hU - hD) / (2 * step);
    const nx = -dx;
    const nz = -dz;
    const len = Math.sqrt(nx * nx + 1 + nz * nz) || 1;
    normals.push(nx / len, 1 / len, nz / len);
    uvs.push(wx / uvScaleMeters, wz / uvScaleMeters);
  }
  const buffers: TerrainMeshBuffers = {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(topo.indices),
    vertexCount: positions.length / 3,
    triangleCount: topo.indices.length / 3,
    vertexGrid: plan.vertexGrid,
    worldWidth: plan.worldWidth,
    worldDepth: plan.worldDepth,
    spacing: cell * Math.max(1, Math.min(s, rx), Math.min(s, rz)),
    lodLevel: tier,
  };
  const bakedRegion: LodRegion = { ...region, tier };
  return { region: bakedRegion, buffers };
}

/**
 * Pre-build every region at every resident tier (near/mid/far) with the fixed
 * shared-edge perimeter lattice. Outer key `cx + "," + cz`, inner key tier.
 * GL-free and deterministic — the renderer (wiring.ts) uploads these buffers to
 * the GPU and stores the resulting meshes; this module stays render-agnostic so
 * it is CI-verifiable (P-AC-13 tier residency, PM5-01 stitching).
 */
export function bakeAllTierMeshes(
  terrain: TerrainLayer,
  plan: LodPlan,
  uvScaleMeters = 8,
): Map<string, Map<LodTier, RegionMeshResult>> {
  const out = new Map<string, Map<LodTier, RegionMeshResult>>();
  for (const region of plan.regions) {
    const key = region.cx + "," + region.cz;
    const byTier = new Map<LodTier, RegionMeshResult>();
    for (const tier of PREBUILD_TIERS) {
      byTier.set(tier, buildTierForRegion(terrain, plan, region, tier, uvScaleMeters));
    }
    out.set(key, byTier);
  }
  return out;
}
