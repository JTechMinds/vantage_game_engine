/**
 * Layer 1 M-T2 renderer — texture manifest loader and texture abstraction.
 *
 * This module is the single place the renderer learns *what* PBR textures are
 * available and *how* each map must be sampled (color space, tile size). It is
 * deliberately GPU-agnostic: it never touches `WebGLRenderingContext`,
 * `THREE.TextureLoader`, or the DOM. The WebGL adapter consumes the
 * `TextureBundle` produced here and uploads the pixel data itself.
 *
 * Provenance and licensing live in the committed manifest at
 * `assets/layer1/texture-manifest.json` (spec M-T2 §1). Only manifest-listed
 * surfaces are ever bound; unlisted assets are refused rather than silently
 * substituted (L1-AC-081, manifest `policy.enforcement`).
 *
 * Gate VIS coupling (spec §1, §6): a bundle built from development placeholders
 * reports `status: "placeholder"`, which blocks Gate VIS. Placeholders verify
 * the texture abstraction, UV scale, blending, and lighting pipeline, but a
 * placeholder-backed render is never a VIS pass and must never be submitted as
 * VIS evidence. `status` flips to `"approved"` only once the real CC0 assets
 * are present in the repo-local bundle and bound.
 */

import type { TextureStatus } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Manifest shape                                                      */
/* ------------------------------------------------------------------ */

/** Color space per map. Albedo is sRGB; every data map is linear (§1, §4). */
export type MapColorSpace = "srgb" | "linear";

export type TextureMapName =
  | "albedo"
  | "normal"
  | "roughness"
  | "ao"
  | "height";

/** Logical terrain surface a material binds. Matches the material channels. */
export type SurfaceName =
  | "sand"
  | "rock"
  | "grass"
  | "soil"
  | "snow"
  | "water"
  | "ice"
  | "sky";

export interface ManifestColorSpaceEntry {
  albedo?: MapColorSpace;
  normal?: MapColorSpace;
  roughness?: MapColorSpace;
  ao?: MapColorSpace;
  height?: MapColorSpace;
  radiance?: MapColorSpace;
}

export interface ManifestAsset {
  name: string;
  displayName?: string;
  sourceUrl: string;
  license: string;
  resolution: number;
  maps: TextureMapName[];
  colorSpace: ManifestColorSpaceEntry;
  tileMeters: number | null;
  targetSurface: SurfaceName;
  optional?: boolean;
  usage?: string;
}

export interface ManifestSkyHdri {
  name: string;
  displayName?: string;
  sourceUrl: string;
  license: string;
  resolution: number;
  format: string;
  maps: string[];
  colorSpace: ManifestColorSpaceEntry;
  tileMeters: number | null;
  targetSurface: SurfaceName;
  usage?: string;
}

export interface TextureManifest {
  manifestVersion: string;
  assets: ManifestAsset[];
  skyHdri: ManifestSkyHdri;
  gateStatus?: {
    texturesPresent?: boolean;
    textureStatus?: TextureStatus;
    gateVis?: string;
    note?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Resolved texture abstraction                                        */
/* ------------------------------------------------------------------ */

/**
 * One resolved map: the color space the sampler must use plus provenance and,
 * for approved bundles, the repo-local pixel source. Placeholders carry no
 * `sourcePath`; the WebGL adapter generates a labeled dev texture instead.
 */
export interface TextureMap {
  map: TextureMapName;
  colorSpace: MapColorSpace;
  /** Repo-local relative path for approved assets; null for placeholders. */
  sourcePath: string | null;
}

/** A fully-resolved set of maps for one surface, ready for GPU upload. */
export interface SurfaceTextureSet {
  surface: SurfaceName;
  /** Source asset name from the manifest, or "placeholder:<surface>". */
  assetName: string;
  /** Physical tile size in meters for UV calibration (§4). */
  tileMeters: number;
  /** Per-map color space + provenance. */
  maps: TextureMap[];
  /** Whether this set is backed by approved CC0 pixels or a dev placeholder. */
  status: TextureStatus;
  sourceUrl: string | null;
  license: string | null;
}

/** The texture bundle the WebGL adapter binds for a render. */
export interface TextureBundle {
  /** Aggregate status: "placeholder" if ANY surface is a placeholder. */
  status: TextureStatus;
  /** Per-surface resolved texture sets keyed by surface name. */
  surfaces: Record<SurfaceName, SurfaceTextureSet>;
  /** The HDRI/sky source descriptor (may itself be a placeholder). */
  sky: SurfaceTextureSet;
  /** Non-fatal notes for the evidence file (missing optional surfaces, etc.). */
  diagnostics: string[];
}

/** Required surfaces that must resolve to approved assets for Gate VIS (§1). */
export const REQUIRED_SURFACES: readonly SurfaceName[] = [
  "sand",
  "rock",
  "grass",
  "soil",
  "snow",
  "water",
  "sky",
];

/** Optional surfaces (e.g. alpine ice) that never block the gate on their own. */
export const OPTIONAL_SURFACES: readonly SurfaceName[] = ["ice"];

/** Surfaces rendered by a live analytic shader, not a CC0 texture map. Exempt from the manifest-coverage rule and the placeholder gate aggregation (spec M-T4 water amendment). */
export const ANALYTIC_SURFACES: readonly SurfaceName[] = ["water"];

/** Default physical tile size when the manifest omits tileMeters. */
const DEFAULT_TILE_METERS = 2;

/* ------------------------------------------------------------------ */
/* Placeholder surfaces                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-surface placeholder color-space contract. Placeholders mirror the real
 * bundle's map set and color spaces so the sampler path exercised in dev is the
 * same path production will take. Colors are arbitrary neutral values; they are
 * labeled dev-only by the adapter, never presented as approved visuals.
 */
const PLACEHOLDER_MAPS: Record<SurfaceName, TextureMapName[]> = {
  sand: ["albedo", "normal", "roughness", "ao", "height"],
  rock: ["albedo", "normal", "roughness", "ao", "height"],
  grass: ["albedo", "normal", "roughness", "ao", "height"],
  soil: ["albedo", "normal", "roughness", "ao", "height"],
  snow: ["albedo", "normal", "roughness", "ao", "height"],
  water: ["normal", "roughness"],
  ice: ["albedo", "normal", "roughness", "ao"],
  sky: ["albedo"],
};

function colorSpaceFor(map: TextureMapName): MapColorSpace {
  // Albedo (and the placeholder sky albedo) are color → sRGB. Data maps linear.
  return map === "albedo" ? "srgb" : "linear";
}

function placeholderSurface(surface: SurfaceName): SurfaceTextureSet {
  return {
    surface,
    assetName: `placeholder:${surface}`,
    tileMeters: DEFAULT_TILE_METERS,
    maps: PLACEHOLDER_MAPS[surface].map((map) => ({
      map,
      colorSpace: colorSpaceFor(map),
      sourcePath: null,
    })),
    status: "placeholder",
    sourceUrl: null,
    license: null,
  };
}

/* ------------------------------------------------------------------ */
/* Approved resolution                                                 */
/* ------------------------------------------------------------------ */

/**
 * Resolve one manifest asset into an approved texture set. `sourcePathFor` maps
 * a manifest asset + map name to the repo-local pixel path (relative to the
 * assets root). The adapter supplies the on-disk layout so this module stays
 * filesystem-agnostic and testable.
 */
export function resolveApprovedSurface(
  asset: ManifestAsset,
  sourcePathFor: (asset: ManifestAsset, map: TextureMapName) => string,
): SurfaceTextureSet {
  const tile =
    typeof asset.tileMeters === "number" && asset.tileMeters > 0
      ? asset.tileMeters
      : DEFAULT_TILE_METERS;
  const maps: TextureMap[] = asset.maps.map((map) => ({
    map,
    colorSpace: asset.colorSpace[map] ?? colorSpaceFor(map),
    sourcePath: sourcePathFor(asset, map),
  }));
  return {
    surface: asset.targetSurface,
    assetName: asset.name,
    tileMeters: tile,
    maps,
    status: "approved",
    sourceUrl: asset.sourceUrl,
    license: asset.license,
  };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export interface BuildBundleOptions {
  /**
   * When true, every surface resolves to a labeled dev placeholder and the
   * bundle reports `status: "placeholder"`. This is the default for M-T2
   * development builds while the approved CC0 assets are being sourced.
   */
  usePlaceholders?: boolean;
  /**
   * Map an approved manifest asset + map to its repo-local pixel path. Only
   * consulted when `usePlaceholders` is false. A surface whose maps cannot be
   * resolved falls back to a placeholder and records a diagnostic.
   */
  sourcePathFor?: (asset: ManifestAsset, map: TextureMapName) => string;
}

function emptySurfaceRecord(): Record<SurfaceName, SurfaceTextureSet> {
  const out = {} as Record<SurfaceName, SurfaceTextureSet>;
  for (const surface of [
    ...REQUIRED_SURFACES.filter((s) => s !== "sky"),
    ...OPTIONAL_SURFACES,
  ] as SurfaceName[]) {
    out[surface] = placeholderSurface(surface);
  }
  return out;
}

/**
 * Turn the committed manifest into a renderable texture bundle.
 *
 * Development builds (`usePlaceholders: true`, the default) resolve every
 * surface to a labeled placeholder and never claim Gate VIS readiness. With
 * `usePlaceholders: false`, manifest assets are resolved to approved sets via
 * the supplied path resolver; any surface that fails to resolve falls back to a
 * placeholder and the bundle stays `status: "placeholder"` — an incomplete
 * approved bundle is never reported as approved.
 */
export function buildTextureBundle(
  manifest: TextureManifest,
  options: BuildBundleOptions = {},
): TextureBundle {
  const usePlaceholders = options.usePlaceholders ?? true;
  const diagnostics: string[] = [];
  const surfaces = emptySurfaceRecord();

  let sky = placeholderSurface("sky");

  if (!usePlaceholders) {
    if (!options.sourcePathFor) {
      diagnostics.push(
        "approved bundle requested but no sourcePathFor resolver supplied; using placeholders",
      );
    } else {
      for (const asset of manifest.assets) {
        try {
          const set = resolveApprovedSurface(asset, options.sourcePathFor);
          surfaces[asset.targetSurface] = set;
        } catch (err) {
          diagnostics.push(
            `surface ${asset.targetSurface} could not resolve to approved pixels: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      try {
        sky = resolveSky(manifest.skyHdri, options.sourcePathFor);
      } catch (err) {
        diagnostics.push(
          `sky HDRI could not resolve to approved pixels: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Aggregate status: approved only if every required surface AND the sky are
  // approved. Optional surfaces (ice) never block the gate on their own.
  let status: TextureStatus = "approved";
  for (const surface of REQUIRED_SURFACES) {
    if (ANALYTIC_SURFACES.includes(surface)) continue;
    const set = surface === "sky" ? sky : surfaces[surface];
    if (!set || set.status !== "approved") {
      status = "placeholder";
      break;
    }
  }

  surfaces.sky = sky;

  if (status === "placeholder") {
    diagnostics.push(
      'texture bundle is placeholder-backed: Gate VIS is blocked (spec M-T2 §1, §6)',
    );
  }

  return { status, surfaces, sky, diagnostics };
}

function resolveSky(
  hdri: ManifestSkyHdri,
  sourcePathFor: (asset: ManifestAsset, map: TextureMapName) => string,
): SurfaceTextureSet {
  // The HDRI is a single radiance map (linear). Reuse the asset resolver by
  // adapting the HDRI descriptor to the asset shape for path lookup.
  const pseudoAsset: ManifestAsset = {
    name: hdri.name,
    displayName: hdri.displayName,
    sourceUrl: hdri.sourceUrl,
    license: hdri.license,
    resolution: hdri.resolution,
    maps: ["albedo"],
    colorSpace: { albedo: hdri.colorSpace.radiance ?? "linear" },
    tileMeters: hdri.tileMeters,
    targetSurface: "sky",
  };
  const set = resolveApprovedSurface(pseudoAsset, sourcePathFor);
  // Sky radiance is linear HDR, not sRGB color — override the albedo color space.
  set.maps = set.maps.map((m) => ({
    ...m,
    colorSpace: hdri.colorSpace.radiance ?? "linear",
  }));
  return set;
}

/* ------------------------------------------------------------------ */
/* Manifest parsing / validation                                       */
/* ------------------------------------------------------------------ */

export class TextureManifestError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "TextureManifestError";
    this.field = field;
  }
}

const KNOWN_SURFACES = new Set<string>([
  ...REQUIRED_SURFACES,
  ...OPTIONAL_SURFACES,
]);

/**
 * Parse and validate a manifest JSON string. Rejects malformed or
 * license-nonconforming manifests so an unreviewed or drifted asset never makes
 * it into a build (spec §1, manifest policy). Throws `TextureManifestError`
 * with the offending field on the first problem.
 */
export function parseTextureManifest(json: string): TextureManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new TextureManifestError(
      "manifest",
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new TextureManifestError("manifest", "manifest root must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.manifestVersion !== "string") {
    throw new TextureManifestError(
      "manifestVersion",
      "manifestVersion (string) is required",
    );
  }
  if (!Array.isArray(obj.assets)) {
    throw new TextureManifestError("assets", "assets must be an array");
  }
  if (typeof obj.skyHdri !== "object" || obj.skyHdri === null) {
    throw new TextureManifestError("skyHdri", "skyHdri object is required");
  }

  const assets: ManifestAsset[] = [];
  const seenSurfaces = new Set<string>();
  for (let i = 0; i < obj.assets.length; i += 1) {
    const a = obj.assets[i] as Record<string, unknown>;
    const where = `assets[${String(i)}]`;
    if (typeof a.name !== "string" || a.name.length === 0) {
      throw new TextureManifestError(`${where}.name`, "asset name is required");
    }
    if (typeof a.sourceUrl !== "string" || !isPolyHavenUrl(a.sourceUrl)) {
      throw new TextureManifestError(
        `${where}.sourceUrl`,
        `${a.name}: sourceUrl must be a polyhaven.com asset URL (approved source only)`,
      );
    }
    if (typeof a.license !== "string" || !isCc0(a.license)) {
      throw new TextureManifestError(
        `${where}.license`,
        `${a.name}: only CC0 licensing is accepted`,
      );
    }
    if (typeof a.targetSurface !== "string" || !KNOWN_SURFACES.has(a.targetSurface)) {
      throw new TextureManifestError(
        `${where}.targetSurface`,
        `${a.name}: unknown target surface`,
      );
    }
    if (!Array.isArray(a.maps) || a.maps.length === 0) {
      throw new TextureManifestError(
        `${where}.maps`,
        `${a.name}: at least one map is required`,
      );
    }
    seenSurfaces.add(a.targetSurface);
    assets.push(a as unknown as ManifestAsset);
  }

  // Every required non-sky surface must be present in the manifest.
  for (const surface of REQUIRED_SURFACES) {
    if (surface === "sky" || ANALYTIC_SURFACES.includes(surface)) continue;
    if (!seenSurfaces.has(surface)) {
      throw new TextureManifestError(
        "assets",
        `required surface "${surface}" is not covered by any manifest asset`,
      );
    }
  }

  const sky = obj.skyHdri as Record<string, unknown>;
  if (typeof sky.sourceUrl !== "string" || !isPolyHavenUrl(sky.sourceUrl)) {
    throw new TextureManifestError(
      "skyHdri.sourceUrl",
      "sky HDRI sourceUrl must be a polyhaven.com asset URL",
    );
  }
  if (typeof sky.license !== "string" || !isCc0(sky.license)) {
    throw new TextureManifestError(
      "skyHdri.license",
      "sky HDRI must be CC0 licensed",
    );
  }

  return raw as unknown as TextureManifest;
}

function isPolyHavenUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "polyhaven.com" || u.hostname === "dl.polyhaven.org")
    );
  } catch {
    return false;
  }
}

function isCc0(license: string): boolean {
  return /^cc0[- ]?1(\.0)?$/i.test(license.trim());
}

/* ------------------------------------------------------------------ */
/* Gate helper                                                         */
/* ------------------------------------------------------------------ */

/** True only when the bundle is fully approved and Gate VIS may proceed. */
export function gateVisReady(bundle: TextureBundle): boolean {
  return bundle.status === "approved";
}
