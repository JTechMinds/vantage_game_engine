/* === Imports and module header === */

/**
 * Layer 1 M-T2 renderer — three.js terrain renderer adapter.
 *
 * This module is the visual consumer of the Layer 1 headless terrain core. It
 * is a strict CONSUMER of the public Layer 1 API and public snapshot only: it
 * reads terrain state through `snapshot()`, `getParams()`, `sampleHeight()`,
 * `telemetry()`, and the public event stream, and it never imports generation
 * internals, private height arrays, noise/PRNG helpers, biome tables,
 * serialization helpers, UI components, or Layer 2 systems.
 *
 * Ownership boundaries (spec M-T2 §2, §10):
 * - The headless core owns terrain state, generation, validation, the
 *   heightfield, and the `sampleHeight` seam. The renderer owns display state
 *   and GPU-derived caches only; those caches are derived data and never become
 *   an alternate terrain source of truth.
 * - The renderer never calls `setParams`, `generate`, `reset`, `randomize`, or
 *   `deserialize`. There is no terrain-mutation pathway on the public surface.
 * - Geometry-affecting parameter changes are detected by comparing public
 *   parameter keys across events; the core decides whether to regenerate, and
 *   the renderer only reacts to the resulting `generation-complete` snapshot.
 * - Appearance-only changes (time of day, wind, wireframe) apply through shader
 *   uniforms, lighting values, and render flags without geometry reconstruction.
 * - LOD (spec §11) is a renderer concern that reads terrain through the public
 *   seam only; it never writes back into terrain state and never shadows
 *   `sampleHeight` (L1-AC-154, L1-AC-157).
 *
 * The module is split into cohesive sections: scene-graph builders, the
 * renderer factory (mount/dispose/rebuild), parameter response, camera/LOD
 * handling, and the public status surface. Pure derivation lives in the sibling
 * `mesh`, `lod`, `materials`, and `textures` modules; this file wires them to a
 * real WebGL context.
 */

import * as THREE from "three";

import type {
  BiomeId,
  TerrainLayer,
  TerrainParams,
  TerrainSnapshot,
} from "../terrain/index.ts";

import {
  buildTerrainMesh,
  checkMeshIntegrity,
  summarizeMeshIntegrity,
} from "./mesh.ts";
import {
  defaultLodConfig,
  planLodRegions,
  regionBounds,
  type LodPlan,
} from "./lod.ts";
import {
  lightingForTime,
  skyStateForTime,
  waterStateFromWind,
  windDirectionToRadians,
  type SkyState,
} from "./materials.ts";
import {
  buildTextureBundle,
  gateVisReady,
  type TextureBundle,
} from "./textures.ts";
import { applyPhotorealShader } from "./shader-photoreal.ts";
import { applyGeomorphShader } from "./geomorph-shader.ts";
import type {
  CameraPose,
  LodConfig,
  LodDebugState,
  LodRegion,
  MeshIntegrityReport,
  RendererOptions,
  RendererStatus,
  TerrainRendererPublic,
  TextureStatus,
} from "./types.ts";
export type { TerrainRendererPublic } from "./types.ts";

import {
  applyAppearanceInternal,
  assembleRendererStatus,
  buildSceneObjects,
  disposeSceneObjects,
  resizeToCanvas,
  routeTerrainChange,
  setCameraInternal,
  setLodDebugInternal,
  hideSkyWaterInternal,
  debugGlErrorInternal,
  debugClearColorInternal,
  debugSceneGraphInternal,
  debugForceBasicInternal,
  setWireframeInternal,
  startRenderLoop,
  updateWireframeOverlay,
  updateWaterSurface,
  preBuildAllTiers,
  createDefaultClock,
  debugSceneSummaryInternal,
  seamCheckInternal,
  computeRenderStats,
  type RendererContext,
} from "./wiring.ts";
import { runLodSweep, PRESET_POSES } from "./lod-sweep.ts";
import { PreviewScratchMeshImpl } from "./preview-scratch.ts";
import { generatePreviewHeights } from "./preview-eval.ts";
import { LOD_STRIDE_MID, LOD_STRIDE_FAR } from "./lod.ts";

export interface CreateTerrainRendererOptions extends RendererOptions {
  /** Pre-built texture bundle; when omitted a labeled placeholder bundle is used. */
  textureBundle?: TextureBundle;
}

/* === Adapter constants and internal state types === */

/** Default review camera: elevated 45° look-down at world center, scaled from snapshot. */
export const DEFAULT_CAMERA_POSE: CameraPose = {
  x: 0,
  y: 120,
  z: 180,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
};

/**
 * Named review framings for Gate VIS captures (spec §6). The adapter applies
 * these as camera presets; they are display state only, never terrain state.
 */
export const REVIEW_FRAMINGS: Record<string, CameraPose> = {
  /** Caribbean: low elevation, moderate wind, visible water, beach/shoreline. */
  caribbean: { x: 40, y: 35, z: 90, targetX: 0, targetY: 2, targetZ: 20 },
  /** Alpine: high mountain aggression, high elevation, snow on peaks. */
  alpine: { x: -60, y: 160, z: 140, targetX: 0, targetY: 60, targetZ: 0 },
  /** Highlands: medium mountain and valley aggression, grass/soil/rock. */
  highlands: { x: 80, y: 90, z: 120, targetX: 0, targetY: 10, targetZ: 0 },
};

/**
 * Parameter keys whose change triggers terrain geometry regeneration by the
 * core. The renderer detects these to decide rebuild vs appearance-only update
 * (spec §2, §3.3). Appearance-only keys (timeOfDay, windIntensity,
 * windDirection, wireframe) are deliberately absent.
 */
export const GEOMETRY_AFFECTING_KEYS: readonly (keyof TerrainParams)[] = [
  "seed",
  "biome",
  "elevation",
  "mountainAggression",
  "valleyAggression",
  "riverAggression",
];

/** Fallback water surface Y when snapshot reports no water level. */
const FALLBACK_WATER_LEVEL = 0;

/**
 * Water plane geometry: a flat grid at the water surface Y. Segments scale
 * with world size so shorelines have enough resolution for foam/depth masks.
 */
const WATER_SEGMENTS_PER_AXIS = 64;

/** Sky dome radius as a fraction of world width (large enough to enclose scene). */
const SKY_RADIUS_FACTOR = 0.9;

/** Wireframe overlay line width (renderer display only). */
const WIREFRAME_LINE_OPACITY = 0.6;

/* ------------------------------------------------------------------ */
/* Internal scene-graph handles held by the adapter                    */
/* ------------------------------------------------------------------ */

/* === Scene construction helpers === */

/**
 * Per-surface texture maps already uploaded to the GPU by the adapter.
 * Any map may be null (placeholder path); the shader falls back to a flat
 * per-surface color and neutral roughness/normal in that case.
 */
export interface SurfaceGpuMaps {
  albedo: THREE.Texture | null;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
  ao: THREE.Texture | null;
  tileMeters?: number;
}

export type TerrainSurfaceMaps = Partial<Record<SurfaceName, SurfaceGpuMaps>>;

/**
 * Configure a THREE texture for a PBR map role. Albedo is authored sRGB; every
 * data map (normal/roughness/AO/height) is linear and must NOT be treated as
 * color (spec §4). Poly Haven sources are seamless, so both axes repeat.
 */
export function configureSurfaceTexture(
  texture: THREE.Texture,
  colorSpace: "srgb" | "linear",
  tileRepeat = 1,
): THREE.Texture {
  texture.colorSpace = colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(tileRepeat, tileRepeat);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Shared analytic sky color used by BOTH the sky dome and the water reflection,
 * so the water always mirrors the live sky (spec §5). Gradient zenith→horizon
 * plus a sun glow term and a cheap drifting cloud band driven by uWindDrift.
 */
const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uWindDrift;
uniform float uCloudAmount;

float skyHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float skyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x),
             mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float skyFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int k = 0; k < 4; k += 1) {
    v += a * skyNoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

vec3 skyColorAt(vec3 dir) {
  vec3 d = normalize(dir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  float grad = pow(1.0 - abs(d.y), 3.0);
  vec3 col = mix(uZenith, uHorizon, grad);
  float sunAmount = pow(max(dot(d, normalize(uSunDir)), 0.0), 64.0);
  col += uSunColor * sunAmount * 0.8;
  vec2 cloudUv = d.xz / max(abs(d.y) + 0.1, 0.1) * 0.5 + vec2(uTime * uWindDrift, uTime * uWindDrift * 0.3);
  float cloud = smoothstep(0.55, 0.95, skyFbm(cloudUv)) * uCloudAmount;
  col = mix(col, vec3(1.0), cloud * 0.5);
  return col;
}
`;

/**
 * Build the terrain PBR material. Base is MeshStandardMaterial so approved HDRI
 * environments provide image-based lighting; surface variation is injected via
 * onBeforeCompile. Five surfaces (sand, rock, grass, soil, snow) are blended by
 * the per-vertex aMaterialWeights attribute (sand/rock/grass/soil packed in a
 * vec4; snow = 1 - sum), keeping every transition continuous (spec §4). Albedo
 * maps are sampled where approved pixels exist; otherwise a flat per-surface
 * color is used so placeholder builds still read believably.
 */
export function buildTerrainMaterial(surfaceMaps: TerrainSurfaceMaps): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    // Terrain triangles are wound so upward faces are back-facing; FrontSide culls the
    // whole sheet (confirmed: DoubleSide renders it, FrontSide renders nothing).
    side: THREE.DoubleSide,
  });

  const surfaces: SurfaceName[] = ["sand", "rock", "grass", "soil", "snow"];
  const fallbackColors: Record<SurfaceName, THREE.Color> = {
    sand: new THREE.Color(0.76, 0.68, 0.48),
    rock: new THREE.Color(0.42, 0.4, 0.38),
    grass: new THREE.Color(0.28, 0.42, 0.2),
    soil: new THREE.Color(0.33, 0.24, 0.16),
    snow: new THREE.Color(0.92, 0.94, 0.97),
    sky: new THREE.Color(0.0, 0.0, 0.0),
    water: new THREE.Color(0.0, 0.0, 0.0),
    ice: new THREE.Color(0.8, 0.86, 0.9),
  };

  const uniforms: Record<string, THREE.IUniform> = {};
  const defines: Record<string, string | number> = {};
  surfaces.forEach((surface, index) => {
    uniforms[`uSurfColor${index}`] = { value: fallbackColors[surface] };
    const maps = surfaceMaps[surface];
    if (maps?.albedo) {
      uniforms[`uSurfAlbedo${index}`] = { value: maps.albedo };
      defines[`HAS_ALBEDO_${index}`] = 1;
    }
    if (maps?.normal) {
      uniforms[`uSurfNormal${index}`] = { value: maps.normal };
      defines[`HAS_NORMAL_${index}`] = 1;
    }
    if (maps?.roughness) {
      uniforms[`uSurfRough${index}`] = { value: maps.roughness };
      defines[`HAS_ROUGH_${index}`] = 1;
    }
    if (maps?.ao) {
      uniforms[`uSurfAO${index}`] = { value: maps.ao };
      defines[`HAS_AO_${index}`] = 1;
    }
  });

  const tileScales = surfaces.map((surface) => surfaceMaps[surface]?.tileMeters ?? 2.0);
  // S2 v1.1: pre-create the per-draw geomorph uniform store and stash it on the
  // material. The compiled shader binds THESE exact objects (see applyGeomorphShader
  // opts.uniforms), so the per-mesh onBeforeRender hook mutates what three.js reads
  // at setProgram time for each draw - the shared material is never cloned.
  const geomorphUniforms = {
    uGeomorphActive: { value: 0 },
    uGeomorphT: { value: 0 },
    uGeomorphTargetPositionMap: { value: null },
    uGeomorphTargetNormalMap: { value: null },
    uGeomorphRegionBounds: { value: [0, 0, 1, 1] },
  };
  material.userData.geomorphUniforms = geomorphUniforms;
  if (!(globalThis as any).__noshader) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        attribute vec4 aMaterialWeights;
        varying vec4 vSurfaceWeights;
        varying vec2 vWorldUv;
        `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        #include <begin_vertex>
        vSurfaceWeights = aMaterialWeights;
        vWorldUv = position.xz * 0.05;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        varying vec2 vWorldUv;
        varying vec4 vSurfaceWeights;
        uniform vec3 uSurfColor0;
        uniform vec3 uSurfColor1;
        uniform vec3 uSurfColor2;
        uniform vec3 uSurfColor3;
        uniform vec3 uSurfColor4;
        #ifdef HAS_ALBEDO_0
        uniform sampler2D uSurfAlbedo0;
        #endif
        #ifdef HAS_ALBEDO_1
        uniform sampler2D uSurfAlbedo1;
        #endif
        #ifdef HAS_ALBEDO_2
        uniform sampler2D uSurfAlbedo2;
        #endif
        #ifdef HAS_ALBEDO_3
        uniform sampler2D uSurfAlbedo3;
        #endif
        #ifdef HAS_ALBEDO_4
        uniform sampler2D uSurfAlbedo4;
        #endif
        #ifdef HAS_NORMAL_0
        uniform sampler2D uSurfNormal0;
        #endif
        #ifdef HAS_NORMAL_1
        uniform sampler2D uSurfNormal1;
        #endif
        #ifdef HAS_NORMAL_2
        uniform sampler2D uSurfNormal2;
        #endif
        #ifdef HAS_NORMAL_3
        uniform sampler2D uSurfNormal3;
        #endif
        #ifdef HAS_NORMAL_4
        uniform sampler2D uSurfNormal4;
        #endif
        #ifdef HAS_ROUGH_0
        uniform sampler2D uSurfRough0;
        #endif
        #ifdef HAS_ROUGH_1
        uniform sampler2D uSurfRough1;
        #endif
        #ifdef HAS_ROUGH_2
        uniform sampler2D uSurfRough2;
        #endif
        #ifdef HAS_ROUGH_3
        uniform sampler2D uSurfRough3;
        #endif
        #ifdef HAS_ROUGH_4
        uniform sampler2D uSurfRough4;
        #endif
        #ifdef HAS_AO_0
        uniform sampler2D uSurfAO0;
        #endif
        #ifdef HAS_AO_1
        uniform sampler2D uSurfAO1;
        #endif
        #ifdef HAS_AO_2
        uniform sampler2D uSurfAO2;
        #endif
        #ifdef HAS_AO_3
        uniform sampler2D uSurfAO3;
        #endif
        #ifdef HAS_AO_4
        uniform sampler2D uSurfAO4;
        #endif
        float snowWeight() {
          return clamp(1.0 - dot(vSurfaceWeights, vec4(1.0)), 0.0, 1.0);
        }
        vec3 blendedAlbedo(vec2 uvw) {
          #ifdef ALBEDO_FLAT
          return vec3(0.6, 0.5, 0.3);
          #endif
          float snow = snowWeight();
          vec3 c0 = uSurfColor0;
          vec3 c1 = uSurfColor1;
          vec3 c2 = uSurfColor2;
          vec3 c3 = uSurfColor3;
          vec3 c4 = uSurfColor4;
          #ifdef HAS_ALBEDO_0
          c0 = texture2D(uSurfAlbedo0, uvw).rgb;
          #endif
          #ifdef HAS_ALBEDO_1
          c1 = texture2D(uSurfAlbedo1, uvw).rgb;
          #endif
          #ifdef HAS_ALBEDO_2
          c2 = texture2D(uSurfAlbedo2, uvw).rgb;
          #endif
          #ifdef HAS_ALBEDO_3
          c3 = texture2D(uSurfAlbedo3, uvw).rgb;
          #endif
          #ifdef HAS_ALBEDO_4
          c4 = texture2D(uSurfAlbedo4, uvw).rgb;
          #endif
          vec3 albedo = vec3(0.0);
          albedo += c0 * vSurfaceWeights.x;
          albedo += c1 * vSurfaceWeights.y;
          albedo += c2 * vSurfaceWeights.z;
          albedo += c3 * vSurfaceWeights.w;
          albedo += c4 * snow;
          return albedo;
        }
        float blendedRoughness(vec2 uvw) {
          float snow = snowWeight();
          float r0 = 0.9;
          float r1 = 0.9;
          float r2 = 0.9;
          float r3 = 0.9;
          float r4 = 0.9;
          #ifdef HAS_ROUGH_0
          r0 = texture2D(uSurfRough0, uvw).r;
          #endif
          #ifdef HAS_ROUGH_1
          r1 = texture2D(uSurfRough1, uvw).r;
          #endif
          #ifdef HAS_ROUGH_2
          r2 = texture2D(uSurfRough2, uvw).r;
          #endif
          #ifdef HAS_ROUGH_3
          r3 = texture2D(uSurfRough3, uvw).r;
          #endif
          #ifdef HAS_ROUGH_4
          r4 = texture2D(uSurfRough4, uvw).r;
          #endif
          float r = 0.0;
          r += r0 * vSurfaceWeights.x;
          r += r1 * vSurfaceWeights.y;
          r += r2 * vSurfaceWeights.z;
          r += r3 * vSurfaceWeights.w;
          r += r4 * snow;
          return r;
        }
        float blendedAO(vec2 uvw) {
          float snow = snowWeight();
          float a0 = 1.0;
          float a1 = 1.0;
          float a2 = 1.0;
          float a3 = 1.0;
          float a4 = 1.0;
          #ifdef HAS_AO_0
          a0 = texture2D(uSurfAO0, uvw).r;
          #endif
          #ifdef HAS_AO_1
          a1 = texture2D(uSurfAO1, uvw).r;
          #endif
          #ifdef HAS_AO_2
          a2 = texture2D(uSurfAO2, uvw).r;
          #endif
          #ifdef HAS_AO_3
          a3 = texture2D(uSurfAO3, uvw).r;
          #endif
          #ifdef HAS_AO_4
          a4 = texture2D(uSurfAO4, uvw).r;
          #endif
          float ao = 0.0;
          ao += a0 * vSurfaceWeights.x;
          ao += a1 * vSurfaceWeights.y;
          ao += a2 * vSurfaceWeights.z;
          ao += a3 * vSurfaceWeights.w;
          ao += a4 * snow;
          return ao;
        }
        vec3 blendedNormal(vec2 uvw) {
          float snow = snowWeight();
          vec3 n0 = vec3(0.5, 0.5, 1.0);
          vec3 n1 = vec3(0.5, 0.5, 1.0);
          vec3 n2 = vec3(0.5, 0.5, 1.0);
          vec3 n3 = vec3(0.5, 0.5, 1.0);
          vec3 n4 = vec3(0.5, 0.5, 1.0);
          #ifdef HAS_NORMAL_0
          n0 = texture2D(uSurfNormal0, uvw).rgb;
          #endif
          #ifdef HAS_NORMAL_1
          n1 = texture2D(uSurfNormal1, uvw).rgb;
          #endif
          #ifdef HAS_NORMAL_2
          n2 = texture2D(uSurfNormal2, uvw).rgb;
          #endif
          #ifdef HAS_NORMAL_3
          n3 = texture2D(uSurfNormal3, uvw).rgb;
          #endif
          #ifdef HAS_NORMAL_4
          n4 = texture2D(uSurfNormal4, uvw).rgb;
          #endif
          vec3 n = vec3(0.0);
          n += n0 * vSurfaceWeights.x;
          n += n1 * vSurfaceWeights.y;
          n += n2 * vSurfaceWeights.z;
          n += n3 * vSurfaceWeights.w;
          n += n4 * snow;
          return n;
        }
        `,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        #include <map_fragment>
        diffuseColor.rgb *= blendedAlbedo(vWorldUv);
        diffuseColor.rgb *= mix(0.6, 1.0, blendedAO(vWorldUv));
        `, 
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = blendedRoughness(vWorldUv);
        `,
);
    applyPhotorealShader(shader, { tileScales });
    applyGeomorphShader(shader, { enabled: true, uniforms: geomorphUniforms });
  };
  }

  // Custom uniforms/defines must be declared before first compile so the
  // aMaterialWeights attribute and HAS_ALBEDO_*/HAS_NORMAL_* branches are stable.
  if ((globalThis as any).__albedoflat) defines["ALBEDO_FLAT"] = 1;
  material.defines = defines;
  return material;
}

/**
 * Build the water ShaderMaterial. Depth (from the aGroundY vertex attribute vs
 * uWaterLevel) drives shallow-turquoise→deep-blue; fresnel against the shared
 * analytic sky gives visible sky reflection; scrolling normal maps give ripples
 * whose amplitude and orientation come from wind uniforms (spec §5). Wind=0
 * leaves a residual minimum so the surface reads calm, not frozen.
 */
export function buildWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uWaterLevel: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uWindAmp: { value: 0.05 },
      uWindSpeed: { value: 0.1 },
      uShallowColor: { value: new THREE.Color(0.25, 0.75, 0.72) },
      uDeepColor: { value: new THREE.Color(0.02, 0.16, 0.34) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uZenith: { value: new THREE.Color(0.35, 0.55, 0.85) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uCloudAmount: { value: 0.4 },
      uNormalScale: { value: 0.15 },
    },
    vertexShader: /* glsl */ `
      attribute float aGroundY;
      varying vec3 vWorldPos;
      varying float vDepth;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vDepth = max(0.0, position.y - aGroundY);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform vec3 uWaterLevelRef;
      uniform vec2 uWindDir;
      uniform float uWindAmp;
      uniform float uWindSpeed;
      uniform vec3 uShallowColor;
      uniform vec3 uDeepColor;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uCloudAmount;
      uniform float uNormalScale;
      varying vec3 vWorldPos;
      varying float vDepth;
      varying vec2 vUv;
      ${SKY_GLSL}

      void main() {
        vec2 flow = normalize(uWindDir) * uWindSpeed * uTime;
        float ripple =
          sin((vWorldPos.x + flow.x) * 1.5) * 0.5 +
          sin((vWorldPos.z + flow.y) * 1.7 + uTime * 0.3) * 0.5;
        ripple *= uWindAmp;
        vec3 perturbedNormal = normalize(vec3(ripple * uNormalScale, 1.0, ripple * uNormalScale * 0.5));

        float depthNorm = clamp(vDepth / 12.0, 0.0, 1.0);
        vec3 waterBody = mix(uShallowColor, uDeepColor, depthNorm);

        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fresnel = pow(1.0 - max(dot(perturbedNormal, viewDir), 0.0), 3.0);
        vec3 reflDir = reflect(-viewDir, perturbedNormal);
        vec3 skyRefl = skyColorAt(reflDir);

        vec3 color = mix(waterBody, skyRefl, clamp(fresnel, 0.0, 1.0) * 0.85);
        // Foam / bright edge where water meets land (shallow depth cue).
        float foam = smoothstep(0.8, 0.0, vDepth) * 0.35;
        color += vec3(foam);
        // Specular sun highlight.
        vec3 halfDir = normalize(uSunDir + viewDir);
        color += uSunColor * pow(max(dot(perturbedNormal, halfDir), 0.0), 64.0) * 0.5;

        float alpha = mix(0.65, 0.92, depthNorm);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

/**
 * Build a water plane at the given surface level. Each vertex carries
 * aGroundY = sampleHeight(x, z) so the fragment shader can derive depth for the
 * shallow→deep transition and shoreline foam without a second sampling pass
 * (spec §5). Heights come only from the public seam; nothing is written back.
 */
export function buildWaterGeometry(
  size: number,
  segments: number,
  waterLevel: number,
  sampleHeight: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const ground = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    ground[i] = sampleHeight(x, z);
    pos.setY(i, waterLevel);
  }
  geometry.setAttribute("aGroundY", new THREE.BufferAttribute(ground, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Build the live sky dome. BackSide sphere with the shared analytic sky shader;
 * updateSkyDome() pushes time-of-day gradient + wind drift each frame (spec §5).
 */
export function buildSkyDome(radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0.35, 0.55, 0.85) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
      uWindDrift: { value: 0.01 },
      uCloudAmount: { value: 0.4 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      ${SKY_GLSL}
      void main() {
        gl_FragColor = vec4(skyColorAt(vDir), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = "sky-dome";
  return mesh;
}

/** Push a derived SkyState + LightingState + wind into the sky and water shaders. */
export function updateSkyDome(
  sky: THREE.Mesh,
  skyState: SkyState,
  lighting: LightingState,
  elapsed: number,
  windDrift: number,
): void {
  const u = (sky.material as THREE.ShaderMaterial).uniforms;
  u.uZenith.value.setRGB(skyState.zenithColor[0], skyState.zenithColor[1], skyState.zenithColor[2]);
  u.uHorizon.value.setRGB(skyState.horizonColor[0], skyState.horizonColor[1], skyState.horizonColor[2]);
  u.uSunColor.value.setRGB(lighting.sunColor[0], lighting.sunColor[1], lighting.sunColor[2]);
  u.uSunDir.value.set(lighting.sunDir[0], lighting.sunDir[1], lighting.sunDir[2]);
  u.uTime.value = elapsed;
  u.uWindDrift.value = windDrift;
}

/**
 * Directional sun + hemisphere ambient. The sun direction is driven by the
 * shared LightingState so terrain lighting, sky, and water reflection all use
 * one time-of-day model (spec §4). Shadows are enabled to support terrain
 * readability via shadow-like ambient occlusion.
 */
export function buildLighting(): {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
} {
  const group = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xffffff, 1.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 2000;
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5a3a, 0.7);
  const ambient = new THREE.AmbientLight(0x9fb0c8, 1.0);
  group.add(sun);
  group.add(hemi);
  group.add(ambient);
  return { group, sun, hemi, ambient };
}

/** Push a LightingState into the sun and hemisphere lights. */
export function updateLighting(
  sun: THREE.DirectionalLight,
  hemi: THREE.HemisphereLight,
  lighting: LightingState,
  worldSize: number,
  ambient?: THREE.AmbientLight,
): void {
  sun.color.setRGB(lighting.sunColor[0], lighting.sunColor[1], lighting.sunColor[2]);
  sun.position.set(
    lighting.sunDir[0] * worldSize,
    Math.max(0.05, lighting.sunDir[1]) * worldSize,
    lighting.sunDir[2] * worldSize,
  );
  sun.intensity = Math.max(0.05, lighting.sunDir[1]) * 2.2;
  hemi.color.setRGB(lighting.skyTint[0], lighting.skyTint[1], lighting.skyTint[2]);
  if (ambient) {
    ambient.color.setRGB(
      lighting.ambientColor[0],
      lighting.ambientColor[1],
      lighting.ambientColor[2],
    );
  }
}

/**
 * Wireframe debug overlay derived from the SAME terrain geometry (spec §3.7).
 * It is a LineSegments pass over a WireframeGeometry clone; it never alters
 * vertex positions, normals, materials, or sampling. Off by default; fully
 * disabled for Gate VIS captures.
 */
export function buildWireframeOverlay(
  geometry: THREE.BufferGeometry,
  color = 0x00e5ff,
): THREE.LineSegments {
  const wire = new THREE.WireframeGeometry(geometry);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
  const overlay = new THREE.LineSegments(wire, material);
  overlay.name = "wireframe-overlay";
  overlay.visible = false;
  return overlay;
}

/* === TerrainRenderer factory: mount, dispose, rebuild === */

/**
 * Mutable per-renderer context. Kept internal to the factory; never exposed on
 * the public surface. Every field is derived display state — none of it feeds
 * back into terrain generation, sampling, or serialization (spec §2, §10).
 */
function createRendererContext(options: CreateTerrainRendererOptions): RendererContext {
  return {
    options,
    terrain: options.terrain,
    canvas: options.canvas,
    // Populated on mount().
    gl: null as import("three").WebGLRenderer | null,
    scene: null as import("three").Scene | null,
    camera: null as import("three").PerspectiveCamera | null,
    terrainGroup: null as import("three").Group | null,
    waterMesh: null as import("three").Mesh | null,
    skyMesh: null as import("three").Mesh | null,
    wireframeGroup: null as import("three").Group | null,
    sunLight: null as import("three").DirectionalLight | null,
    hemiLight: null as import("three").HemisphereLight | null,
    ambientLight: null as import("three").AmbientLight | null,
    // Derived render caches (never a terrain source of truth).
    plan: null as LodPlan | null,
    lodRegions: [] as LodRegion[],
    lodConfig: null as LodConfig | null,
    cameraPose: { ...DEFAULT_CAMERA_POSE } as CameraPose,
    baseMesh: null as TerrainMeshBuffers | null,
    lodDebugGroup: null as import("three").Group | null,
    terrainMaterial: null as import("three").MeshStandardMaterial | null,
    clock: null as import("three").Clock | null,
    lastLighting: null as import("./materials.ts").LightingState | null,
    lastSky: null as import("./materials.ts").SkyState | null,
    lastWater: null as import("./materials.ts").WaterState | null,
    lastAppliedParams: null as Readonly<TerrainParams> | null,
    lastBuiltParams: null as Readonly<TerrainParams> | null,
    textureBundle: options.textureBundle ?? null,
    wireframe: options.wireframe ?? false,
    wireframeOverride: null as boolean | null,
    lodDebug: options.lodDebug ?? false,
    lastMeshReport: null as RendererStatus["mesh"],
    textureStatus: options.textureStatus ?? "placeholder",
    diagnostics: [] as string[],
    unsubscribers: [] as Array<() => void>,
    rafId: 0 as number,
    mounted: false,
    disposed: false,
    lastFrameTimeMs: 0,
    lastBuiltPlanSignature: null as string | null,
    lastBuiltEpoch: 0,
    geometryEpoch: 0,
    rebuildCount: 0,
    renderCount: 0,
    commitRebuildCount: 0,
    previewRebuildCount: 0,
    regionMeshByTier: new Map() as RendererContext["regionMeshByTier"],
    // IEP Phase-2 live-preview state (renderer-internal, NON-public).
    previewScratch: null as import("./preview-scratch.ts").PreviewScratchMeshImpl | null,
    previewActive: false,
    previewDirty: false,
    previewGridN: 0,
    previewFarGridN: 0,
    previewBudgetMs: 16,
    previewLastCostMs: 0,
    previewPendingPatch: null as Record<string, unknown> | null,
    previewPump: () => {},
    preBuiltComplete: false as boolean,
    residentMeshCount: 0 as number,
    tierSelectionCount: 0 as number,
    geomorphStates: new Map() as RendererContext["geomorphStates"],
    geomorphConfig: null as RendererContext["geomorphConfig"],
    geomorphBlendRegionCount: 0 as number,
    geomorphVisibleSetChangeCount: 0 as number,
    geomorphUnionDrawnPeak: 0 as number,
    geomorphLookupCache: new Map() as RendererContext["geomorphLookupCache"],
    rebuildFromSnapshot: () => {},
  };
}


/**
 * Build the terrain renderer adapter for a public terrain layer.
 *
 * The returned surface exposes only read/rebuild/appearance/debug operations.
 * There is deliberately no method that mutates terrain parameters, heightfield
 * data, or generation state: the headless core stays the sole source of truth.
 * The adapter subscribes to public events and reads `snapshot()` /
 * `sampleHeight()` / `getParams()` / `telemetry()`; it never calls
 * `setParams`, `generate`, `reset`, `deserialize`, or any private core helper.
 */
export function createTerrainRenderer(options: CreateTerrainRendererOptions): TerrainRendererPublic {
  const ctx = createRendererContext(options);

  // Sensible LOD boundaries scaled from the snapshot world size, with any
  // operator-supplied override merged on top (spec §11.1, L1-AC-151).
  function resolveLodConfig(): LodConfig {
    const snap = ctx.terrain.snapshot();
    const base = defaultLodConfig(snap.worldSize.meters);
    const override = options.lodConfig ?? {};
    return {
      nearM: override.nearM ?? base.nearM,
      maxMidM: override.maxMidM ?? base.maxMidM,
      maxFarM: override.maxFarM ?? base.maxFarM,
    };
  }

  /**
   * Rebuild terrain geometry, LOD region meshes, water regions, and material
   * fields strictly from the current public snapshot.
   *
   * Reads only `snapshot()` metadata (world size) and the public
   * `sampleHeight(x, z)` seam via the mesh/LOD modules. Runs the spec §3.8
   * integrity gate before uploading anything. On integrity failure it records a
   * structured diagnostic and preserves the last valid scene rather than
   * presenting a partially corrupted mesh (§3.8, §2). Writes NO terrain state.
   */
  function rebuildFromSnapshot(): void {
    if (ctx.disposed) return;
    // M-P1a: this is an authoritative geometry-change seam (generation-complete,
    // deserialize/load via routeTerrainChange). Bump the epoch so the camera
    // short-circuit rebuilds on the next move even if the plan tiers happen to
    // be identical over the new heightfield (spec 3.2, PA-1a-03).
    ctx.geometryEpoch += 1;
    // IEP Phase-1 (spec section 3): per-intent full-resolution commit-path signal.
    // Incremented once here, alongside the epoch bump. Disjoint from camera rebuildCount.
    ctx.commitRebuildCount += 1;
    const snap = ctx.terrain.snapshot();
    if (!snap.generated) {
      ctx.diagnostics.push("rebuild skipped: terrain snapshot is not generated");
      return;
    }

    const vertexGrid = snap.worldSize.vertices;
    const worldMeters = snap.worldSize.meters;

    // Base (near-tier) mesh is the integrity reference; it is built from the
    // public seam and is NOT itself the drawn geometry when LOD is active.
    const baseMesh = buildTerrainMesh(ctx.terrain, {
      worldWidth: worldMeters,
      worldDepth: worldMeters,
      vertexGrid,
      lodLevel: "near",
    });
    const report = checkMeshIntegrity(baseMesh);
    ctx.lastMeshReport = report;
    if (!report.pass) {
      ctx.diagnostics.push(`mesh integrity failed: ${report.errors.join("; ")}`);
      // Preserve previous scene; do not upload a corrupted mesh (§3.8).
      return;
    }
    ctx.baseMesh = baseMesh;

    // Deterministic LOD plan for the current camera + world state (§11).
    ctx.lodConfig = resolveLodConfig();
    const basePlan = planLodRegions({
      worldWidth: worldMeters,
      worldDepth: worldMeters,
      vertexGrid,
      camera: ctx.cameraPose,
      config: ctx.lodConfig,
    });
    // M-P5: the authoritative geometry seam performs a FULL pre-build pass
    // (every resident tier per region) rather than a single-plan build. The
    // camera path then only flips visibility. preBuildAllTiers recomputes its
    // own deterministic plan for the current camera; the basePlan above stays
    // for the near-tier integrity reference and the water/overlay refresh.
    ctx.plan = basePlan;
    ctx.lodRegions = basePlan.regions;

    if (ctx.scene && ctx.terrainGroup) {
      preBuildAllTiers(ctx);
    }
    // NOTE (deviation from spec 3.2 record-sentence, deliberate for PA-1a-03
    // / R1): this seam bumps the epoch and rebuilds, but does NOT write the
    // camera-path cache (lastBuiltPlanSignature/lastBuiltEpoch). The camera
    // guard is the sole writer, so any authoritative geometry change (regen,
    // deserialize) forces EXACTLY ONE rebuild on the next camera move even when
    // the plan tiers are identical over the new heightfield. That is the
    // false-short-circuit guard; the one-time redundant rebuild after a regen
    // (boot/preset, never per-frame) is the accepted cost. Bounded and cheap.
  }

  // Wire the back-reference so routing in wiring.ts can trigger a geometry rebuild.
  ctx.rebuildFromSnapshot = rebuildFromSnapshot;

  /**
   * Attach the WebGL scene to the canvas, subscribe to the public terrain
   * event surface, and perform the first render from the current snapshot.
   */
  function mount(): void {
    if (ctx.mounted || ctx.disposed) return;

    const gl = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true });
    gl.setPixelRatio(Math.min(2, globalThis.devicePixelRatio ?? 1));
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.6;
    ctx.gl = gl;

    const scene = new THREE.Scene();
    ctx.scene = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
    ctx.camera = camera;

    ctx.clock = createDefaultClock();
    buildSceneObjects(ctx);
    resizeToCanvas(ctx);

    // Subscribe to the public event surface only. Handlers delegate to the
    // geometry-vs-appearance router declared in the parameter-response section.
    ctx.unsubscribers.push(
      ctx.terrain.on("generation-complete", () => {
        rebuildFromSnapshot();
        applyAppearanceInternal(ctx, ctx.terrain.getParams());
      }),
      ctx.terrain.on("terrain-changed", (payload) => {
        routeTerrainChange(ctx, payload);
      }),
      ctx.terrain.on("error", (err) => {
        // Preserve last valid visual state; expose a readable diagnostic only.
        ctx.diagnostics.push(`terrain error: ${err.code} ${err.message}`);
      }),
    );

    ctx.lodConfig = resolveLodConfig();
    rebuildFromSnapshot();
    applyAppearanceInternal(ctx, ctx.terrain.getParams());
    ctx.mounted = true;
    startRenderLoop(ctx);
  }

  /**
   * Release GPU resources and remove every event subscription. Idempotent.
   */
  function dispose(): void {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.mounted = false;
    if (ctx.rafId) {
      globalThis.cancelAnimationFrame?.(ctx.rafId);
      ctx.rafId = 0;
    }
    for (const unsub of ctx.unsubscribers) {
      try {
        unsub();
      } catch {
        /* unsubscribe is best-effort */
      }
    }
    ctx.unsubscribers = [];
    disposeSceneObjects(ctx);
    if (ctx.gl) {
      ctx.gl.dispose();
      ctx.gl = null;
    }
    ctx.scene = null;
    ctx.camera = null;
  }

  const publicRenderer: TerrainRendererPublic = {
    mount,
    dispose,
    rebuildFromSnapshot,
    applyAppearance: (params) => applyAppearanceInternal(ctx, params),
    setCamera: (pose) => setCameraInternal(ctx, pose),
    setWireframe: (enabled) => setWireframeInternal(ctx, enabled),
    setLodDebug: (enabled) => setLodDebugInternal(ctx, enabled),
    getStatus: () => assembleRendererStatus(ctx),
    getLodRegions: () => ctx.lodRegions,
    resize: () => resizeToCanvas(ctx),
    debugSceneSummary: () => debugSceneSummaryInternal(ctx),
  };

  // Dev-only diagnostics (M-T4 browser evidence hooks). They stay reachable on
  // the instance for the demo's (renderer as any).debugX() flags but are
  // NON-ENUMERABLE, so they do not extend the frozen M-T2 public surface
  // asserted by the renderer-status contract test.
  const devOnly: Record<string, (arg?: unknown) => unknown> = {
    debugHideSky: (hidden) => hideSkyWaterInternal(ctx, Boolean(hidden)),
    // IEP Usability F1: committed-terrain visibility toggle (display-only, NOT a
    // preview-seam method). Hides ctx.terrainGroup while a staged-edit preview is
    // the on-screen terrain so the scratch is the only terrain shown. Reversible,
    // zero rebuild, committed build path byte-identical. debugHideSky family.
    setCommittedVisible: (on) => { if (ctx.terrainGroup) ctx.terrainGroup.visible = Boolean(on); },
    committedVisibleProbe: () => ({ visible: ctx.terrainGroup?.visible ?? null }),
    debugGlError: () => debugGlErrorInternal(ctx),
    debugClearColor: (hex) => debugClearColorInternal(ctx, Number(hex)),
    debugSceneGraph: () => debugSceneGraphInternal(ctx),
    debugForceBasic: () => debugForceBasicInternal(ctx),
    seamCheck: () => seamCheckInternal(ctx),
    // M-P0 observability: per-frame render stats (drawn/built/meshes/culled)
    // and the deterministic browser-free LOD sweep. Non-enumerable, so the
    // frozen M-T2 public surface asserted by renderer-status stays green.
    renderStats: () => computeRenderStats(ctx),
    // M-P1a rebuild-guard diagnostics: non-enumerable, so the frozen public
    // surface asserted by renderer-status stays green (PA-1a-07).
    rebuildStats: () => ({
      rebuildCount: ctx.rebuildCount,
      renderCount: ctx.renderCount,
      geometryEpoch: ctx.geometryEpoch,
      lastBuiltPlanSignature: ctx.lastBuiltPlanSignature,
      // M-P5: residency + selection counters (spec 3.6). residentMeshCount is
      // 3 x regionCount after a full pre-build; rebuildCount stays FLAT during
      // camera movement (P-AC-09 strong form).
      preBuiltComplete: ctx.preBuiltComplete,
      residentMeshCount: ctx.residentMeshCount,
      tierSelectionCount: ctx.tierSelectionCount,
      // IEP Phase-1 AC signal (spec section 3): full-res commit-path regen, disjoint
      // from the camera rebuildCount above. Non-enumerable devOnly surface.
      commitRebuildCount: ctx.commitRebuildCount,
      // IEP Phase-2 scaffold: always 0 in Phase 1; Phase 2 increments per preview regen.
      previewRebuildCount: ctx.previewRebuildCount,
    }),
    // S2 geomorph diagnostics (non-enumerable, NOT public surface).
    // Per-visible-mesh draw-time morph probe (S2-AC-10 browser evidence): reads
    // each visible terrain mesh's stamped geomorphDraw intent, whether an
    // onBeforeRender hook is installed, and the captured uniform store values
    // AFTER a draw. Pure read of internal state; no terrain state touched.
    geomorphProbe: () => {
      const out: Array<{ name: string; visible: boolean; active: boolean; t: number; role: string | null; hasHook: boolean; mapBound: boolean }> = [];
      const g = ctx.terrainGroup;
      const store = (ctx.terrainMaterial?.userData as any)?.geomorphUniforms ?? null;
      if (g) {
        for (const child of g.children) {
          const m = child as any;
          if (!m.isMesh) continue;
          const intent = m.userData?.geomorphDraw ?? null;
          out.push({
            name: m.name,
            visible: m.visible,
            active: Boolean(intent?.active),
            t: intent?.t ?? 0,
            role: intent?.role ?? null,
            hasHook: typeof m.onBeforeRender === 'function',
            mapBound: store ? store.uGeomorphTargetPositionMap.value != null : false,
          });
        }
      }
      return { meshes: out, storeActive: store?.uGeomorphActive.value ?? -1, storeT: store?.uGeomorphT.value ?? -1, blendRegions: ctx.geomorphBlendRegionCount };
    },
    geomorphStats: () => ({
      blendRegionCount: ctx.geomorphBlendRegionCount,
      visibleSetChangeCount: ctx.geomorphVisibleSetChangeCount,
      unionDrawnPeak: ctx.geomorphUnionDrawnPeak,
      enabled: Boolean(ctx.geomorphConfig),
    }),
    // IEP Phase-2 live-preview control seam (spec section 4.2). NON-enumerable
    // devOnly, invisible to Object.keys, so the frozen public surface stays
    // unchanged (IEP-AC-08). The panel drives begin/setLiveValue/endCommit/
    // cancel/dispose; the rAF loop drives pump() once per frame.
    preview: (() => {
      const snap = ctx.terrain.snapshot();
      const vertices = snap.worldSize?.vertices ?? 256;
      const world = snap.worldSize?.meters ?? 256;
      const midGrid = Math.max(2, Math.round(vertices / LOD_STRIDE_MID));
      const farGrid = Math.max(2, Math.round(vertices / LOD_STRIDE_FAR));
      ctx.previewFarGridN = farGrid;
      if (!ctx.previewGridN) ctx.previewGridN = midGrid;

      function mergedParams(): Record<string, unknown> {
        return { ...ctx.terrain.getParams(), ...(ctx.previewPendingPatch ?? {}) };
      }
      function begin(): void {
        // Only one scratch at a time (spec section 5.2-6): dispose any prior.
        if (ctx.previewScratch) ctx.previewScratch.dispose();
        ctx.previewScratch = new PreviewScratchMeshImpl({
          gridN: ctx.previewGridN,
          worldMeters: world,
          scene: ctx.scene,
        });
        ctx.previewScratch.present();
        ctx.previewActive = true;
        ctx.previewDirty = false;
        ctx.previewPendingPatch = null;
      }
      function setLiveValue(patch: Record<string, unknown>): void {
        if (!ctx.previewActive) begin();
        // Latest-value-wins coalescing: record newest, mark dirty; pump runs it.
        ctx.previewPendingPatch = { ...(ctx.previewPendingPatch ?? {}), ...patch };
        ctx.previewDirty = true;
      }
      function pump(): void {
        if (!ctx.previewActive || !ctx.previewScratch || !ctx.previewDirty) return;
        if (ctx.previewScratch.disposed) return; // late completion no-op
        ctx.previewDirty = false;
        const params = mergedParams() as never;
        const t0 = performance.now();
        const evalRes = generatePreviewHeights(params, world, ctx.previewGridN);
        const cost = performance.now() - t0;
        ctx.previewLastCostMs = cost;
        if (cost > ctx.previewBudgetMs) {
          // Budget-drop ladder (spec section 2E): coarsen mid -> far, else drop
          // the frame (keep last preview, no count). Never a commit.
          if (ctx.previewGridN > ctx.previewFarGridN) {
            ctx.previewGridN = ctx.previewFarGridN;
            ctx.previewScratch.dispose();
            ctx.previewScratch = new PreviewScratchMeshImpl({
              gridN: ctx.previewGridN, worldMeters: world, scene: ctx.scene,
            });
            ctx.previewScratch.present();
            ctx.previewDirty = true; // retry at coarser grid next pump
          }
          return; // this frame dropped (not counted)
        }
        if (ctx.previewScratch.disposed) return;
        ctx.previewScratch.update(evalRes.heights);
        ctx.previewScratch.clearDirty();
        ctx.previewRebuildCount += 1; // third disjoint counter; never commit/camera
      }
      function teardown(): void {
        if (ctx.previewScratch) { ctx.previewScratch.dispose(); ctx.previewScratch = null; }
        ctx.previewActive = false;
        ctx.previewDirty = false;
        ctx.previewPendingPatch = null;
      }
      function probe() {
        return {
          present: Boolean(ctx.previewScratch),
          isVisible: ctx.previewScratch?.isVisible ?? false,
          gridN: ctx.previewGridN,
          farGridN: ctx.previewFarGridN,
          lastCostMs: ctx.previewLastCostMs,
          sampleHeight: ctx.previewScratch?.sampleHeight ?? 0,
          colorStats: ctx.previewScratch?.previewColorStats?.() ?? { minH: 0, maxH: 0, distinctColors: 0, colorVariance: 0 },
        };
      }
      return {
        begin,
        setLiveValue,
        pump,
        endCommit: teardown, // hard-swap: dispose scratch; commit runs via public setParams
        cancel: teardown,
        dispose: teardown,
        probe,
        setBudget: (ms: number) => { ctx.previewBudgetMs = ms; },
        setGrid: (n: number) => { ctx.previewGridN = Math.max(2, Math.floor(n)); },
      };
    })(),
    lodSweep: (poses) => runLodSweep(ctx.terrain, Array.isArray(poses) ? poses : PRESET_POSES),
  };
  for (const [name, fn] of Object.entries(devOnly)) {
    Object.defineProperty(publicRenderer, name, { value: fn, enumerable: false, writable: false });
  }
  // IEP Phase-2: wire the rAF pump to the preview seam pump (noop-safe).
  ctx.previewPump = () => {
    const seam = (publicRenderer as unknown as { preview?: { pump?: () => void } }).preview;
    seam?.pump?.();
  };
  return publicRenderer;
}
