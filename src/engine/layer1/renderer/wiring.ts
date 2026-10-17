/* === Module header and imports === */

/**
 * Layer 1 M-T2 renderer — runtime wiring.
 *
 * This module holds the runtime glue between the terrain-renderer factory
 * (`terrain-renderer.ts`) and the pure mesh/lod/material/textures modules.
 * Everything here is display-only: it builds and updates the three.js scene
 * graph, uploads region meshes, applies appearance-only state through shader
 * uniforms and light values, drives the deterministic LOD pass, and assembles
 * the aggregate status object. It reads terrain strictly through the public
 * `sampleHeight` seam, `snapshot()`, `getParams()`, and the public event
 * stream, and it never writes terrain state, regenerates terrain, or shadows
 * the Layer 1 → Layer 2 `sampleHeight` contract (spec M-T2 §2, §10, §11.3;
 * L1-AC-154, L1-AC-157).
 *
 * The pure derivation lives in the sibling `mesh`, `lod`, `materials`, and
 * `textures` modules; the scene-graph construction helpers and the renderer
 * factory live in `terrain-renderer.ts`. This file wires those pieces to a
 * live WebGL context and to the camera/LOD/debug/status surface. There is a
 * deliberate import cycle between this module and `terrain-renderer.ts`
 * (factory ⇄ wiring); it is safe because every cross-module reference is a
 * function call resolved at runtime, never a top-level read during module
 * evaluation.
 */

import * as THREE from "three";
import {
  buildFrustum,
  estimateDrawnTriangles,
  type CullItem,
} from "./frustum-cull.ts";

import type { TerrainLayer, TerrainParams } from "../terrain/index.ts";

import type {
  CameraPose,
  LodConfig,
  LodDebugState,
  LodRegion,
  LodTier,
  MeshIntegrityReport,
  RendererOptions,
  RendererStatus,
  TerrainMeshBuffers,
} from "./types.ts";
import {
  buildLodRegionMeshes,
  planLodRegions,
  regionBounds,
  bakeAllTierMeshes,
  PREBUILD_TIERS,
  type LodPlan,
  type RegionMeshResult,
} from "./lod.ts";
import {
  lightingForTime,
  skyStateForTime,
  waterStateFromWind,
  materialWeightsAt,
  type LightingState,
  type SkyState,
  type WaterState,
} from "./materials.ts";
import type { TextureBundle, TextureStatus } from "./textures.ts";

import {
  DEFAULT_CAMERA_POSE,
  GEOMETRY_AFFECTING_KEYS,
  buildLighting,
  buildSkyDome,
  buildTerrainMaterial,
  buildWaterGeometry,
  buildWaterMaterial,
  buildWireframeOverlay,
  updateLighting,
  updateSkyDome,
} from "./terrain-renderer.ts";
import { loadSurfaceGpuMaps, loadEnvironment } from "./texture-upload.ts";
import { applyNearBudgetCeiling } from "./budget-ceiling.ts";
import {
  computeGeomorphStates,
  geomorphStepSize,
  geomorphBoundaries,
  DEFAULT_GEOMORPH_STEPS,
  type GeomorphBlendState,
  type GeomorphConfig,
} from "./geomorph.ts";
import {
  ensureGeomorphConfig,
  applyGeomorphTierSelection,
  makeGeomorphDrawHook,
  type GeomorphUniformStore,
} from "./geomorph-wiring.ts";
import {
  buildGeomorphLookup,
  disposeGeomorphLookup,
  type GeomorphLookup,
} from "./geomorph-lookup.ts";

/*
 * Adapter tuning constants mirrored from the scene-construction section of
 * `terrain-renderer.ts`. They are re-declared here (rather than imported)
 * because the adapter keeps them module-private; mirroring keeps the wiring's
 * water/sky geometry in lockstep with the adapter's own framing without
 * widening the adapter's public surface. Values MUST stay equal to the
 * adapter's private constants — the water/sky meshes built here are added to
 * the adapter's scene and share its framing assumptions.
 */

/** Fallback water surface Y when a snapshot reports no water level. */
const FALLBACK_WATER_LEVEL = 0;

/** Water plane subdivision density per axis for shoreline/foam/depth masks. */
const WATER_SEGMENTS_PER_AXIS = 64;

/** Sky dome radius as a fraction of world width (encloses the scene). */
const SKY_RADIUS_FACTOR = 0.9;

export interface RendererContext {
  options: RendererOptions & { textureBundle?: TextureBundle | null };
  terrain: TerrainLayer;
  canvas: HTMLCanvasElement;
  // Populated on mount().
  gl: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  terrainGroup: THREE.Group | null;
  wireframeGroup: THREE.Group | null;
  lodDebugGroup: THREE.Group | null;
  waterMesh: THREE.Mesh | null;
  skyMesh: THREE.Mesh | null;
  sunLight: THREE.DirectionalLight | null;
  hemiLight: THREE.HemisphereLight | null;
  ambientLight: THREE.AmbientLight | null;
  terrainMaterial: THREE.MeshStandardMaterial | null;
  // Derived render caches — never a terrain source of truth (spec §2, §10).
  plan: LodPlan | null;
  lodRegions: LodRegion[];
  lodConfig: LodConfig | null;
  cameraPose: CameraPose;
  baseMesh: TerrainMeshBuffers | null;
  clock: THREE.Clock | null;
  lastLighting: LightingState | null;
  lastSky: SkyState | null;
  lastWater: WaterState | null;
  lastAppliedParams: Readonly<TerrainParams> | null;
  lastBuiltParams: Readonly<TerrainParams> | null;
  lastMeshReport: MeshIntegrityReport | null;
  textureBundle: TextureBundle | null;
  textureStatus: TextureStatus;
  diagnostics: string[];
  // Debug overlay state. Default OFF for production review (spec §3.7, §11.4).
  wireframe: boolean;
  wireframeOverride: boolean | null;
  lodDebug: boolean;
  // Subscription + animation handles for dispose().
  unsubscribers: Array<() => void>;
  rafId: number;
  mounted: boolean;
  disposed: boolean;
  lastFrameTimeMs: number;
  // M-P1a camera-move rebuild guard state (renderer-internal, NOT public
  // surface). lastBuiltPlanSignature/lastBuiltEpoch record the (plan,
  // epoch) pair the region meshes were last built for; geometryEpoch is
  // bumped by every authoritative geometry-change seam so a regenerated
  // heightfield invalidates the cache even at an identical plan signature.
  // rebuildCount/renderCount are the PA-1a devOnly diagnostic counters.
  lastBuiltPlanSignature: string | null;
  lastBuiltEpoch: number;
  geometryEpoch: number;
  rebuildCount: number;
  renderCount: number;
  // IEP Phase-1 (spec-interactive-edit-preview-phase1.md section 3): a DISJOINT
  // commit-path counter, incremented exactly once per authoritative
  // full-resolution rebuildFromSnapshot. NEVER touched on the camera
  // cold-path guard (rebuildCount above), so P-AC-09 camera-sweep flatness
  // stays byte-identical. Non-enumerable (read via devOnly hook).
  commitRebuildCount: number;
  // IEP Phase-2 scaffold: the reduced-resolution live-preview regen counter.
  // Defined and plumbed in Phase 1 but never incremented - stays 0 for the
  // whole Phase 1 slice. Incremented only by a future preview path.
  previewRebuildCount: number;
  // M-P5 pre-build architecture (renderer-internal, NOT public surface).
  // regionMeshByTier holds every resident tier mesh per region (outer key
  // cx+","+cz, inner key tier). preBuiltComplete gates the cold-path rebuild;
  // residentMeshCount / tierSelectionCount are the honest devOnly counters
  // (spec 3.6). rebuildCount stays FLAT during camera movement (P-AC-09).
  regionMeshByTier: Map<string, Map<LodTier, THREE.Mesh>>;
  preBuiltComplete: boolean;
  residentMeshCount: number;
  tierSelectionCount: number;
  // S2 geomorphing state (renderer-internal, NOT public surface).
  // geomorphStates: active blend regions keyed by "cx,cz".
  geomorphStates: Map<string, import("./geomorph.ts").GeomorphBlendState>;
  geomorphConfig: import("./geomorph.ts").GeomorphConfig | null;
  geomorphBlendRegionCount: number;
  geomorphVisibleSetChangeCount: number;
  geomorphUnionDrawnPeak: number;
  /** Cached target-tier lookup DataTextures per "key|tier" (S2-AC-10). */
  geomorphLookupCache: Map<string, GeomorphLookup>;
  /** Back-reference installed by the factory so wiring can trigger rebuilds. */
  rebuildFromSnapshot: () => void;
  /**
   * IEP Phase-2: back-reference installed by the factory so the rAF loop pumps
   * at most one accepted preview regen per frame (latest-value-wins coalescing,
   * spec section 2C). Noop when no preview is active; never touches committed
   * counters.
   */
  previewPump: () => void;
}

/**
 * Build the full scene graph for a mounted renderer: terrain region group,
 * wireframe overlay group, LOD debug group, water surface, sky dome, lighting,
 * and the shared terrain material. Every handle stored on the context is
 * derived display state; nothing here reads private terrain data or writes
 * terrain state (spec §2, §10). Heights for the water depth mask come only
 * from the public `sampleHeight` seam, which clamps outside bounds and never
 * throws, so an over-sized water plane still resolves to finite ground values.
 */
export function buildSceneObjects(ctx: RendererContext): void {
  const scene = ctx.scene;
  if (!scene) return;
  const snap = ctx.terrain.snapshot();
  const worldMeters = snap.worldSize.meters;

  // Terrain regions (LOD meshes live here; replaced wholesale on rebuild).
  const terrainGroup = new THREE.Group();
  terrainGroup.name = "terrain-regions";
  scene.add(terrainGroup);
  ctx.terrainGroup = terrainGroup;

  // Wireframe topology overlay — off by default, display-only (spec §3.7).
  const wireframeGroup = new THREE.Group();
  wireframeGroup.name = "wireframe-group";
  wireframeGroup.visible = false;
  scene.add(wireframeGroup);
  ctx.wireframeGroup = wireframeGroup;

  // LOD tier debug overlay — off by default, never in Gate VIS (§11.4).
  const lodDebugGroup = new THREE.Group();
  lodDebugGroup.name = "lod-debug-group";
  lodDebugGroup.visible = false;
  scene.add(lodDebugGroup);
  ctx.lodDebugGroup = lodDebugGroup;

  // Water surface. Extends past the terrain edge so ocean/Caribbean scenes
  // read as open water; the depth attribute is sampled from the public seam.
  const waterMesh = new THREE.Mesh(
    buildWaterGeometry(
      worldMeters * 1.5,
      WATER_SEGMENTS_PER_AXIS,
      snap.waterLevel ?? FALLBACK_WATER_LEVEL,
      (x: number, z: number) => ctx.terrain.sampleHeight(x, z),
    ),
    buildWaterMaterial(),
  );
  waterMesh.name = "water-surface";
  waterMesh.frustumCulled = false;
  scene.add(waterMesh);
  waterMesh.visible = snap.waterLevel !== null && snap.waterFraction > 0;
  ctx.waterMesh = waterMesh;

  // Live sky dome (analytic shader; time-of-day + wind pushed per frame).
  const skyMesh = buildSkyDome(SKY_RADIUS_FACTOR * worldMeters);
  scene.add(skyMesh);
  ctx.skyMesh = skyMesh;

  // Shared time-of-day lighting rig (sun + hemisphere ambient).
  const { group: lightGroup, sun, hemi, ambient } = buildLighting();
  scene.add(lightGroup);
  ctx.sunLight = sun;
  ctx.hemiLight = hemi;
  ctx.ambientLight = ambient;

  // Terrain PBR material. GPU maps are bound from the texture bundle when
  // approved pixels exist; while the bundle is placeholder the shader falls
  // back to per-surface colors and the bundle's status keeps Gate VIS
  // blocked, so a placeholder render is never reported as approved.
  // Bind any individually-approved surface maps regardless of the aggregate
  // bundle status: an approved surface carries real CC0 pixels and must render
  // even while another required surface (e.g. escalated water) keeps the
  // aggregate status placeholder. loadSurfaceGpuMaps skips every placeholder
  // surface internally, so a fully-placeholder bundle resolves to an empty
  // record and the shader falls back to per-surface colors.
  const gpuMaps = ctx.textureBundle ? loadSurfaceGpuMaps(ctx.textureBundle) : {};
  ctx.terrainMaterial = buildTerrainMaterial(gpuMaps);

  // Sky IBL: approved HDRI -> scene.environment (spec M-T4). No-op for placeholder sky.
  if (ctx.gl && ctx.textureBundle && !(globalThis as any).__noibl) {
    loadEnvironment(ctx.textureBundle, ctx.gl, (env) => {
      if (ctx.scene) ctx.scene.environment = env;
    });
  }
}

/**
 * Rebuild the water surface after a generation event. Water level and the
 * per-vertex depth mask are snapshot-derived, so a geometry-affecting change
 * refreshes the water mesh too (spec §2 event handling). The previous geometry
 * is disposed to avoid leaking GPU buffers across regenerations.
 */
export function updateWaterSurface(ctx: RendererContext): void {
  const scene = ctx.scene;
  if (!scene) return;
  const snap = ctx.terrain.snapshot();
  const worldMeters = snap.worldSize.meters;
  const nextGeometry = buildWaterGeometry(
    worldMeters * 1.5,
    WATER_SEGMENTS_PER_AXIS,
    snap.waterLevel ?? FALLBACK_WATER_LEVEL,
    (x: number, z: number) => ctx.terrain.sampleHeight(x, z),
  );
  if (ctx.waterMesh) {
    ctx.waterMesh.geometry.dispose();
    ctx.waterMesh.geometry = nextGeometry;
    ctx.waterMesh.visible = snap.waterLevel !== null && snap.waterFraction > 0;
  } else {
    const waterMesh = new THREE.Mesh(nextGeometry, buildWaterMaterial());
    waterMesh.name = "water-surface";
    waterMesh.frustumCulled = false;
    scene.add(waterMesh);
    waterMesh.visible = snap.waterLevel !== null && snap.waterFraction > 0;
    ctx.waterMesh = waterMesh;
  }
}

/**
 * Release every GPU resource held by the scene graph and clear the scene.
 * Idempotent; safe to call from dispose() before the GL context is torn down.
 * Disposes each geometry and material exactly once and nulls the context
 * handles so a second call does nothing.
 */
export function disposeSceneObjects(ctx: RendererContext): void {
  const scene = ctx.scene;
  if (!scene) return;
  scene.traverse((obj) => {
    const withGeometry = obj as Partial<THREE.Mesh> & Partial<THREE.LineSegments>;
    if (!withGeometry.geometry) return;
    withGeometry.geometry.dispose();
    const material = withGeometry.material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else if (material) {
      material.dispose();
    }
  });
  scene.clear();
  ctx.terrainGroup = null;
  ctx.wireframeGroup = null;
  ctx.lodDebugGroup = null;
  ctx.waterMesh = null;
  ctx.skyMesh = null;
  ctx.sunLight = null;
  ctx.hemiLight = null;
  ctx.ambientLight = null;
  for (const l of ctx.geomorphLookupCache.values()) disposeGeomorphLookup(l);
  ctx.geomorphLookupCache.clear();
  ctx.terrainMaterial = null;
}

/**
 * Sync the WebGL renderer size and camera aspect ratio to the canvas'
 * client dimensions. Falls back to the canvas backing-store size when the
 * element has no layout box (offscreen/headless). Never reads terrain state.
 */
export function resizeToCanvas(ctx: RendererContext): void {
  const canvas = ctx.canvas;
  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  if (ctx.gl) {
    ctx.gl.setSize(width, height, false);
  }
  if (ctx.camera) {
    ctx.camera.aspect = width / height;
    ctx.camera.updateProjectionMatrix();
  }
}

/* === Helpers used by the factory === */

/**
 * Bridge helpers between the terrain-renderer factory and the runtime wiring.
 *
 * The factory (`terrain-renderer.ts`) and this module share one mutable
 * `RendererContext`. Everything here is a thin, side-effect-free constructor
 * or re-export the factory needs so it does not have to import `three`
 * internals directly. Like the rest of this module, nothing in this section
 * touches terrain state — these are display-side handles only (spec §2, §10).
 */

/**
 * Construct the shared animation clock used by the render loop and the
 * appearance path. A single `THREE.Clock` instance is stored on the context
 * (`ctx.clock`) so water/sky animation time stays consistent across frames
 * and both modules read the same elapsed value.
 */
export function createDefaultClock(): THREE.Clock {
  return new THREE.Clock();
}
/* === Material weight attribute === */

/**
 * Compute the per-vertex PBR surface-blend weights consumed by the terrain
 * material shader (spec §4, §11.2).
 *
 * Inputs are strictly public-derived:
 * - vertex Y values were sampled from the public `sampleHeight` seam;
 * - `heightMin`/`heightMax` come from the public snapshot metadata;
 * - slope is `1 - normalY` from the mesh's smooth render normals;
 * - `params.biome` selects the blend profile in `materialWeightsAt`.
 *
 * The output packs sand/rock/grass/soil into a vec4 (shader channel order);
 * the shader derives snow as `1 - dot(weights, vec4(1))`, so the four stored
 * weights sum to at most 1 and every transition stays continuous. Weights are
 * evaluated at the vertex's own world coordinate regardless of LOD tier, so
 * tier changes never introduce material discontinuity at region boundaries
 * (§11.2). The returned array is display data only and never feeds back into
 * terrain state.
 */
export function computeMaterialWeightAttribute(
  buffers: TerrainMeshBuffers,
  params: Readonly<TerrainParams>,
  heightMin: number,
  heightMax: number,
): Float32Array {
  const weights = new Float32Array(buffers.vertexCount * 4);
  const span = heightMax - heightMin;
  for (let i = 0; i < buffers.vertexCount; i += 1) {
    const y = buffers.positions[i * 3 + 1];
    const ny = buffers.normals[i * 3 + 1];
    const normalizedHeight =
      span > 0 && Number.isFinite(span) ? (y - heightMin) / span : 0;
    const slope = 1 - Math.min(1, Math.max(0, Number.isFinite(ny) ? ny : 1));
    const w = materialWeightsAt(params, normalizedHeight, slope);
    weights[i * 4] = w.sand;
    weights[i * 4 + 1] = w.rock;
    weights[i * 4 + 2] = w.grass;
    weights[i * 4 + 3] = w.soil;
  }
  return weights;
}

/**
 * Attach the computed weight vec4 as the `aMaterialWeights` attribute expected
 * by the terrain material's injected shader. Kept separate from the raw
 * computation so tests can assert the attribute buffer directly without a GPU.
 */
export function attachMaterialWeights(
  geometry: THREE.BufferGeometry,
  buffers: TerrainMeshBuffers,
  params: Readonly<TerrainParams>,
  heightMin: number,
  heightMax: number,
): Float32Array {
  const weights = computeMaterialWeightAttribute(buffers, params, heightMin, heightMax);
  geometry.setAttribute("aMaterialWeights", new THREE.BufferAttribute(weights, 4));
  return weights;
}

/* === Region mesh upload === */

/**
 * Replace the terrain group's contents with meshes for the given LOD regions.
 *
 * Each region becomes one indexed BufferGeometry carrying position, normal, uv,
 * the aMaterialWeights attribute, and its index buffer. Old geometries are
 * disposed before removal so camera moves and geometry rebuilds do not leak GPU
 * buffers. The meshes are derived display data built from the public seam;
 * nothing here writes terrain state (spec §11.3, L1-AC-157).
 */
export function uploadRegionMeshes(
  ctx: RendererContext,
  built: readonly RegionMeshResult[],
): void {
  const group = ctx.terrainGroup;
  if (!group) return;

  // Dispose + detach the previous region meshes first.
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
    }
    group.remove(child);
  }

  const params = ctx.terrain.getParams();
  const snap = ctx.terrain.snapshot();

  for (const { region, buffers } of built) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(buffers.uvs, 2));
    geometry.setAttribute(
      "aMaterialWeights",
      new THREE.BufferAttribute(
        computeMaterialWeightAttribute(buffers, params, snap.heightMin, snap.heightMax),
        4,
      ),
    );
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, ctx.terrainMaterial);
    if (!mesh) continue;
    mesh.name = `terrain-${region.cx}-${region.cz}-${region.tier}`;
    // M-P1b: terrain region meshes ARE frustum-culled (three.js default). The
    // geometry.boundingSphere computed just above is what the frustum test uses.
    // Only terrain geometry is culled; water/sky/LOD-overlay/force-basic remain
    // frustumCulled=false (spec 4.3) because they are full-scene or debug-only.
    mesh.frustumCulled = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

/**
 * Rebuild the wireframe topology overlay from the same base (near-tier) mesh
 * that passed integrity checks (spec §3.7). This is a LineSegments pass over a
 * WireframeGeometry clone of the base geometry; it never alters vertex
 * positions, normals, materials, generation, or sampling. Off by default and
 * fully disabled for Gate VIS captures.
 */
export function updateWireframeOverlay(ctx: RendererContext): void {
  const group = ctx.wireframeGroup;
  const base = ctx.baseMesh;
  if (!group) return;

  // Drop any previous overlay geometry before rebuilding.
  for (const child of [...group.children]) {
    const line = child as THREE.LineSegments;
    if (line.isLineSegments || line.isMesh) {
      line.geometry.dispose();
    }
    group.remove(child);
  }
  if (!base) return;

  const source = new THREE.BufferGeometry();
  source.setAttribute("position", new THREE.BufferAttribute(base.positions, 3));
  source.setAttribute("normal", new THREE.BufferAttribute(base.normals, 3));
  source.setAttribute("uv", new THREE.BufferAttribute(base.uvs, 2));
  source.setIndex(new THREE.BufferAttribute(base.indices, 1));

  const overlay = buildWireframeOverlay(source);
  // buildWireframeOverlay clones into a WireframeGeometry; the temporary source
  // is disposable once the line pass owns its own buffer.
  source.dispose();
  overlay.visible = ctx.wireframeOverride ?? ctx.terrain.getParams().wireframe;
  group.add(overlay);
}

/* === Parameter response === */

/* ------------------------------------------------------------------ */
/* Parameter response (spec §2, §4, §5)                                */
/* ------------------------------------------------------------------ */

/** Base sky cloud-drift speed at wind 0, plus the wind-driven increment.
 * Cloud/atmospheric motion is a uniform advance, never a geometry change. */
const SKY_DRIFT_BASE = 0.004;
const SKY_DRIFT_WIND_SCALE = 0.02;

/** Water body colors: depth-aware biomes (Caribbean/water) get the full
 * turquoise→deep-blue gradient; other biomes keep a calmer, lower-contrast
 * pair so stray water never reads as a tropical lagoon. Values are linear. */
const SHALLOW_COLOR_DEPTH_AWARE: [number, number, number] = [0.25, 0.75, 0.72];
const SHALLOW_COLOR_NEUTRAL: [number, number, number] = [0.2, 0.42, 0.45];
const DEEP_COLOR: [number, number, number] = [0.02, 0.16, 0.34];

/**
 * Apply appearance-only state to the live scene from public parameter values.
 *
 * Every visual system is driven by the SAME derived states so the scene stays
 * in lockstep: `lightingForTime` positions the sun and tints the hemisphere
 * ambient, `skyStateForTime` colors the sky dome gradient, and
 * `waterStateFromWind` sets ripple amplitude/speed/orientation plus the shared
 * reflection tone. Nothing in this path rebuilds geometry, calls any terrain
 * mutation method, or reads private terrain state — it is uniform/light/flag
 * application only, which keeps live edits inside the 250 ms bar (spec §6)
 * while time-of-day and wind never regenerate (L1-AC-060, L1-AC-066,
 * L1-AC-067, L1-AC-090).
 *
 * Wind orientation enters both the water and sky shaders as cos/sin of the
 * wind angle, so a change across the 0/360 boundary moves continuously
 * instead of snapping (spec §5 edge cases).
 */
export function applyAppearanceInternal(
  ctx: RendererContext,
  params: Readonly<TerrainParams>,
): void {
  const lighting = lightingForTime(params.timeOfDay);
  const sky = skyStateForTime(params.timeOfDay);
  const water = waterStateFromWind(params.windIntensity, params.windDirection, params.biome);
  ctx.lastLighting = lighting;
  ctx.lastSky = sky;
  ctx.lastWater = water;

  const snap = ctx.terrain.snapshot();
  const worldMeters = snap.worldSize.meters;

  // Sun + hemisphere ambient from the shared time-of-day model (spec §4).
  if (ctx.sunLight && ctx.hemiLight) {
    updateLighting(ctx.sunLight, ctx.hemiLight, lighting, worldMeters, ctx.ambientLight ?? undefined);
  }

  // Sky dome: gradient, sun glow, and wind-driven cloud drift (spec §5).
  const elapsed = ctx.clock?.elapsedTime ?? 0;
  const windDrift = SKY_DRIFT_BASE + water.rippleSpeed * SKY_DRIFT_WIND_SCALE;
  if (ctx.skyMesh) {
    updateSkyDome(ctx.skyMesh, sky, lighting, elapsed, windDrift);
  }

  // Water: ripple amplitude/speed/orientation from wind, shared sky tint and
  // sun for reflection, depth-driven body colors. Wind intensity 0 leaves the
  // residual minimum from waterStateFromWind, so the surface reads calm
  // rather than frozen (spec §5 edge cases).
  if (ctx.waterMesh) {
    const u = (ctx.waterMesh.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value = elapsed;
    u.uWaterLevel.value = snap.waterLevel ?? FALLBACK_WATER_LEVEL;
    u.uWindDir.value.set(Math.cos(water.windDirectionRad), Math.sin(water.windDirectionRad));
    u.uWindAmp.value = water.rippleAmplitude;
    u.uWindSpeed.value = water.rippleSpeed;
    u.uSunDir.value.set(lighting.sunDir[0], lighting.sunDir[1], lighting.sunDir[2]);
    u.uSunColor.value.setRGB(lighting.sunColor[0], lighting.sunColor[1], lighting.sunColor[2]);
    u.uZenith.value.setRGB(sky.zenithColor[0], sky.zenithColor[1], sky.zenithColor[2]);
    u.uHorizon.value.setRGB(sky.horizonColor[0], sky.horizonColor[1], sky.horizonColor[2]);
    const shallow = water.depthVisible ? SHALLOW_COLOR_DEPTH_AWARE : SHALLOW_COLOR_NEUTRAL;
    u.uShallowColor.value.setRGB(shallow[0], shallow[1], shallow[2]);
    u.uDeepColor.value.setRGB(DEEP_COLOR[0], DEEP_COLOR[1], DEEP_COLOR[2]);
  }

  // Wireframe follows the public model flag; the renderer-local toggle set
  // through setWireframeInternal is a display alias that overrides only the
  // overlay — never generation, sampling, or materials (spec §3.7, L1-AC-103).
  if (ctx.wireframeGroup) {
    ctx.wireframeGroup.visible = ctx.wireframeOverride ?? params.wireframe;
  }

  ctx.lastAppliedParams = { ...params };
}

/**
 * Route a `terrain-changed` event payload to the correct response path
 * (spec §2). Geometry-affecting key changes reconcile geometry (the core has
 * regenerated or is about to); appearance-only changes apply through uniforms.
 * The core decides *whether* regeneration happens; the renderer only reacts.
 *
 * `generation-complete` is the authoritative geometry signal and is handled
 * separately by the mount subscription; this router covers `terrain-changed`
 * surfacing outside a generation cycle (e.g. deserialize/load) and the
 * appearance-only path (time of day, wind, wireframe).
 */
export function routeTerrainChange(
  ctx: RendererContext,
  payload: { params: Readonly<TerrainParams> },
): void {
  const prev = ctx.lastBuiltParams;
  const next = payload.params;
  if (prev && geometryKeysDiffer(prev, next)) {
    // Geometry-affecting change outside a generation-complete event:
    // reconcile geometry from the new snapshot, then refresh appearance.
    ctx.rebuildFromSnapshot();
    ctx.lastBuiltParams = { ...next };
  }
  applyAppearanceInternal(ctx, next);
}

/**
 * True when any geometry-affecting parameter key differs between two sets.
 * Appearance-only keys (timeOfDay, windIntensity, windDirection, wireframe)
 * are deliberately excluded so live lighting/wind edits never pay the mesh
 * rebuild cost (spec §3.3).
 */
export function geometryKeysDiffer(
  prev: Readonly<TerrainParams>,
  next: Readonly<TerrainParams>,
): boolean {
  for (const key of GEOMETRY_AFFECTING_KEYS) {
    if (prev[key] !== next[key]) return true;
  }
  return false;
}

/* === Camera and LOD === */

/* ------------------------------------------------------------------ */
/* Camera and LOD (spec §11)                                           */
/* ------------------------------------------------------------------ */

/**
 * Update the camera pose and re-run the deterministic LOD pass.
 *
 * Tier assignment is a pure function of camera pose + snapshot world size,
 * so the same camera + same terrain state produces the identical region plan
 * every frame (L1-AC-153). Re-planning rebuilds region meshes strictly from
 * the public `sampleHeight` seam via the lod module: it never writes terrain
 * state, never shadows `sampleHeight`, and introduces no secondary sampling
 * path (L1-AC-154, L1-AC-157). Material blending is evaluated in the shader
 * at original world coordinates regardless of which tier renders a region,
 * so tier changes introduce no material discontinuity at boundaries (§11.2).
 *
 * Scene appearance is affected here only through tessellation; time of day
 * and wind are handled by applyAppearanceInternal, never by this path.
 */
/**
 * Deterministic signature of everything a built region mesh depends on.
 *
 * Includes the grid/world fields, the tier thresholds, and the ordered
 * (cx, cz, tier) triple per region - the exact inputs that change built
 * vertices. It deliberately EXCLUDES the continuous camera-derived fields
 * (distance/centerDistance and centerX/centerZ): once a region tier is
 * fixed, its tessellation is a pure function of tier + snapshot, not of raw
 * camera distance. Including those fields would make every sub-tier pan look
 * like a plan change and defeat the short-circuit (the 0-FPS cause). This
 * exclusion is the crux of M-P1a; see spec 3.1 and diag Q2.
 *
 * Pure: no wall-clock, no Math.random, no object identity. Region enumeration
 * order is the plan own deterministic order, so the signature is stable.
 */
export function planSignature(plan: LodPlan): string {
  const c = plan.config;
  let out =
    plan.regionsPerAxis + "," + plan.regionSpan + "," + plan.vertexGrid + "," +
    plan.worldWidth + "," + plan.worldDepth + "," +
    c.nearM + "," + c.maxMidM + "," + c.maxFarM + ";";
  for (const r of plan.regions) out += r.cx + ":" + r.cz + ":" + r.tier + ",";
  // M-P2: fold the internal budget-stride override into the signature so a
  // stride demotion (tier unchanged) still forces one rebuild. Sorted by key
  // for determinism; empty/absent map adds nothing (pre-M-P2 byte-identical).
  const bs = plan.budgetStride;
  if (bs && bs.size) {
    out += ";b=";
    for (const k of [...bs.keys()].sort()) out += k + ":" + bs.get(k) + ",";
  }
  return out;
}

export function setCameraInternal(ctx: RendererContext, pose: CameraPose): void {
  if (
    !Number.isFinite(pose.x) ||
    !Number.isFinite(pose.y) ||
    !Number.isFinite(pose.z) ||
    !Number.isFinite(pose.targetX) ||
    !Number.isFinite(pose.targetY) ||
    !Number.isFinite(pose.targetZ)
  ) {
    ctx.diagnostics.push("setCamera received non-finite pose; ignored");
    return;
  }

  ctx.cameraPose = { ...pose };
  if (ctx.camera) {
    ctx.camera.position.set(pose.x, pose.y, pose.z);
    ctx.camera.lookAt(pose.targetX, pose.targetY, pose.targetZ);
  }

  const snap = ctx.terrain.snapshot();
  if (!snap.generated) {
    // No heightfield yet: the LOD pass would sample ungenerated terrain.
    // Keep the previous plan; the rebuild path re-plans after generation.
    return;
  }

  // M-P5 cold path (spec 3.1): pre-build every resident tier ONCE per geometry
  // epoch. buildLodRegionMeshes/uploadRegionMeshes run ONLY here; a camera move
  // that does not change the geometry epoch NEVER rebuilds, so rebuildCount is
  // FLAT for any camera movement (strong-form P-AC-09). An epoch bump (regen /
  // deserialize via rebuildFromSnapshot) or the first build forces exactly one
  // pre-build event (+1); every subsequent move is a pure tier-selection flip.
  if (ctx.geometryEpoch !== ctx.lastBuiltEpoch || !ctx.preBuiltComplete) {
    ctx.rebuildCount += 1;
    preBuildAllTiers(ctx);
    ctx.lastBuiltEpoch = ctx.geometryEpoch;
    if (ctx.lodDebug) {
      refreshLodDebugOverlay(ctx);
    }
  }

  // M-P5 hot path (spec 3.2): pure tier selection + visible flip. No build,
  // no upload, no sampleHeight, no typed-array allocation, no Mesh constructed
  // or disposed. The deterministic plan is still recomputed per camera so the
  // public getLodRegions() tier observability (L1-AC-153) reflects the current
  // pose; selection reads it. renderOnce runs because the view matrix changed.
  const snapPlan = ctx.terrain.snapshot();
  const curPlan = planLodRegions({
    worldWidth: snapPlan.worldSize.meters,
    worldDepth: snapPlan.worldSize.meters,
    vertexGrid: snapPlan.worldSize.vertices,
    camera: ctx.cameraPose,
    config: ctx.lodConfig ?? {},
  });
  ctx.plan = curPlan;
  ctx.lodRegions = curPlan.regions;
  const tierAssignment = selectTiersForPlan(ctx, curPlan);
  // S2 geomorphing: compute blend states and apply geomorph-aware visibility.
  const geomorphCfg = ensureGeomorphConfig(ctx, curPlan);
  const geomorphStates = computeGeomorphStates(curPlan, tierAssignment, geomorphCfg, ctx.diagnostics);
  const prevGeomorphStates = ctx.geomorphStates;
  ctx.geomorphStates = geomorphStates;
  ctx.geomorphBlendRegionCount = geomorphStates.size;
  applyGeomorphTierSelection(ctx, tierAssignment, geomorphStates, prevGeomorphStates);

  renderOnce(ctx);
}

/* === M-P5 pre-build + tier selection (spec 3.1 / 3.2 / 3.4) === */

/**
 * Pre-build every region at every resident tier (near/mid/far) with the fixed
 * shared-edge perimeter lattice, upload the buffers to the GPU, and store the
 * meshes in ctx.regionMeshByTier. This is the ONLY place the region-mesh build
 * machinery runs after M-P5. GL-free-safe: on the headless (unmounted) path it
 * records the plan and marks the epoch satisfied so the camera guard
 * short-circuits, but builds no GPU meshes. After a real build it runs an
 * initial tier selection so a boot frame presents the correct tier set.
 */
export function preBuildAllTiers(ctx: RendererContext): void {
  const snap = ctx.terrain.snapshot();
  if (!snap.generated) {
    ctx.diagnostics.push("preBuild skipped: terrain snapshot is not generated");
    return;
  }
  const basePlan = planLodRegions({
    worldWidth: snap.worldSize.meters,
    worldDepth: snap.worldSize.meters,
    vertexGrid: snap.worldSize.vertices,
    camera: ctx.cameraPose,
    config: ctx.lodConfig ?? {},
  });
  ctx.plan = basePlan;
  ctx.lodRegions = basePlan.regions;

  if (ctx.scene && ctx.terrainGroup && ctx.terrainMaterial) {
    const baked = bakeAllTierMeshes(ctx.terrain, basePlan);
    uploadTierMeshes(ctx, baked);
    ctx.preBuiltComplete = true;
    ctx.residentMeshCount = baked.size * PREBUILD_TIERS.length;
    applyTierSelection(ctx, selectTiersByDistance(ctx, ctx.cameraPose));
    updateWireframeOverlay(ctx);
    updateWaterSurface(ctx);
  } else {
    // Headless / pre-mount: no GPU meshes to build or select, but the epoch is
    // satisfied so the camera path short-circuits (matches PA-1a-01 semantics).
    ctx.preBuiltComplete = true;
    ctx.residentMeshCount = 0;
  }
}

/**
 * Upload the pre-baked tier buffers into the scene: one THREE.Mesh per
 * (region, tier), all parented to terrainGroup and indexed by tier. Every mesh
 * starts visible=false; applyTierSelection flips the selected tier on. Old
 * geometries are disposed so a re-pre-build (epoch bump) leaks no GPU buffers.
 * Heights/weights come only from the public seam via bakeAllTierMeshes.
 */
export function uploadTierMeshes(
  ctx: RendererContext,
  baked: Map<string, Map<LodTier, RegionMeshResult>>,
): void {
  const group = ctx.terrainGroup;
  if (!group) return;
  // Dispose + detach the previous resident meshes first.
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
    group.remove(child);
  }
  ctx.regionMeshByTier = new Map();

  // Rebuild the geomorph target-tier lookup cache for this geometry epoch.
  // A lookup turns a baked resident-tier region buffer into the position +
  // normal DataTextures + region bounds the vertex morph samples. Built once
  // here (NOT per frame) so the draw hook only reads a cached entry.
  for (const l of ctx.geomorphLookupCache.values()) disposeGeomorphLookup(l);
  ctx.geomorphLookupCache = new Map();
  const lookupCache = ctx.geomorphLookupCache;
  const geomorphStore = (ctx.terrainMaterial.userData as { geomorphUniforms?: GeomorphUniformStore })
    .geomorphUniforms ?? null;

  const params = ctx.terrain.getParams();
  const snap = ctx.terrain.snapshot();
  for (const [key, byTier] of baked) {
    const tierMap = new Map<LodTier, THREE.Mesh>();
    for (const [tier, result] of byTier) {
      const { region, buffers } = result;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(buffers.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(buffers.normals, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(buffers.uvs, 2));
      geometry.setAttribute(
        "aMaterialWeights",
        new THREE.BufferAttribute(
          computeMaterialWeightAttribute(buffers, params, snap.heightMin, snap.heightMax),
          4,
        ),
      );
      geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, ctx.terrainMaterial);
      if (!mesh) continue;
      mesh.name = `terrain-${region.cx}-${region.cz}-${tier}`;
      // M-P1b interaction (spec 3.5): selected tiers ARE frustum-culled; the
      // unselected tiers start visible=false so the frustum pass never touches
      // them. frustumCulled stays true so a flipped-on tier culls correctly.
      mesh.frustumCulled = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      // S2-AC-10: precompute this (region,tier) target lookup and install the
      // per-draw hook. three.js calls onBeforeRender immediately before THIS
      // mesh's draw, right before setProgram re-reads material.uniforms and
      // material.polygonOffset, so mutating the shared store + material here
      // yields correct per-draw morph activation + polygon-offset bias without
      // cloning the material. resolveLookup is closed over this region key.
      const bounds = regionBounds(ctx.plan!, region.cx, region.cz);
      lookupCache.set(key + "|" + tier, buildGeomorphLookup(buffers, bounds));
      mesh.onBeforeRender = makeGeomorphDrawHook(
        geomorphStore,
        mesh,
        (tt: LodTier) => lookupCache.get(key + "|" + tt) ?? null,
        ctx.terrainMaterial,
      );
      group.add(mesh);
      tierMap.set(tier, mesh);
    }
    ctx.regionMeshByTier.set(key, tierMap);
  }
}

/**
 * M-P5 tier selection (spec 3.2 step 2 + 3.4). Pure + deterministic: for each
 * region pick the tier the camera distance falls into (same thresholds as
 * planLodRegions), with two selection-time overrides:
 *   - skybox is never a resident tier, so a skybox-assigned region clamps to
 *     the farthest resident tier (far).
 *   - M-P2 near-budget ceiling rebound: a region the ceiling demotes that would
 *     select near instead selects mid. The ceiling map is a SELECTION input, not
 *     a build input; the drawn tier for a pose is unchanged vs build-time
 *     demotion (P-AC-03/04 assertions stay on drawn, unchanged).
 */
export function selectTiersByDistance(
  ctx: RendererContext,
  pose: CameraPose,
): Map<string, LodTier> {
  const snap = ctx.terrain.snapshot();
  const basePlan = planLodRegions({
    worldWidth: snap.worldSize.meters,
    worldDepth: snap.worldSize.meters,
    vertexGrid: snap.worldSize.vertices,
    camera: pose,
    config: ctx.lodConfig ?? {},
  });
  return selectTiersForPlan(ctx, basePlan);
}

/**
 * M-P5 selection given an ALREADY-computed plan (the hot path computes the plan
 * once for observability and reuses it here). Same rules as selectTiersByDistance.
 */
export function selectTiersForPlan(
  ctx: RendererContext,
  basePlan: LodPlan,
): Map<string, LodTier> {
  const eff = applyBudgetCeilingForCamera(ctx, basePlan);
  const ceiling = eff.budgetStride;
  const out = new Map<string, LodTier>();
  for (const r of basePlan.regions) {
    let tier: LodTier = r.tier;
    if (tier === "skybox") tier = "far";
    if (tier === "near" && ceiling && ceiling.has(r.cx + "," + r.cz)) tier = "mid";
    out.set(r.cx + "," + r.cz, tier);
  }
  return out;
}

/**
 * M-P5 draw selection (spec 3.2 step 3): flip each region's selected-tier mesh
 * visible and the other two hidden. No build / no allocation. tierSelectionCount
 * increments only when the visible set actually changes (spec 3.6).
 */
export function applyTierSelection(
  ctx: RendererContext,
  assignment: Map<string, LodTier>,
): void {
  let changed = false;
  for (const [key, byTier] of ctx.regionMeshByTier) {
    const sel = assignment.get(key);
    for (const [tier, mesh] of byTier) {
      const want = tier === sel;
      if (mesh.visible !== want) {
        mesh.visible = want;
        changed = true;
      }
    }
  }
  if (changed) ctx.tierSelectionCount += 1;
}

/* === Debug overlays === */

/* ------------------------------------------------------------------ */
/* Debug overlays (spec §3.7, §11.4)                                   */
/* ------------------------------------------------------------------ */

/**
 * Fixed tier → debug color (linear RGB) for the LOD overlay (spec §11.4).
 * Deterministic so the same tier always colors identically across frames and
 * runs, keeping the overlay a stable verification surface rather than a moving
 * target. Never enabled in a production or Gate VIS build.
 */
const LOD_TIER_COLORS: Record<LodTier, [number, number, number]> = {
  near: [0.1, 0.8, 0.2],
  mid: [0.9, 0.8, 0.1],
  far: [0.9, 0.4, 0.1],
  skybox: [0.7, 0.1, 0.1],
};

/** Lift tier tiles just above the terrain footprint so they read cleanly. */
const LOD_DEBUG_Y_LIFT = 30;

/**
 * Toggle the wireframe topology overlay (spec §3.7). This flips visibility on
 * the existing line pass only — it never touches vertex positions, normals,
 * materials, generation, or sampling (L1-AC-103). Off by default and never
 * enabled in a production/Gate VIS build (L1-AC-104). The public model flag
 * (`params.wireframe`) remains observable through the core; this renderer-local
 * toggle is a display alias that overrides only the overlay.
 */
export function setWireframeInternal(ctx: RendererContext, enabled: boolean): void {
  ctx.wireframeOverride = enabled;
  if (ctx.wireframeGroup) {
    ctx.wireframeGroup.visible = enabled;
  }
  renderOnce(ctx);
}

/**
 * Toggle the LOD tier-coloring overlay (spec §11.4, L1-AC-155). Off by default;
 * hidden in production builds and never present in Gate VIS captures. Enabling
 * it re-renders the tier footprint for the current plan; disabling it only
 * hides the group (the plan itself is unaffected). Writes no terrain state.
 */
export function setLodDebugInternal(ctx: RendererContext, enabled: boolean): void {
  ctx.lodDebug = enabled;
  if (ctx.lodDebugGroup) {
    ctx.lodDebugGroup.visible = enabled;
  }
  if (enabled && ctx.plan) {
    refreshLodDebugOverlay(ctx);
  }
  renderOnce(ctx);
}

/**
 * Rebuild the LOD debug overlay as flat tier-colored quads at each region
 * footprint. Purely visual: it reads the current plan and region bounds and
 * writes no terrain state. Old overlay geometries are disposed before rebuild
 * so repeated camera moves do not leak GPU buffers. Kept in a dedicated group
 * so it can be shown/hidden independently of the scene and excluded from
 * production captures by leaving the toggle off.
 */
export function refreshLodDebugOverlay(ctx: RendererContext): void {
  const group = ctx.lodDebugGroup;
  const plan = ctx.plan;
  if (!group || !plan) return;

  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
    group.remove(mesh);
  }

  for (const region of plan.regions) {
    const y = (px: number, pz: number) => ctx.terrain.sampleHeight(px, pz) + LOD_DEBUG_Y_LIFT;
    const geometry = new THREE.BufferGeometry();
    const verts = new Float32Array([
      minX, y(minX, minZ), minZ,
      maxX, y(maxX, minZ), minZ,
      maxX, y(maxX, maxZ), maxZ,
      minX, y(minX, minZ), minZ,
      maxX, y(maxX, maxZ), maxZ,
      minX, y(minX, maxZ), maxZ,
    ]);
    const color = LOD_TIER_COLORS[region.tier];
    const colors = new Float32Array(6 * 3);
    for (let i = 0; i < 6; i += 1) {
      colors[i * 3] = color[0];
      colors[i * 3 + 1] = color[1];
      colors[i * 3 + 2] = color[2];
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `loddebug-${region.cx}-${region.cz}`;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  group.visible = ctx.lodDebug;
}

/* === Render loop === */

/**
 * Convert a millisecond origin into elapsed seconds. Used as a fallback clock
 * when a `THREE.Clock` is not available (tests, headless smoke checks).
 */
export function elapsedSeconds(startMs: number): number {
  const now =
    typeof globalThis.performance?.now === "function"
      ? globalThis.performance.now()
      : Date.now();
  return (now - startMs) / 1000;
}

/**
 * Advance continuous animation state for one frame (spec §5).
 *
 * Water ripples and sky/cloud drift advance from wall-clock time, not from
 * parameter events: wind intensity/direction shape the motion, but a frame
 * with no parameter change still animates. The drift speed derives from the
 * last applied water state so the sky and the water surface share one wind
 * model; with wind=0 the residual minimum keeps the surface calm rather than
 * frozen (spec §5 edge cases). Writes only shader uniforms — no geometry,
 * no terrain state.
 */
export function advanceAnimation(ctx: RendererContext, elapsed: number): void {
  const water = ctx.lastWater;
  const windDrift = SKY_DRIFT_BASE + (water ? water.rippleSpeed * SKY_DRIFT_WIND_SCALE : 0);

  if (ctx.skyMesh) {
    const uniforms = (ctx.skyMesh.material as THREE.ShaderMaterial).uniforms;
    uniforms.uTime.value = elapsed;
    uniforms.uWindDrift.value = windDrift;
  }

  if (ctx.waterMesh) {
    const uniforms = (ctx.waterMesh.material as THREE.ShaderMaterial).uniforms;
    uniforms.uTime.value = elapsed;
    if (water) {
      uniforms.uWindAmp.value = water.rippleAmplitude;
      uniforms.uWindSpeed.value = water.rippleSpeed;
      // cos/sin of the wind angle keeps ripple orientation continuous across
      // the 0/360-degree boundary (spec §5).
      uniforms.uWindDir.value.set(
        Math.cos(water.windDirectionRad),
        Math.sin(water.windDirectionRad),
      );
    }
  }
}

/**
 * Render one frame. Dispose-safe: after `dispose()` (or before `mount()`
 * completes) this is a no-op rather than a crash on torn-down GL handles.
 */
export function renderOnce(ctx: RendererContext): void {
  // M-P1a: count every draw attempt, including headless no-ops, so a
  // test can prove the view was re-rendered on a short-circuited camera move
  // (the view matrix changed even though geometry did not).
  ctx.renderCount += 1;
  if (ctx.disposed || !ctx.gl || !ctx.scene || !ctx.camera) return;
  ctx.gl.render(ctx.scene, ctx.camera);
}

/**
 * Start the requestAnimationFrame loop. Idempotent: a second call while a
 * loop is live is ignored. Each frame advances the shared clock, pushes wind
 * animation, and redraws. The loop self-terminates as soon as `disposed` is
 * set, and `dispose()` cancels the pending frame handle, so teardown never
 * leaves a dangling rAF callback.
 */
export function startRenderLoop(ctx: RendererContext): void {
  if (ctx.disposed || ctx.rafId) return;
  if (!ctx.clock) {
    ctx.clock = new THREE.Clock();
  }
  const clock = ctx.clock;

  const frame = (): void => {
    if (ctx.disposed) {
      ctx.rafId = 0;
      return;
    }
    const elapsed = clock.getElapsedTime();
    advanceAnimation(ctx, elapsed);
    // IEP Phase-2: run at most one accepted live-preview regen per frame.
    // Noop unless a preview is active; never a full commit (spec section 2C).
    ctx.previewPump();
    renderOnce(ctx);
    ctx.rafId = globalThis.requestAnimationFrame?.(frame) ?? 0;
  };

  ctx.rafId = globalThis.requestAnimationFrame?.(frame) ?? 0;
}

/* === Status assembly === */

/**
 * Assemble the aggregate renderer status consumed by tests, telemetry, and
 * Gate VIS evidence notes (spec §6, §11.4).
 *
 * Every field is derived display state read from the renderer context: the
 * latest mesh-integrity report, the current LOD debug state (with a copy of
 * the region plan so callers cannot mutate rendering internals), the bound
 * texture bundle status, and a copy of accumulated diagnostics. Nothing here
 * reads private terrain data or writes terrain state — the headless core
 * remains the sole source of truth (L1-AC-154, L1-AC-157).
 *
 * The texture status is authoritative from the bound bundle when one exists:
 * a placeholder-backed render reports "placeholder" and keeps Gate VIS
 * blocked; it is never reported as an approved/Gate-VIS pass (spec §6 PBR
 * texture blocker handling).
 */
export function assembleRendererStatus(ctx: RendererContext): RendererStatus {
  const lod: LodDebugState = {
    enabled: ctx.lodDebug,
    // Copy: deterministic tier assignments (L1-AC-153) exposed read-only.
    regions: ctx.lodRegions.slice(),
    overlayVisible:
      ctx.lodDebug && ctx.lodDebugGroup !== null && ctx.lodDebugGroup.visible,
  };

  const meshReport = ctx.lastMeshReport;

  return {
    // Defensive copy so an external mutation cannot corrupt the gate report.
    mesh: meshReport
      ? { ...meshReport, errors: meshReport.errors.slice() }
      : null,
    lod,
    // Bundle status wins when a bundle is bound; the context label is the
    // fallback for pre-mount or explicitly-labeled placeholder builds.
    textureStatus: ctx.textureBundle
      ? ctx.textureBundle.status
      : ctx.textureStatus,
    diagnostics: ctx.diagnostics.slice(),
  };
}

/**
 * Read-only scene-graph summary for browser visual verification (spec 6).
 * Reports camera world position, the terrain group world-space bounding box,
 * and region/triangle counts. Touches no terrain state and mutates nothing -
 * purely an observability affordance so a browser capture can confirm the
 * render camera and terrain sheet are co-located without console access.
 */
export function hideSkyWaterInternal(ctx: RendererContext, hidden: boolean): void {
  if (ctx.skyMesh) ctx.skyMesh.visible = !hidden;
  if (ctx.waterMesh) ctx.waterMesh.visible = !hidden;
  renderOnce(ctx);
}

export function debugGlErrorInternal(ctx: RendererContext): string {
  if (!ctx.gl) return "no-gl";
  const gl = ctx.gl.getContext();
  const err = gl.getError();
  const m = ctx.terrainMaterial;
  const prog = ctx.gl.properties?.get(m, "program") as WebGLProgram | undefined;
  const log = prog ? gl.getProgramInfoLog(prog) : "no-prog";
  const terr = ctx.terrainGroup;
  const drawn = terr ? terr.children.length : -1;
  return "glErr=" + err + " log=" + (log ? String(log).slice(0, 80) : "ok") + " drawn=" + drawn;
}

export function debugSceneGraphInternal(ctx: RendererContext): string {
  if (!ctx.scene) return "no-scene";
  const g = ctx.terrainGroup;
  const kids = g ? g.children.length : -1;
  const parented = g ? g.parent === ctx.scene : false;
  const vis = g ? g.visible : false;
  let meshPos = -1, matType = "?", matVis = false, bs = "?";
  if (g && g.children.length) {
    const m0 = g.children[0] as any;
    const pos = m0.geometry?.getAttribute?.("position");
    meshPos = pos ? pos.count : -2;
    matType = m0.material?.type || "?";
    matVis = m0.visible;
    if (m0.geometry) { m0.geometry.computeBoundingSphere(); const bs0 = m0.geometry.boundingSphere; bs = bs0 ? `c(${bs0.center.x.toFixed(0)},${bs0.center.y.toFixed(0)},${bs0.center.z.toFixed(0)}) r${bs0.radius.toFixed(0)}` : "null-bs"; }
  }
  const cam = ctx.camera;
  const camS = cam ? `pos(${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)}) far${cam.far} near${cam.near}` : "no-cam";
  return `kids=${kids} parented=${parented} grpVis=${vis} meshVis=${matVis} mat=${matType} meshPos=${meshPos} bs=${bs} ${camS}`;
}

export function debugForceBasicInternal(ctx: RendererContext): string {
  if (!ctx.terrainGroup) return "no-grp";
  const flat = new THREE.MeshBasicMaterial({ color: 0x33cc66, side: THREE.DoubleSide });
  let idxTotal = 0, big = 0, verts = 0;
  for (const child of ctx.terrainGroup.children) {
    (child as any).material = flat; (child as any).frustumCulled = false;
    const idx = (child as any).geometry?.getIndex?.();
    const pos = (child as any).geometry?.getAttribute?.("position");
    idxTotal += idx ? idx.count : 0;
    verts += pos ? pos.count : 0;
    if (pos && pos.count > 8) big += 1;
  }
  renderOnce(ctx);
  return `idx=${idxTotal} verts=${verts} big=${big}/${ctx.terrainGroup.children.length}`;
}

export function debugClearColorInternal(ctx: RendererContext, hex: number): void {
  if (ctx.gl) ctx.gl.setClearColor(hex, 1);
  renderOnce(ctx);
}

/**
 * Pixel-level LOD seam probe (M-T2 §7.17 regression, added with the
 * tier-boundary stitch fix). Isolates the terrain sheet (sky, water, overlays
 * hidden; clear color pure magenta), renders once, then reads the framebuffer
 * and scans every row inside the projected terrain bounding box: any magenta
 * pixel strictly between the first and last covered pixel of a row is a
 * crack/T-junction letting the background leak through the surface.
 * Returns "seam:PASS leaks=0 rows=N" or "seam:FAIL leaks=N ...".
 * Dev-only; mutates display state only, never terrain state.
 */
export function seamCheckInternal(ctx: RendererContext): string {
  if (!ctx.gl || !ctx.scene || !ctx.camera || !ctx.terrainGroup) return "seam:ERR no-scene";
  if (ctx.skyMesh) ctx.skyMesh.visible = false;
  if (ctx.waterMesh) ctx.waterMesh.visible = false;
  if (ctx.wireframeGroup) ctx.wireframeGroup.visible = false;
  if (ctx.lodDebugGroup) ctx.lodDebugGroup.visible = false;
  ctx.gl.setClearColor(0xff00ff, 1);
  renderOnce(ctx);
  const gl = ctx.gl.getContext();
  const wPx = ctx.canvas.width;
  const hPx = ctx.canvas.height;
  const px = new Uint8Array(wPx * hPx * 4);
  gl.readPixels(0, 0, wPx, hPx, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = wPx * hPx;
  const covered = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const magenta = r > 200 && g < 90 && b > 200;
    covered[i] = magenta ? 0 : 1;
  }
  // Flood-fill background (magenta) reachable from the image border: that is the
  // legitimate outer silhouette (sky beyond the world edge). Any magenta NOT
  // reachable is an ENCLOSED hole = a crack letting the background through the
  // terrain sheet. A row first/last scan would false-positive on the real sky
  // visible in valleys between peaks, so we use 4-connected enclosure.
  const outer = new Uint8Array(n);
  const stack: number[] = [];
  const push = (i: number) => { if (!covered[i] && !outer[i]) { outer[i] = 1; stack.push(i); } };
  for (let x = 0; x < wPx; x += 1) { push(x); push((hPx - 1) * wPx + x); }
  for (let y = 0; y < hPx; y += 1) { push(y * wPx); push(y * wPx + wPx - 1); }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % wPx, y = (i / wPx) | 0;
    if (x > 0) push(i - 1);
    if (x < wPx - 1) push(i + 1);
    if (y > 0) push(i - wPx);
    if (y < hPx - 1) push(i + wPx);
  }
  let holes = 0;
  for (let i = 0; i < n; i += 1) if (!covered[i] && !outer[i]) holes += 1;
  let cov = 0; for (let i = 0; i < n; i += 1) if (covered[i]) cov += 1;
  if (cov < n * 0.15) return "seam:ERR low-coverage cov=" + cov;
  return holes === 0
    ? "seam:PASS holes=0 cov=" + cov + " " + wPx + "x" + hPx
    : "seam:FAIL holes=" + holes + " cov=" + cov + " " + wPx + "x" + hPx;
}
export function debugSceneSummaryInternal(ctx: RendererContext): string {
  if (!ctx.scene || !ctx.camera) return "no-scene";
  const cam = ctx.camera.position;
  let bb = "no-terrain";
  if (ctx.terrainGroup) {
    const box = new THREE.Box3().setFromObject(ctx.terrainGroup);
    if (!box.isEmpty()) {
      bb = "x[" + box.min.x.toFixed(0) + "," + box.max.x.toFixed(0) + "] y[" + box.min.y.toFixed(0) + "," + box.max.y.toFixed(0) + "] z[" + box.min.z.toFixed(0) + "," + box.max.z.toFixed(0) + "]";
    }
  }
  const stats = computeRenderStats(ctx);
  return formatRenderStats({ cam, meshes: stats.meshes, built: stats.built, drawn: stats.drawn, culled: stats.culled, bbox: bb });
}

/**
 * Single source of the built-triangle sum across the terrain region meshes
 * (M-P0 observability). Returns 0 when the terrain group is absent (pre-mount /
 * no-terrain) rather than throwing. M-P1 wraps this call site with frustum
 * culling to derive the true post-cull drawn count.
 */
export function computeBuiltTriangles(ctx: RendererContext): number {
  if (!ctx.terrainGroup) return 0;
  let tris = 0;
  for (const child of ctx.terrainGroup.children) {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      const idx = mesh.geometry.getIndex();
      const posAttr = mesh.geometry.getAttribute("position");
      tris += idx ? idx.count / 3 : (posAttr ? posAttr.count / 3 : 0);
    }
  }
  return tris;
}

/**
 * Per-frame render-stats readout (M-P0). Culling is still off in this slice
 * (terrain meshes are frustumCulled=false), so drawn == built and culled is
 * false; the culled=false / culled=off flag is the honest signal that drawn is
 * a built proxy until M-P1 lands. It never reads ctx.gl on the headless path,
 * so it is CI-verifiable with no WebGL context. M-P1 subtracts frustum-rejected
 * regions here and flips culled to true.
 */
export function computeRenderStats(ctx: RendererContext): {
  built: number;
  drawn: number;
  meshes: number;
  culled: boolean;
} {
  const built = computeBuiltTriangles(ctx);
  let meshes = 0;
  if (ctx.terrainGroup) {
    for (const child of ctx.terrainGroup.children) {
      if ((child as THREE.Mesh).isMesh) meshes += 1;
    }
  }
  // M-P1b: engage frustum culling ONLY when a camera exists (mounted). The
  // unmounted/no-camera path keeps the M-P0 built-proxy (culled=false,
  // drawn=built) so the pre-mount guard and headless hook tests stay honest.
  if (ctx.camera && ctx.terrainGroup) {
    // M-P5: only the SELECTED (visible) tier per region is a draw candidate.
    // Unselected tiers are visible=false and excluded from drawn AND the mesh
    // count; built (computeBuiltTriangles) still sums every resident tier, so
    // the built floor reflects the ~3x resident posture (spec 3.7).
    const items: CullItem[] = [];
    let visibleMeshes = 0;
    for (const child of ctx.terrainGroup.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      if (!mesh.visible) continue;
      visibleMeshes += 1;
      const idx = mesh.geometry.getIndex();
      const posAttr = mesh.geometry.getAttribute("position");
      const tris = idx ? idx.count / 3 : (posAttr ? posAttr.count / 3 : 0);
      const bs = mesh.geometry.boundingSphere;
      items.push({
        sphere: bs
          ? { cx: bs.center.x, cy: bs.center.y, cz: bs.center.z, r: bs.radius }
          : { cx: NaN, cy: NaN, cz: NaN, r: NaN },
        triangles: tris,
      });
    }
    const res = estimateDrawnTriangles(items, buildFrustum(ctx.camera), cullMarginFromPlan(ctx.plan));
    const drawnNow = Math.min(res.drawn, built);
    // S2-AC-05: track the union-drawn peak observed on blend frames.
    if (ctx.geomorphBlendRegionCount > 0 && drawnNow > ctx.geomorphUnionDrawnPeak) {
      ctx.geomorphUnionDrawnPeak = drawnNow;
    }
    return { built, drawn: drawnNow, meshes: visibleMeshes, culled: true };
  }
  const culled = false; // no camera: built proxy until M-P1b engages culling.
  return { built, drawn: built, meshes, culled };
}

/**
 * Anti-pop safety margin for the mounted frustum test = one region span
 * (regionSpan * cell), matching the sweep default so HUD drawn= and the
 * harness agree (spec 3.3). Falls back to a conservative 64 m if no plan yet.
 */
/**
 * M-P2: run the near-budget ceiling for the mounted camera, returning an
 * effective plan (possibly with internal budgetStride overrides). With no
 * camera (headless pre-mount) the base plan ships unchanged. The frustum and
 * margin match computeRenderStats so the ceiling prediction equals the
 * reported drawn count (§6.6). Records an UNMET diagnostic on cascade
 * exhaustion (Q4 escalation signal) instead of looping or shrinking the world.
 */
export function applyBudgetCeilingForCamera(ctx: RendererContext, basePlan: LodPlan): LodPlan {
  if (!ctx.camera || !basePlan) return basePlan;
  const frustum = buildFrustum(ctx.camera);
  const margin = cullMarginFromPlan(basePlan);
  const res = applyNearBudgetCeiling(basePlan, {
    terrain: ctx.terrain,
    frustum,
    marginM: margin,
    vertexCount: basePlan.vertexGrid * basePlan.vertexGrid,
  });
  for (const d of res.diagnostics) ctx.diagnostics.push(d);
  return res.plan;
}

function cullMarginFromPlan(plan) {
  if (!plan || plan.vertexGrid <= 1) return 64;
  const cell = plan.worldWidth / (plan.vertexGrid - 1);
  return Math.max(1, plan.regionSpan) * cell;
}

/**
 * Pure renderer-stats copy formatter (P-AC-07). The headline is drawn= (the
 * post-cull count); built= is a clearly secondary diagnostic; tris= is kept as
 * a backward-compatible alias for built= so existing browser-evidence greps
 * that read the old token keep working. culled=off signals drawn==built is the
 * no-cull state, not a measurement error; M-P1 flips it to culled=on.
 * cam/meshes/bbox tokens preserved unchanged.
 */
export function formatRenderStats(o: {
  cam: { x: number; y: number; z: number };
  meshes: number;
  built: number;
  drawn: number;
  culled: boolean;
  bbox: string;
}): string {
  const built = Math.round(o.built);
  const drawn = Math.round(o.drawn);
  return (
    "cam(" + o.cam.x.toFixed(0) + "," + o.cam.y.toFixed(0) + "," + o.cam.z.toFixed(0) + ") meshes=" + o.meshes + " " +
    "drawn=" + drawn + " built=" + built + " culled=" + (o.culled ? "on" : "off") + " tris=" + built + " bbox=" + o.bbox
  );
}
