/**
 * Layer 1 M-T2 renderer — pure material and visual-state derivation.
 *
 * Everything in this module is a deterministic, side-effect-free function of
 * the public Layer 1 parameter values (and, where noted, a sampled height and
 * slope). It reads no private terrain state, mutates nothing, and touches no
 * GPU/WebGL API. The functions here are the single place where the renderer
 * decides *how the scene should look* for a given parameter set; the WebGL
 * adapter consumes their output and turns it into shader uniforms and material
 * instances. Keeping the math here (rather than embedded in the renderer) means
 * material blending, lighting, water, and sky behavior are unit-testable without
 * a browser, satisfying the spec §6 automated-test requirements without stubbing
 * a renderer.
 *
 * Ownership boundaries (spec M-T2 §2, §4, §5):
 * - Time of day, wind intensity, and wind direction are appearance-only
 *   parameters. Applying them here never regenerates terrain and never changes
 *   `sampleHeight` output (L1-AC-154).
 * - Material selection is derived from terrain metadata and sampled surface
 *   attributes (height, slope, biome), never from UI state, and never written
 *   back into terrain state.
 * - All returned vectors and weights are finite; invalid inputs throw rather
 *   than silently produce NaN that could poison a frame (spec §3.6 discipline).
 */

import type { BiomeId } from "../terrain/index.ts";
import type {
  LightingState,
  MaterialBlendWeights,
  WaterState,
} from "./types.ts";


/**
 * Smoothstep band helper: 0 below edge0, 1 above edge1, smooth in between.
 * Continuous first derivative at both ends, which is what keeps material
 * transitions free of hard painted bands (spec §4).
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
/** Clamp to [lo,hi]; non-finite inputs fall back to lo. */
function clampFinite(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return clampFinite(v, 0, 1);
}

/** Clamp a wind-style value to [0,10]. */
function clampUnit10(v: number): number {
  return clampFinite(v, 0, 10);
}

/** Linear interpolation between a and b at t in [0,1]. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/**
 * Per-biome blend profile: elevation/slope bands that drive channel weights.
 * Values are normalized height (0..1) and slope (0..1, 0 flat → 1 vertical).
 * Bands intentionally overlap so every transition is continuous.
 */
interface BiomeBlendProfile {
  /** Sand decays above this normalized height (band start/end). */
  sandBand: [number, number];
  /** Grass active band (normalized height). */
  grassBand: [number, number];
  /** Soil/dirt band sits between grass and rock. */
  soilBand: [number, number];
  /** Rock rises with slope and with height above this. */
  rockHeight: [number, number];
  /** Extra rock weight contributed at full slope. */
  rockSlope: [number, number];
  /** Snow onset band (normalized height) and the slope that suppresses it. */
  snowBand: [number, number];
  snowSlopeCut: [number, number];
  /** Baseline channel biases {sand, rock, grass, soil, snow} at flat low ground. */
  lowGround: MaterialBlendWeights;
}

const BIOME_PROFILES: Record<BiomeId, BiomeBlendProfile> = {
  desert: {
    sandBand: [0, 0.85],
    grassBand: [0.9, 1],
    soilBand: [0.55, 0.8],
    rockHeight: [0.6, 0.9],
    rockSlope: [0.35, 0.7],
    snowBand: [0.97, 1],
    snowSlopeCut: [0.8, 0.95],
    lowGround: { sand: 1, rock: 0, grass: 0, soil: 0, snow: 0 },
  },
  highlands: {
    sandBand: [0, 0.12],
    grassBand: [0.05, 0.6],
    soilBand: [0.4, 0.75],
    rockHeight: [0.55, 0.85],
    rockSlope: [0.3, 0.65],
    snowBand: [0.88, 1],
    snowSlopeCut: [0.75, 0.92],
    lowGround: { sand: 0.15, rock: 0, grass: 1, soil: 0.1, snow: 0 },
  },
  alpine: {
    sandBand: [0, 0.05],
    grassBand: [0.02, 0.3],
    soilBand: [0.25, 0.5],
    rockHeight: [0.3, 0.6],
    rockSlope: [0.25, 0.55],
    snowBand: [0.6, 0.8],
    snowSlopeCut: [0.7, 0.9],
    lowGround: { sand: 0, rock: 0.2, grass: 0.4, soil: 0.2, snow: 0 },
  },
  water: {
    sandBand: [0, 0.25],
    grassBand: [0.15, 0.6],
    soilBand: [0.45, 0.75],
    rockHeight: [0.6, 0.9],
    rockSlope: [0.35, 0.7],
    snowBand: [0.9, 1],
    snowSlopeCut: [0.8, 0.95],
    lowGround: { sand: 0.6, rock: 0, grass: 0.3, soil: 0.1, snow: 0 },
  },
  caribbean: {
    sandBand: [0, 0.3],
    grassBand: [0.2, 0.55],
    soilBand: [0.4, 0.7],
    rockHeight: [0.65, 0.9],
    rockSlope: [0.4, 0.75],
    snowBand: [0.97, 1],
    snowSlopeCut: [0.85, 1],
    lowGround: { sand: 1, rock: 0, grass: 0.15, soil: 0, snow: 0 },
  },
};

/**
 * Material blend weights at a world sample point.
 *
 * Inputs are all derived from public terrain state: `normalizedHeight` is the
 * height mapped through the snapshot's heightMin/heightMax range, `slope` is
 * 1 - normal.y from the render normal (0 flat, 1 vertical), and `params.biome`
 * selects the profile. Weights are continuous in every input (no single
 * threshold produces a hard band) and always sum to 1 for finite inputs.
 *
 * Snow rises with elevation and is suppressed on very steep slopes so coverage
 * never reads as a horizontal cutoff line (spec §4, L1-AC-084).
 */
export function materialWeightsAt(
  params: Readonly<TerrainParams>,
  normalizedHeight: number,
  slope: number,
): MaterialBlendWeights {
  const h = Number.isFinite(normalizedHeight) ? Math.min(1, Math.max(0, normalizedHeight)) : 0;
  const sl = Number.isFinite(slope) ? Math.min(1, Math.max(0, slope)) : 0;
  const p = BIOME_PROFILES[params.biome] ?? BIOME_PROFILES.highlands;

  const sand = p.lowGround.sand * (1 - smoothstep(p.sandBand[0], p.sandBand[1], h));
  const grass =
    p.lowGround.grass *
    smoothstep(p.grassBand[0], p.grassBand[0] + 0.08, h) *
    (1 - smoothstep(p.grassBand[1] - 0.08, p.grassBand[1], h));
  const soil =
    Math.max(p.lowGround.soil, smoothstep(p.soilBand[0], p.soilBand[1], h)) *
    (1 - smoothstep(p.soilBand[1], p.soilBand[1] + 0.15, h));
  const rock = Math.max(
    p.lowGround.rock,
    smoothstep(p.rockHeight[0], p.rockHeight[1], h),
    smoothstep(p.rockSlope[0], p.rockSlope[1], sl),
  );
  const snowRise = smoothstep(p.snowBand[0], p.snowBand[1], h);
  const snowHold = 1 - smoothstep(p.snowSlopeCut[0], p.snowSlopeCut[1], sl);
  const snow = snowRise * snowHold;

  // Steep slopes shed sand/grass/soil toward rock (contact shading realism).
  const shed = smoothstep(0.5, 0.85, sl);
  const raw: MaterialBlendWeights = {
    sand: sand * (1 - shed),
    grass: grass * (1 - shed),
    soil: soil * (1 - shed * 0.5),
    rock: rock + shed * (sand + grass) * 0.5,
    snow,
  };

  // Guard against pathological inputs, then normalize to a partition.
  let sum = 0;
  for (const k of ["sand", "rock", "grass", "soil", "snow"] as const) {
    if (!Number.isFinite(raw[k]) || raw[k] < 0) raw[k] = 0;
    sum += raw[k];
  }
  if (sum <= 0) {
    return { sand: 0, rock: 0, grass: 1, soil: 0, snow: 0 };
  }
  return {
    sand: raw.sand / sum,
    rock: raw.rock / sum,
    grass: raw.grass / sum,
    soil: raw.soil / sum,
    snow: raw.snow / sum,
  };
}

/* Lighting from time of day (spec §4) */

/**
 * Lighting model driven by the public `timeOfDay` parameter (hours, [0,24)).
 *
 * Appearance-only: changing time of day must never regenerate terrain geometry
 * (spec §2, §4). This function is pure and deterministic so tests can assert
 * sun/ambient/sky behavior without a GPU, and so the WebGL adapter, the sky
 * system, and the water reflection tone all read the same single model
 * (spec §4: "expose enough state for the water and sky systems to share the
 * same visual time-of-day model").
 *
 * Model summary:
 * - Sun travels a tilted arc; elevation peaks at 12:00, reaches its low point
 *   at 00:00. Azimuth sweeps 0 → 360 across the day so dawn sits low in the
 *   east and dusk low in the west.
 * - Near the horizon (dawn/dusk) the sun reddens and dims, producing the
 *   required warm low-angle light.
 * - At night the direct sun is strongly reduced but never fully black, so the
 *   scene darkens while staying readable (L1-AC-091).
 * - Ambient and sky tint track the same arc so terrain ambient lighting and
 *   water reflection tone change together.
 *
 * All returned vectors are finite and normalized; all colors are linear RGB
 * in [0,1] (spec §4 color-space rule: material/lighting math happens in
 * renderer working space, not sRGB).
 */

/** Clamp helper kept local so this section has no cross-section coupling. */
function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation helper (local, no shared-module dependency). */
function lerpUnit(a: number, b: number, t: number): number {
  return a + (b - a) * clampUnit(t);
}

/** Smoothstep on [0,1] input; used to soften the horizon transition. */
function smooth01(t: number): number {
  const x = clampUnit(t);
  return x * x * (3 - 2 * x);
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const k = clampUnit(t);
  return [
    lerpUnit(a[0], b[0], k),
    lerpUnit(a[1], b[1], k),
    lerpUnit(a[2], b[2], k),
  ];
}

/** Daytime linear-RGB references. Tuned for bright, readable production frames. */
const SUN_NOON: readonly [number, number, number] = [1.0, 0.97, 0.9];
const SUN_WARM: readonly [number, number, number] = [1.0, 0.62, 0.34];
const SUN_NIGHT: readonly [number, number, number] = [0.16, 0.2, 0.34];

const SKY_DAY: readonly [number, number, number] = [0.52, 0.66, 0.88];
const SKY_DUSK: readonly [number, number, number] = [0.86, 0.52, 0.4];
const SKY_NIGHT: readonly [number, number, number] = [0.06, 0.09, 0.18];

const AMBIENT_DAY: readonly [number, number, number] = [0.42, 0.46, 0.52];
const AMBIENT_DUSK: readonly [number, number, number] = [0.3, 0.24, 0.26];
const AMBIENT_NIGHT: readonly [number, number, number] = [0.12, 0.14, 0.2];

/**
 * Fraction of "dayness" for a given hour: 1 at local noon, 0 at local
 * midnight, with a smooth transition through dawn and dusk.
 */
function daynessForTime(timeOfDay: number): number {
  // Map hour → phase in [0,1) where 0.5 is noon.
  const phase = (((timeOfDay % 24) + 24) % 24) / 24;
  // cos peaks at phase 0.5 (noon); remap to [0,1].
  return clampUnit(0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
}

/**
 * Derive the full lighting state for one time-of-day value.
 *
 * @param timeOfDay Public parameter, hours in [0,24). Out-of-range values are
 *   wrapped rather than rejected, mirroring the core's tolerant normalization
 *   and keeping the renderer from throwing on a transient UI value.
 */
export function lightingForTime(timeOfDay: number): LightingState {
  const hour = Number.isFinite(timeOfDay) ? ((timeOfDay % 24) + 24) % 24 : 12;
  const phase = hour / 24;

  // Sun arc: elevation from -1 (midnight, below horizon) to +1 (noon).
  const elevation = -Math.cos(phase * Math.PI * 2);
  // Azimuth sweeps the full circle once per day; 06:00 faces +X (east-ish).
  const azimuth = (phase - 0.25) * Math.PI * 2;

  const horiz = Math.sqrt(Math.max(0, 1 - elevation * elevation));
  let sx = Math.cos(azimuth) * horiz;
  let sy = elevation;
  let sz = Math.sin(azimuth) * horiz * 0.35; // slight tilt so shadows read on the XZ plane

  const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (!Number.isFinite(len) || len === 0) {
    // Degenerate guard: never return a zero-length or NaN sun direction.
    sx = 0;
    sy = 1;
    sz = 0;
  } else {
    sx /= len;
    sy /= len;
    sz /= len;
  }

  const dayness = daynessForTime(hour);
  // Horizon proximity: high near dawn/dusk, low at noon and midnight.
  const horizonBlend = smooth01(1 - Math.abs(elevation) / 0.35);
  const isNight = dayness < 0.5;

  let sunColor = mixRgb(SUN_NOON, SUN_WARM, horizonBlend);
  if (isNight) {
    // Fade the direct sun toward a dim moonlit tone as night deepens.
    const nightDepth = clampUnit((0.5 - dayness) / 0.5);
    sunColor = mixRgb(sunColor, SUN_NIGHT, nightDepth);
  }

  // Night keeps a floor of direct light so terrain stays readable (L1-AC-091).
  const sunStrength = isNight ? lerpUnit(0.35, 1, dayness * 2) : lerpUnit(0.75, 1, dayness);
  sunColor = [
    clampUnit(sunColor[0] * sunStrength),
    clampUnit(sunColor[1] * sunStrength),
    clampUnit(sunColor[2] * sunStrength),
  ];

  const skyTint = isNight
    ? mixRgb(mixRgb(SKY_DUSK, SKY_NIGHT, clampUnit((0.5 - dayness) / 0.5)), SKY_DAY, 0)
    : mixRgb(SKY_DUSK, SKY_DAY, smooth01(dayness * 1.25));
  const ambientColor = isNight
    ? mixRgb(AMBIENT_DUSK, AMBIENT_NIGHT, clampUnit((0.5 - dayness) / 0.5))
    : mixRgb(AMBIENT_DUSK, AMBIENT_DAY, smooth01(dayness * 1.25));

  return {
    sunDir: [sx, sy, sz],
    sunColor: [clampUnit(sunColor[0]), clampUnit(sunColor[1]), clampUnit(sunColor[2])],
    ambientColor: [
      clampUnit(ambientColor[0]),
      clampUnit(ambientColor[1]),
      clampUnit(ambientColor[2]),
    ],
    skyTint: [clampUnit(skyTint[0]), clampUnit(skyTint[1]), clampUnit(skyTint[2])],
    timeOfDay: hour,
  };
}

/* Water state from wind (spec §5) */

/** Minimum residual ripple amplitude/speed so wind=0 reads as calm water, not frozen/glitched (spec §5 edge cases). */
const CALM_RIPPLE_AMPLITUDE = 0.05;
const CALM_RIPPLE_SPEED = 0.1;

/** Biomes whose generated depth data drives the shallow→deep water color transition (spec §5). */
const DEPTH_AWARE_BIOMES: ReadonlySet<BiomeId> = new Set<BiomeId>(["water", "caribbean"]);

/**
 * Derive water animation state from the public wind parameters only.
 *
 * Pure and deterministic: same inputs → same WaterState. The renderer applies
 * the result through shader uniforms; it never regenerates terrain geometry
 * for wind changes and never mutates terrain state (spec §5, §2).
 *
 * - `windIntensity` is clamped to [0,10] and mapped to ripple amplitude and
 *   speed. At intensity 0 the water stays gently animated (calm) rather than
 *   frozen, so the surface never glitches into a flat static plane.
 * - `windDirectionDeg` is normalized to [0,360) then converted to radians.
 *   Normalization keeps orientation continuous across the 0/360 boundary, so a
 *   change from 359° to 1° rotates ripples the short way instead of snapping.
 * - `depthVisible` enables the depth-driven turquoise→blue transition only for
 *   biomes that expose water depth data; other biomes keep a single water tone.
 */
export function waterStateFromWind(
  windIntensity: number,
  windDirectionDeg: number,
  biome: BiomeId,
): WaterState {
  const intensity = clampFinite(windIntensity, 0, 10);
  // Normalize direction into [0,360) so the radian value is continuous across
  // the compass wrap. A finite guard keeps NaN/Infinity out of the uniform.
  const normalizedDeg = Number.isFinite(windDirectionDeg)
    ? ((windDirectionDeg % 360) + 360) % 360
    : 0;
  const windDirectionRad = (normalizedDeg * Math.PI) / 180;

  // Intensity 0..10 → 0..1, then blended with a calm floor so zero wind still
  // produces a living (if gentle) surface.
  const normalized = intensity / 10;
  const rippleAmplitude = CALM_RIPPLE_AMPLITUDE + normalized * (1 - CALM_RIPPLE_AMPLITUDE);
  const rippleSpeed = CALM_RIPPLE_SPEED + normalized * (1 - CALM_RIPPLE_SPEED);

  return {
    windIntensity: intensity,
    windDirectionRad,
    rippleAmplitude,
    rippleSpeed,
    depthVisible: DEPTH_AWARE_BIOMES.has(biome),
  };
}

/* Sky state (spec §5) */

export interface SkyState {
  /** Linear RGB color at the zenith (top of the sky dome) [0..1]. */
  zenithColor: [number, number, number];
  /** Linear RGB color at the horizon [0..1]. */
  horizonColor: [number, number, number];
  /** Linear RGB sun/moon tint shared with the lighting model so water
   *  reflections read as the same sky the terrain is lit by (spec §5). */
  sunTint: [number, number, number];
  /** Cloud/atmosphere drift speed in sky-texture units per second. Always > 0
   *  so wind intensity 0 stays calm but never freezes or glitches (spec §5). */
  cloudDriftSpeed: number;
  /** Cloud drift direction in radians, continuous across the 0/360 boundary. */
  cloudDriftDirectionRad: number;
  /** Star field visibility 0 (day) .. 1 (deep night). */
  starOpacity: number;
  /** Source parameter (hours, [0,24)) this state was derived from. */
  timeOfDay: number;
}

/** Continuous compass→radians conversion. Folding through atan2 keeps the
 *  drift direction identical at 0° and 360° so a wind sweep across the seam is
 *  smooth rather than a snap (spec §5). */
export function windDirectionToRadians(windDirectionDeg: number): number {
  const rad = (windDirectionDeg * Math.PI) / 180;
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

/**
 * Live-sky model shared with the lighting and water systems (spec §5).
 *
 * The sky is a gradient driven by the same sun-elevation arc as
 * `lightingForTime`, so terrain ambient, water reflection tone, and sky color
 * all move together with time of day. Cloud drift is driven by the same wind
 * parameters as the water ripples. All outputs are finite; wind intensity 0
 * produces a slow baseline drift, never a frozen or NaN state.
 */
export function skyStateForTime(
  timeOfDay: number,
  windIntensity: number,
  windDirectionDeg: number,
): SkyState {
  // Reuse the lighting model so sun tint and elevation match exactly.
  const light = lightingForTime(timeOfDay);
  const sunElevation = clamp01(light.sunDir[1]); // -1..1 → 0 below .. 1 overhead

  // Day factor: 0 at night, ramps up through dawn/dusk via the sun elevation.
  const dayFactor = smoothstep(-0.12, 0.25, sunElevation);

  // Warm horizon bias at low sun (dawn/dusk), cool zenith at midday.
  const warmth = smoothstep(0.0, 0.45, 1 - Math.abs(sunElevation));

  const zenithColor: [number, number, number] = [
    lerp(0.02, 0.16, dayFactor) + warmth * 0.04,
    lerp(0.03, 0.32, dayFactor) + warmth * 0.02,
    lerp(0.08, 0.62, dayFactor),
  ];
  const horizonColor: [number, number, number] = [
    lerp(0.05, 0.72, dayFactor) + warmth * 0.22,
    lerp(0.06, 0.66, dayFactor) + warmth * 0.08,
    lerp(0.12, 0.72, dayFactor) - warmth * 0.05,
  ];

  // Cloud drift: small constant base so calm wind still moves subtly, plus a
  // linear contribution from wind intensity. Never zero, never discontinuous.
  const w = clampUnit10(windIntensity);
  const cloudDriftSpeed = 0.02 + w * 0.18;
  const cloudDriftDirectionRad = windDirectionToRadians(windDirectionDeg);

  // Stars fade in only when the sun is well below the horizon.
  const starOpacity = 1 - smoothstep(-0.25, -0.02, sunElevation);

  return {
    zenithColor,
    horizonColor,
    sunTint: light.sunColor,
    cloudDriftSpeed,
    cloudDriftDirectionRad,
    starOpacity,
    timeOfDay,
  };
}
