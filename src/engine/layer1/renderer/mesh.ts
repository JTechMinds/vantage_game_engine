/**
 * Layer 1 M-T2 renderer — terrain mesh pipeline.
 *
 * Builds indexed terrain geometry from the public Layer 1 terrain seam only.
 * Vertex heights come from `sampleHeight(x, z)` (the public heightfield seam);
 * the renderer never reads private height arrays, never regenerates terrain,
 * and never writes terrain state. Buffers returned here are derived display
 * caches (spec M-T2 §2, §3).
 *
 * Coordinate system (spec §3.2): XZ ground plane, Y up, world meters.
 * Grid index i maps to `x = (i / (N - 1) - 0.5) * worldWidth` and likewise for
 * z/`worldDepth`. Vertex Y is the sampled terrain height with no renderer-side
 * elevation scaling, biome offset, smoothing filter, or normalization (§3.4).
 */

import type {
  LodTier,
  MeshIntegrityReport,
  TerrainLayer,
  TerrainMeshBuffers,
} from "./types.ts";

/** Default world-meter tile size for UV calibration (spec §4). */
export const DEFAULT_UV_SCALE_METERS = 8;

/** Numerical tolerance for bounds and normal-length checks (spec §3.6). */
const INTEGRITY_TOLERANCE = 1e-6;
const BOUNDS_TOLERANCE_METERS = 1e-4;

export interface MeshBuildOptions {
  /** World width in meters (public snapshot metadata). */
  worldWidth: number;
  /** World depth in meters (public snapshot metadata). */
  worldDepth: number;
  /** Vertices per side of the regular grid to build (N >= 2). */
  vertexGrid: number;
  /** LOD tier label stored on the buffers. Default "near". */
  lodLevel?: LodTier;
  /** UV tile size in meters. Default 8. */
  uvScaleMeters?: number;
  /** World-space center of the grid. Default (0, 0). */
  centerX?: number;
  centerZ?: number;
}

export interface MeshIntegrityOptions {
  /** Optional expected triangle count override (default grid topology). */
  expectedTriangleCount?: number;
  /** Optional world-space bounds. Default full world centered at origin. */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Bounds tolerance in meters. Default 1e-4. */
  boundsTolerance?: number;
}

/**
 * Build a regular-grid terrain mesh from the public terrain seam.
 *
 * The same generated terrain and the same options produce byte-identical
 * position, normal, UV, and index buffers (determinism, spec §3.3).
 */
export function buildTerrainMesh(
  terrain: TerrainLayer,
  options: MeshBuildOptions,
): TerrainMeshBuffers {
  const vertexGrid = options.vertexGrid;
  if (!Number.isInteger(vertexGrid) || vertexGrid < 2) {
    throw new Error(
      `buildTerrainMesh requires an integer vertexGrid >= 2, received ${String(vertexGrid)}`,
    );
  }
  const worldWidth = options.worldWidth;
  const worldDepth = options.worldDepth;
  if (!Number.isFinite(worldWidth) || worldWidth <= 0 || !Number.isFinite(worldDepth) || worldDepth <= 0) {
    throw new Error(
      `buildTerrainMesh requires positive finite world size, received ${worldWidth}x${worldDepth}`,
    );
  }

  const centerX = options.centerX ?? 0;
  const centerZ = options.centerZ ?? 0;
  const uvScale = options.uvScaleMeters ?? DEFAULT_UV_SCALE_METERS;
  const lodLevel: LodTier = options.lodLevel ?? "near";

  const n = vertexGrid;
  const vertexCount = n * n;
  const spacingX = worldWidth / (n - 1);
  const spacingZ = worldDepth / (n - 1);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const heights = new Float64Array(vertexCount);

  // Pass 1: positions + sampled heights from the public seam only.
  for (let iz = 0; iz < n; iz += 1) {
    const z = (iz / (n - 1) - 0.5) * worldDepth + centerZ;
    for (let ix = 0; ix < n; ix += 1) {
      const x = (ix / (n - 1) - 0.5) * worldWidth + centerX;
      const y = terrain.sampleHeight(x, z);
      const vi = iz * n + ix;
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      heights[vi] = y;
      // World-meter UVs keep tiling density constant across the default world.
      // Slope-driven stretching is corrected in the shader via triplanar blend.
      uvs[vi * 2] = x / uvScale;
      uvs[vi * 2 + 1] = z / uvScale;
    }
  }

  // Pass 2: smooth normals from central differences (§3.5).
  // Interior uses central differences; edges use one-sided differences.
  for (let iz = 0; iz < n; iz += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      const vi = iz * n + ix;
      const h = heights[vi];

      let dx: number;
      if (ix === 0) {
        dx = (heights[vi + 1] - h) / spacingX;
      } else if (ix === n - 1) {
        dx = (h - heights[vi - 1]) / spacingX;
      } else {
        dx = (heights[vi + 1] - heights[vi - 1]) / (2 * spacingX);
      }

      let dz: number;
      if (iz === 0) {
        dz = (heights[vi + n] - h) / spacingZ;
      } else if (iz === n - 1) {
        dz = (h - heights[vi - n]) / spacingZ;
      } else {
        dz = (heights[vi + n] - heights[vi - n]) / (2 * spacingZ);
      }

      // normal = normalize(-dx, 1, -dz) with Y up.
      const nx = -dx;
      const ny = 1;
      const nz = -dz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0 && Number.isFinite(len)) {
        normals[vi * 3] = nx / len;
        normals[vi * 3 + 1] = ny / len;
        normals[vi * 3 + 2] = nz / len;
      } else {
        // Invalid gradient: leave NaN so the integrity check fails (§3.5).
        normals[vi * 3] = NaN;
        normals[vi * 3 + 1] = NaN;
        normals[vi * 3 + 2] = NaN;
      }
    }
  }

  // Pass 3: indexed triangles. Consistent winding: (a, c, b) then (c, d, b)
  // where a=(i,j), b=(i+1,j), c=(i,j+1), d=(i+1,j+1). This winding faces +Y
  // (documented, spec §3.3) and is used identically for every cell.
  const cells = (n - 1) * (n - 1);
  const indices = new Uint32Array(cells * 6);
  let w = 0;
  for (let iz = 0; iz < n - 1; iz += 1) {
    for (let ix = 0; ix < n - 1; ix += 1) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[w++] = a;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = d;
      indices[w++] = b;
    }
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    vertexCount,
    triangleCount: cells * 2,
    vertexGrid: n,
    worldWidth,
    worldDepth,
    spacing: spacingX,
    lodLevel,
  };
}

/**
 * Run the spec §3.8 mesh-integrity checks over built buffers.
 *
 * These checks are part of the M-T2 gate: automated tests inspect the report
 * and prove the mesh is clean before visual review. A failing check records a
 * structured error in the report; the renderer must not present a partially
 * corrupted scene as valid (§3.8).
 */
export function checkMeshIntegrity(
  mesh: TerrainMeshBuffers,
  options: MeshIntegrityOptions = {},
): MeshIntegrityReport {
  const n = mesh.vertexGrid;
  const expectedTriangleCount =
    options.expectedTriangleCount ?? 2 * (n - 1) * (n - 1);

  const bounds =
    options.bounds ?? {
      minX: -mesh.worldWidth / 2,
      maxX: mesh.worldWidth / 2,
      minZ: -mesh.worldDepth / 2,
      maxZ: mesh.worldDepth / 2,
    };
  const tol = options.boundsTolerance ?? BOUNDS_TOLERANCE_METERS;

  const errors: string[] = [];

  // 1 + 2 + 9: finite positions; finite Y; no NaN/Infinity in positions.
  let positionsFinite = true;
  let heightsFinite = true;
  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      positionsFinite = false;
    }
    if (!Number.isFinite(y)) {
      heightsFinite = false;
    } else {
      if (y < heightMin) heightMin = y;
      if (y > heightMax) heightMax = y;
    }
  }
  if (!positionsFinite) errors.push("vertex positions contain NaN or Infinity");
  if (!heightsFinite) errors.push("vertex heights contain NaN or Infinity");

  // 3: X/Z within world bounds within tolerance.
  let boundsValid = true;
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    const x = mesh.positions[i * 3];
    const z = mesh.positions[i * 3 + 2];
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      x < bounds.minX - tol ||
      x > bounds.maxX + tol ||
      z < bounds.minZ - tol ||
      z > bounds.maxZ + tol
    ) {
      boundsValid = false;
      break;
    }
  }
  if (!boundsValid) errors.push("vertex X/Z outside world bounds");

  // 4 + 6 + 10: indices valid, no degenerate triangles, no holes.
  let indicesValid = true;
  let noDegenerateTriangles = true;
  const referenced = new Uint8Array(mesh.vertexCount);
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    if (a >= mesh.vertexCount || b >= mesh.vertexCount || c >= mesh.vertexCount) {
      indicesValid = false;
      continue;
    }
    if (a === b || b === c || a === c) {
      noDegenerateTriangles = false;
    }
    referenced[a] = 1;
    referenced[b] = 1;
    referenced[c] = 1;
  }
  if (!indicesValid) errors.push("index buffer references invalid vertices");
  if (!noDegenerateTriangles) errors.push("degenerate triangle detected");

  let noHoles = true;
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    if (referenced[i] === 0) {
      noHoles = false;
      break;
    }
  }
  if (!noHoles) errors.push("grid has unreferenced vertices (missing cells / holes)");

  // 5: triangle count matches grid topology.
  const triangleCountMatches = mesh.triangleCount === expectedTriangleCount;
  if (!triangleCountMatches) {
    errors.push(
      `triangle count ${mesh.triangleCount} != expected ${expectedTriangleCount}`,
    );
  }

  // 7 + 8: normals finite and normalized.
  let normalsFinite = true;
  let normalsNormalized = true;
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    const nx = mesh.normals[i * 3];
    const ny = mesh.normals[i * 3 + 1];
    const nz = mesh.normals[i * 3 + 2];
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      normalsFinite = false;
      continue;
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!Number.isFinite(len) || Math.abs(len - 1) > 1e-3) {
      normalsNormalized = false;
    }
  }
  if (!normalsFinite) errors.push("normals contain NaN or Infinity");
  if (!normalsNormalized) errors.push("normals not unit length within tolerance");

  // 9: no NaN/Infinity in position or normal buffers (conjunction of checks).
  const noNaN = positionsFinite && normalsFinite;

  const pass =
    positionsFinite &&
    heightsFinite &&
    boundsValid &&
    indicesValid &&
    triangleCountMatches &&
    noDegenerateTriangles &&
    normalsFinite &&
    normalsNormalized &&
    noNaN &&
    noHoles;

  if (!Number.isFinite(heightMin)) heightMin = 0;
  if (!Number.isFinite(heightMax)) heightMax = 0;

  return {
    pass,
    positionsFinite,
    heightsFinite,
    boundsValid,
    indicesValid,
    triangleCountMatches,
    noDegenerateTriangles,
    normalsFinite,
    normalsNormalized,
    noNaN,
    noHoles,
    vertexGrid: n,
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
    expectedTriangleCount,
    worldWidth: mesh.worldWidth,
    worldDepth: mesh.worldDepth,
    heightMin,
    heightMax,
    errors,
  };
}

/** Human-readable mesh summary for the evidence note (spec §6). */
export function summarizeMeshIntegrity(report: MeshIntegrityReport): string {
  return [
    `grid=${report.vertexGrid}x${report.vertexGrid}`,
    `vertices=${report.vertexCount}`,
    `triangles=${report.triangleCount}/${report.expectedTriangleCount}`,
    `world=${report.worldWidth}x${report.worldDepth}m`,
    `height=[${report.heightMin.toFixed(2)}, ${report.heightMax.toFixed(2)}]m`,
    `pass=${report.pass}`,
  ].join(" ");
}
