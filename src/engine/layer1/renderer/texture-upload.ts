import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import type { TextureBundle, SurfaceTextureSet } from "./textures.ts";
import type { SurfaceGpuMaps, TerrainSurfaceMaps } from "./terrain-renderer.ts";

/**
 * GPU upload layer for the M-T4 texture gate.
 *
 * textures.ts resolves the committed manifest into a TextureBundle of
 * descriptors carrying repo-local sourcePath strings; it is deliberately
 * filesystem- and THREE-agnostic so it stays unit-testable without a WebGL
 * context. This module is the one place that turns those approved paths into
 * live THREE.Texture objects the shader can sample, and it is only ever invoked
 * for an approved bundle — a placeholder bundle has sourcePath null on every map
 * and is never uploaded (placeholder renders stay color-backed, keeping Gate VIS
 * blocked until real CC0 pixels land).
 *
 * Paths are treated as URLs relative to the demo document (same convention the
 * M-T2 harness uses for its bundle script), so the browser loads them over the
 * page origin. Albedo is authored sRGB; normal/roughness/AO/height are linear
 * data maps and must NOT be color-managed (spec section 4).
 */

const MAP_TO_GPU_KEY: Record<string, keyof SurfaceGpuMaps | undefined> = {
  albedo: "albedo",
  normal: "normal",
  roughness: "roughness",
  ao: "ao",
};

function toGpuMaps(set: SurfaceTextureSet, loader: THREE.TextureLoader): SurfaceGpuMaps {
  const maps: SurfaceGpuMaps = { albedo: null, normal: null, roughness: null, ao: null, tileMeters: set.tileMeters };
  for (const map of set.maps) {
    const gpuKey = MAP_TO_GPU_KEY[map.map];
    // height is fetched for completeness but has no PBR sampler in the terrain
    // material (no displacement), so it is intentionally not uploaded.
    if (!gpuKey || !map.sourcePath) continue;
    const texture = loader.load(map.sourcePath);
    texture.colorSpace =
      map.colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    maps[gpuKey] = texture;
  }
  return maps;
}

/**
 * Build the per-surface GPU map record for buildTerrainMaterial. Only approved
 * surfaces (non-null sourcePath) produce textures; everything else is left null
 * so the shader falls back to per-surface colors for that surface.
 */
export function loadSurfaceGpuMaps(bundle: TextureBundle): TerrainSurfaceMaps {
  const loader = new THREE.TextureLoader();
  const out: TerrainSurfaceMaps = {};
  for (const [name, set] of Object.entries(bundle.surfaces)) {
    if (set.status !== "approved") continue;
    if (name === "sky" || name === "water") continue; // no PBR albedo set here
    const gpu = toGpuMaps(set, loader);
    if (gpu.albedo || gpu.normal || gpu.roughness || gpu.ao) {
      out[name as keyof TerrainSurfaceMaps] = gpu;
    }
  }
  return out;
}

/**
 * Load the approved HDRI as an equirectangular texture for image-based lighting.
 * Returns null when the sky is a placeholder, so a placeholder build keeps the
 * analytic sky only and never claims IBL. The caller assigns the resolved
 * PMREM cube to scene.environment via the onLoaded callback.
 */
export function loadEnvironment(
  bundle: TextureBundle,
  renderer: THREE.WebGLRenderer,
  onLoaded: (env: THREE.Texture) => void,
): void {
  const skyPath = bundle.sky.maps.find((m) => m.sourcePath)?.sourcePath ?? null;
  if (bundle.sky.status !== "approved" || !skyPath) return;
  const pmrem = new THREE.PMREMGenerator(renderer);
  new RGBELoader().load(skyPath, (tex) => {
    const env = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();
    onLoaded(env);
  });
}
