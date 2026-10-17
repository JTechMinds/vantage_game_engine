/**
 * Layer 1 M-T2 renderer — shared type definitions.
 *
 * Types and constants only; no runtime logic lives here. The renderer adapter
 * is a pure consumer of the public Layer 1 terrain API and public snapshot.
 * It must not import generation internals, private height arrays, biome
 * tables, UI state, or Layer 2 systems.
 *
 * Ownership boundaries (spec M-T2 §2, §10):
 * - The headless core owns terrain state, generation, validation, and the
 *   sampleHeight seam. The renderer owns display state and GPU-derived caches
 *   only; those caches are derived data, never an alternate source of truth.
 * - No type in this module exposes a terrain mutation pathway.
 */

import type {
  BiomeId,
  TerrainLayer,
  TerrainParams,
  TerrainSnapshot,
  TerrainWorldSize,
} from "../terrain/index.ts";

export type { BiomeId, TerrainLayer, TerrainParams, TerrainSnapshot, TerrainWorldSize };

/* ------------------------------------------------------------------ */
/* Mesh and geometry types (spec §3)                                   */
/* ------------------------------------------------------------------ */

/** Discrete quality tier (spec §11.1). near = full heightfield density. */
export type LodTier = "near" | "mid" | "far" | "skybox";

export interface TerrainMeshBuffers {
  /** XYZ interleaved vertex positions, world meters, Y up. Length = vertexCount * 3. */
  positions: Float32Array;
  /** XYZ interleaved smooth normals, unit length. Length = vertexCount * 3. */
  normals: Float32Array;
  /** UV interleaved, world-space-meter-calibrated tiling (spec §4). Length = vertexCount * 2. */
  uvs: Float32Array;
  /** Triangle index buffer, consistent CCW winding (spec §3.3). Length = triangleCount * 3. */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** Vertices per side of the regular grid this mesh was built from. */
  vertexGrid: number;
  worldWidth: number;
  worldDepth: number;
  /** Meter spacing between adjacent grid vertices. */
  spacing: number;
  /** LOD tier this buffer represents; "near" for the full-resolution base mesh. */
  lodLevel: LodTier;
}

/**
 * Structured result of the spec §3.8 mesh-integrity checks. Every check is
 * reported individually so automated tests can prove the mesh is clean before
 * visual review; `pass` is the conjunction of all required checks.
 */
export interface MeshIntegrityReport {
  pass: boolean;
  /** 1. All vertex positions finite. */
  positionsFinite: boolean;
  /** 2. All vertex Y values finite. */
  heightsFinite: boolean;
  /** 3. All X/Z within world bounds within numerical tolerance. */
  boundsValid: boolean;
  /** 4. All indices reference valid vertices. */
  indicesValid: boolean;
  /** 5. Triangle count matches expected grid topology. */
  triangleCountMatches: boolean;
  /** 6. No degenerate triangles (duplicate vertex indices). */
  noDegenerateTriangles: boolean;
  /** 7. All normals finite. */
  normalsFinite: boolean;
  /** 8. All normals unit length within tolerance. */
  normalsNormalized: boolean;
  /** 9. No NaN/Infinity in position or normal buffers. */
  noNaN: boolean;
  /** 10. No missing cells / holes for the configured grid size. */
  noHoles: boolean;
  /** Reported dimensions and stats (spec §6: dimensions, counts, min/max height). */
  vertexGrid: number;
  vertexCount: number;
  triangleCount: number;
  expectedTriangleCount: number;
  worldWidth: number;
  worldDepth: number;
  heightMin: number;
  heightMax: number;
  /** Human-readable failure details; empty when every check passed. */
  errors: string[];
}

/* ------------------------------------------------------------------ */
/* Camera and LOD types (spec §11)                                     */
/* ------------------------------------------------------------------ */

/** Camera pose in world-space meters. Y up. Used for LOD tier selection. */
export interface CameraPose {
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

/**
 * LOD tier boundaries in meters. Defaults are derived from world width so
 * they scale with the snapshot worldSize instead of hard-coding 512 m
 * (spec §11.1: 512 m world → near ≤ 80, mid ≤ 200, far ≤ 400).
 * A region's tier: distance <= nearM → "near"; <= maxMidM → "mid";
 * <= maxFarM → "far"; beyond → "skybox".
 */
export interface LodConfig {
  nearM: number;
  maxMidM: number;
  maxFarM: number;
}

/** One LOD region (chunk) with its deterministic tier assignment. */
export interface LodRegion {
  /** Region index along X. */
  cx: number;
  /** Region index along Z. */
  cz: number;
  /** World-space center of the region (meters). */
  centerX: number;
  centerZ: number;
  tier: LodTier;
  /** Distance (m) from camera to region center used for tier selection. */
  centerDistance: number;
  /** M-P3: base-grid cell span along X for this region. */
  spanX: number;
  /** M-P3: base-grid cell span along Z for this region. */
  spanZ: number;
  /** M-P3: base-grid cell index where this region starts along X. */
  cellStartX: number;
  /** M-P3: base-grid cell index where this region starts along Z. */
  cellStartZ: number;
}

/** Debug overlay state (spec §11.4). Off by default; never in production builds. */
export interface LodDebugState {
  enabled: boolean;
  regions: readonly LodRegion[];
  overlayVisible: boolean;
}

/* ------------------------------------------------------------------ */
/* Visual system state types (spec §4, §5)                             */
/* ------------------------------------------------------------------ */

/** Lighting state derived from timeOfDay; shared by sky, water reflection, terrain ambient. */
export interface LightingState {
  /** Normalized sun direction (from origin toward sun), Y-up world space. */
  sunDir: [number, number, number];
  /** Linear RGB sun color [0..1]. */
  sunColor: [number, number, number];
  /** Linear RGB ambient color [0..1]. */
  ambientColor: [number, number, number];
  /** Linear RGB sky tint used for reflection and fog [0..1]. */
  skyTint: [number, number, number];
  /** Source parameter (hours, [0,24)) this state was derived from. */
  timeOfDay: number;
}

/** Water animation state derived from wind parameters; never mutates terrain. */
export interface WaterState {
  /** Source windIntensity [0,10]. */
  windIntensity: number;
  /** windDirection converted to radians; continuous across the 0/360 boundary. */
  windDirectionRad: number;
  /** Ripple amplitude scale (0 calm..1 storm). */
  rippleAmplitude: number;
  /** Ripple scroll speed multiplier. */
  rippleSpeed: number;
  /** True when depth-driven color transition is active (shallow turquoise → deep blue). */
  depthVisible: boolean;
}

/** Smooth material blend weights per surface channel; sum to 1 at each sample point. */
export interface MaterialBlendWeights {
  sand: number;
  rock: number;
  grass: number;
  soil: number;
  snow: number;
}

/** Texture provenance status for gate reporting. Placeholders block Gate VIS. */
export type TextureStatus = "placeholder" | "approved";

/** Aggregate renderer status for tests, telemetry, and Gate VIS evidence notes. */
export interface RendererStatus {
  /** Latest mesh integrity report (null before first build). */
  mesh: MeshIntegrityReport | null;
  /** Current LOD debug state. */
  lod: LodDebugState;
  /** Whether the bound texture bundle is placeholders or approved PBR assets. */
  textureStatus: TextureStatus;
  /** Non-fatal renderer-side diagnostics (readable, never mutated terrain). */
  diagnostics: string[];
}

/* ------------------------------------------------------------------ */
/* Renderer options and public surface                                 */
/* ------------------------------------------------------------------ */

/**
 * Options accepted by the renderer factory. The renderer derives world size and
 * terrain identity from the public snapshot; nothing here authorizes terrain
 * mutation. `terrain` is consumed read-only through its public API.
 */
export interface RendererOptions {
  /** Target canvas element for the WebGL context. Required for mount. */
  canvas: HTMLCanvasElement;
  /**
   * The public terrain layer the renderer consumes. The renderer calls only
   * public read methods (snapshot, sampleHeight, getParams, telemetry, on) and
   * never setParams/generate/reset/deserialize — no terrain mutation path.
   */
  terrain: TerrainLayer;
  /**
   * Optional LOD boundary override. Distances are meters; when omitted the
   * renderer derives defaults scaled from the snapshot's world size.
   */
  lodConfig?: Partial<LodConfig>;
  /** Start with the wireframe debug overlay on. Default false (production). */
  wireframe?: boolean;
  /** Start with the LOD debug overlay on. Default false (production). */
  lodDebug?: boolean;
  /** Override the dev/approved texture status label for evidence notes. */
  textureStatus?: TextureStatus;
}

/**
 * Public renderer surface. Deliberately exposes only read/rebuild/appearance
 * operations plus debug accessors. There is intentionally NO method that
 * mutates terrain parameters, heightfield data, or generation state — the
 * headless core stays the sole source of truth (spec §2, §10).
 */
export interface TerrainRendererPublic {
  /** Attach the WebGL scene to the canvas and perform the first render. */
  mount(): void;
  /** Release GPU resources and remove event subscriptions. */
  dispose(): void;
  /**
   * Rebuild geometry, normals, and material fields from the current public
   * snapshot. Called on generation-complete / geometry-affecting changes.
   * Reads the snapshot only; writes no terrain state.
   */
  rebuildFromSnapshot(): void;
  /** Apply appearance-only parameters (time of day, wind) via uniforms. */
  applyAppearance(params: Readonly<TerrainParams>): void;
  /** Update camera pose; drives LOD tier selection deterministically. */
  setCamera(pose: CameraPose): void;
  /** Toggle the wireframe debug overlay (renderer display state only). */
  setWireframe(enabled: boolean): void;
  /** Toggle the LOD debug overlay (off in production builds). */
  setLodDebug(enabled: boolean): void;
  /** Aggregate status for tests and evidence. */
  getStatus(): RendererStatus;
  /** Most recent LOD region assignments (deterministic for camera+terrain). */
  getLodRegions(): readonly LodRegion[];
  /** Read-only scene-graph summary for browser verification (camera pos, terrain bbox, region/tri counts). */
  debugSceneSummary(): string;
  /** Re-sync WebGL viewport and camera aspect to the canvas layout box (call on window resize). */
  resize(): void;
}


/* ------------------------------------------------------------------ */
/* IEP Phase-2 scaffold (spec-interactive-edit-preview-phase1.md §2D)  */
/* ------------------------------------------------------------------ */

/**
 * Phase-2 contract: a disposable geometry buffer for the live reduced-resolution
 * preview. Phase 1 defines the shape ONLY; no implementation, no construction,
 * no disposal exists in Phase 1 (IEP-AC-07 asserts no scratch mesh is ever built
 * this phase). Internal type — NOT part of TerrainRendererPublic, so the frozen
 * public surface and the API-surface diff stay byte-identical (IEP-AC-08).
 */
export interface PreviewScratchMesh {
  readonly isPreview: true;
  /** Dispose the scratch buffer; called on commit or cancel. */
  dispose(): void;
  /** Whether the scratch mesh is currently visible in the scene. */
  readonly isVisible: boolean;
}
