/*
 * S2 geomorphing - target-tier lookup DataTexture builder.
 * spec-layer1-geomorphing-s2.md section 4.6 / 4.9.
 *
 * The vertex morph (geomorph-shader.ts) samples the OPPOSITE (target) tier's
 * world position + world normal from a 2D lookup map, addressed by a region-
 * local uv derived from the mesh's own world xz. This module turns a baked
 * target-tier region mesh (already resident from M-P5 pre-build) into the two
 * DataTextures the morph reads, plus the region world bounds the shader uses
 * to derive that uv. Purely display-side: it reads an already-built
 * TerrainMeshBuffers, never samples terrain, never mutates terrain state.
 *
 * Region meshes are emitted as a regular row-major lattice (cx fastest) by
 * buildLodRegionMeshes / bakeAllTierMeshes, so the buffer maps cleanly onto a
 * cols x rows texture. We recover the lattice dimensions from the positions
 * themselves (first-row scan) so the builder is independent of tier stride.
 *
 * Determinism: no clock, no randomness, no iteration-order dependence (single
 * linear pass). FloatType RGBA textures so world positions are stored exactly.
 */

import * as THREE from "three";
import type { TerrainMeshBuffers } from "./types.ts";

export interface GeomorphLookup {
  positionMap: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  /** Region world-space bounds as [minX, minZ, maxX, maxZ] (shader vec4 order). */
  bounds: [number, number, number, number];
}

/**
 * Recover the lattice columns of a row-major region buffer by counting the
 * vertices that share the first vertex's Z (the first row). Falls back to 1
 * for degenerate buffers so the builder never throws.
 */
function detectCols(positions: Float32Array, vertexCount: number): number {
  if (vertexCount < 1) return 1;
  const z0 = positions[2];
  let cols = 1;
  for (let i = 1; i < vertexCount; i += 1) {
    if (positions[i * 3 + 2] === z0) cols += 1;
    else break;
  }
  return cols;
}

/**
 * Build the target-tier position + normal lookup textures from a baked region
 * buffer. `bounds` is the region world rect (regionBounds) used by the shader
 * to map world xz -> [0,1] uv. Both textures are Nearest-filtered and clamped
 * so a lookup lands on the nearest lattice sample (exact for shared edges).
 */
export function buildGeomorphLookup(
  buffers: TerrainMeshBuffers,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): GeomorphLookup {
  const vertexCount = buffers.vertexCount;
  const cols = Math.max(1, detectCols(buffers.positions, vertexCount));
  const rows = Math.max(1, Math.floor(vertexCount / cols));
  const texelCount = cols * rows;

  const posData = new Float32Array(texelCount * 4);
  const nrmData = new Float32Array(texelCount * 4);
  for (let i = 0; i < texelCount; i += 1) {
    const o = i * 3;
    posData[i * 4] = buffers.positions[o] ?? 0;
    posData[i * 4 + 1] = buffers.positions[o + 1] ?? 0;
    posData[i * 4 + 2] = buffers.positions[o + 2] ?? 0;
    posData[i * 4 + 3] = 1;
    // Encode world normal to [0,1] (decode is * 2 - 1 in the shader).
    nrmData[i * 4] = (buffers.normals[o] ?? 0) * 0.5 + 0.5;
    nrmData[i * 4 + 1] = (buffers.normals[o + 1] ?? 0) * 0.5 + 0.5;
    nrmData[i * 4 + 2] = (buffers.normals[o + 2] ?? 0) * 0.5 + 0.5;
    nrmData[i * 4 + 3] = 1;
  }

  const mkTexture = (data: Float32Array): THREE.DataTexture => {
    const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.FloatType);
    tex.flipY = false;
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    return tex;
  };

  return {
    positionMap: mkTexture(posData),
    normalMap: mkTexture(nrmData),
    bounds: [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ],
  };
}

/** Dispose both lookup textures (called on geometry-epoch rebuild). */
export function disposeGeomorphLookup(lookup: GeomorphLookup | null | undefined): void {
  if (!lookup) return;
  lookup.positionMap.dispose();
  lookup.normalMap.dispose();
}
