/*
 * M-P1b frustum-culling primitives (spec-layer1-performance-mp1.md §3.2/§3.3).
 *
 * Single source of the "is this region inside the camera frustum (plus a bounded
 * safety margin)?" decision, shared by BOTH the headless sweep harness
 * (lod-sweep.estimateDrawnTriangles) and the mounted HUD/debug readout
 * (wiring.computeRenderStats). Sharing one implementation is what keeps the
 * harness `drawn=` honest against the real `gl.info.render.triangles` (§5.3).
 *
 * Why a module (not a couple of free functions): two independent consumers must
 * agree on identical culling semantics or the CI claim diverges from the shipped
 * behaviour. This is a genuine shared boundary, not speculative abstraction.
 *
 * Whole-mesh only: a region is in or out, never split, so no partial region and
 * no new T-junction can open from culling (P-AC-06). Culling never touches
 * geometry, positions, or the sampleHeight seam.
 *
 * Determinism: pure functions of (positions, camera, margin). No wall-clock, no
 * Math.random, no iteration-order dependence. A degenerate/NaN sphere is treated
 * as culled-out with no throw (§8 degenerate-sphere guard).
 */
import * as THREE from "three";
import type { CameraPose } from "./types.ts";

export interface CullCameraParams {
  fovDeg: number;
  aspect: number;
  near: number;
  far: number;
}

// Renderer defaults (terrain-renderer.ts PerspectiveCamera(55, 1, 0.5, 4000)).
export const DEFAULT_CULL_CAMERA: CullCameraParams = {
  fovDeg: 55,
  aspect: 1,
  near: 0.5,
  far: 4000,
};

export interface BoundingSphere {
  cx: number;
  cy: number;
  cz: number;
  r: number;
}

export interface CullItem {
  sphere: BoundingSphere;
  /** Triangles contributed by this whole mesh if it survives the frustum test. */
  triangles: number;
}

export interface CullResult {
  /** Triangles of surviving (in-frustum, margin-inflated) meshes. */
  drawn: number;
  /** All triangles regardless of culling (the built sum). */
  total: number;
  /** Number of meshes that survived the test. */
  kept: number;
  /** Total meshes considered. */
  meshes: number;
}

/**
 * Fit a bounding sphere to a flat [x,y,z,...] position array. Center is the
 * bbox midpoint; radius is the max vertex distance to that center. Deterministic
 * and dependency-free (no THREE allocation). Returns r=NaN for empty input so
 * the caller's degenerate guard rejects it rather than culling everything.
 */
export function sphereFromPositions(positions: ArrayLike<number>): BoundingSphere {
  const n = positions.length;
  if (n < 3) return { cx: NaN, cy: NaN, cz: NaN, r: NaN };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let r = 0;
  for (let i = 0; i < n; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r) r = d;
  }
  return { cx, cy, cz, r: Math.sqrt(r) };
}

/**
 * Build a PerspectiveCamera at a world pose (position + lookAt target) using the
 * renderer's projection defaults unless overridden. Used by the headless sweep,
 * which has no mounted camera. `updateMatrixWorld(true)` + `updateProjectionMatrix()`
 * are applied so buildFrustum reads fresh matrices (spec §8 staleness guard).
 */
export function makeFrustumCamera(
  pose: CameraPose,
  params: Partial<CullCameraParams> = {},
): THREE.PerspectiveCamera {
  const p = { ...DEFAULT_CULL_CAMERA, ...params };
  const cam = new THREE.PerspectiveCamera(p.fovDeg, p.aspect, p.near, p.far);
  cam.position.set(pose.x, pose.y, pose.z);
  cam.lookAt(pose.targetX, pose.targetY, pose.targetZ);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * Frustum for a camera, after forcing fresh world + projection matrices. Works
 * for both a constructed sweep camera and the mounted renderer camera (whose
 * position/lookAt were set manually in setCameraInternal).
 */
export function buildFrustum(cam: THREE.PerspectiveCamera): THREE.Frustum {
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const m = new THREE.Matrix4().multiplyMatrices(
    cam.projectionMatrix,
    cam.matrixWorldInverse,
  );
  return new THREE.Frustum().setFromProjectionMatrix(m);
}

/**
 * Sum triangles of whole meshes whose bounding sphere (inflated by `marginM`,
 * clamped to >= 0) intersects the frustum. A mesh is in or out — never partial.
 * A non-finite sphere radius is treated as culled-out (degenerate guard, §8).
 */
export function estimateDrawnTriangles(
  items: readonly CullItem[],
  frustum: THREE.Frustum,
  marginM: number,
): CullResult {
  const margin = Number.isFinite(marginM) && marginM > 0 ? marginM : 0;
  const center = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  let drawn = 0;
  let total = 0;
  let kept = 0;
  for (const it of items) {
    total += it.triangles;
    if (!Number.isFinite(it.sphere.r)) continue; // degenerate → culled out
    center.set(it.sphere.cx, it.sphere.cy, it.sphere.cz);
    sphere.center = center;
    sphere.radius = it.sphere.r + margin;
    if (frustum.intersectsSphere(sphere)) {
      drawn += it.triangles;
      kept += 1;
    }
  }
  return { drawn, total, kept, meshes: items.length };
}
