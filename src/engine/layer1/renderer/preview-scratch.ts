import * as THREE from "three";
import type { PreviewScratchMesh } from "./types.ts";
import {
  applyHeightRamp,
  DEFAULT_RAMP_SRGB,
  type RampPalette,
  type RampRange,
} from "./preview-ramp.ts";

/**
 * IEP Phase-2 (spec-interactive-edit-preview-phase2.md §2B): the concrete,
 * disposable scratch mesh the live preview draws into during an interactive
 * edit of a `regenerates:true` control.
 *
 * Isolation contract (§2B, §5.2-10): this object and its buffers are DISJOINT
 * from the committed tier meshes, the base/near mesh, the full-res mesh, the
 * Heightfield snapshot, and sampleHeight. It is added to the scene as an
 * INDEPENDENT top-level node (NOT under `terrainGroup`), so every collection the
 * seam-stitch / mesh-integrity / determinism suites enumerate (they walk
 * terrainGroup / the base mesh / the snapshot) never sees it. That isolation is
 * structural (a separate node), not timing-dependent.
 *
 * Headless behavior: the CI harness never mounts a GL context, so `scene` is
 * null. The scratch still exists logically — `isVisible` is the present-flag
 * between construction and `dispose()`, which is what IEP-AC-07 samples on a
 * headless drag. The THREE node is only built when a real scene is supplied.
 *
 * Height-ramp (spec-preview-height-ramp.md §5.2): the stripped unlit material
 * now paints per-vertex COLOR derived from each vertex's height, so the preview
 * reads as relief (a height map) while dragging. The color buffer is as disjoint
 * from committed meshes as the position buffer already is, and the ramp is a
 * pure function of the height field (computed in `update` regardless of
 * `_geometry`, so headless CI can sample it). The committed material pipeline
 * (materials.ts) is untouched; the ramp never reaches the committed or reverted
 * frame.
 */
export interface PreviewScratchOptions {
  readonly gridN: number;
  readonly worldMeters: number;
  readonly scene: THREE.Scene | null;
  /**
   * Optional sRGB hex palette [low, mid, high]. Construction converts these to
   * linear RGB once (three stays out of preview-ramp.ts). Defaults to
   * DEFAULT_RAMP_SRGB (spec §4 / §16 R-Q1). Construction config for an internal
   * class — NOT a public surface (spec §7).
   */
  readonly srgbStops?: readonly [number, number, number];
}

export class PreviewScratchMeshImpl implements PreviewScratchMesh {
  readonly isPreview = true as const;

  private _visible = false;
  private _disposed = false;
  private _dirty = false;
  private _mesh: THREE.Mesh | null = null;
  private _geometry: THREE.BufferGeometry | null = null;
  private _material: THREE.MeshBasicMaterial | null = null;
  private _positions: Float32Array;
  private _colors: Float32Array;
  private _heights: Float64Array;
  private readonly gridN: number;
  private readonly worldMeters: number;
  private _lastSampleHeight = 0;
  private readonly _palette: RampPalette;
  private _lastRange: RampRange = { minH: 0, maxH: 0 };

  private readonly opts: PreviewScratchOptions;
  constructor(opts: PreviewScratchOptions) {
    this.opts = opts;
    this.gridN = Math.max(2, Math.floor(opts.gridN));
    this.worldMeters = opts.worldMeters;
    const count = this.gridN * this.gridN;
    this._positions = new Float32Array(count * 3);
    this._colors = new Float32Array(count * 3);
    this._heights = new Float64Array(count);
    // Convert sRGB hex stops → linear RGB once (three out of the helper).
    this._palette = { stops: srgbStopsToLinear(opts.srgbStops ?? DEFAULT_RAMP_SRGB) };
    // Seed the XZ lattice once; height updates only rewrite Y.
    const n = this.gridN;
    for (let iz = 0; iz < n; iz++) {
      const z = (iz / (n - 1) - 0.5) * this.worldMeters;
      for (let ix = 0; ix < n; ix++) {
        const x = (ix / (n - 1) - 0.5) * this.worldMeters;
        const vi = iz * n + ix;
        this._positions[vi * 3] = x;
        this._positions[vi * 3 + 2] = z;
      }
    }
  }

  get isVisible(): boolean {
    return this._visible && !this._disposed;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  /** Most recent accepted preview's mean height — the IEP-AC-05 telemetry scalar. */
  get sampleHeight(): number {
    return this._lastSampleHeight;
  }

  /** True once dispose() has run; late regen completions must no-op against this. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** Enter preview mode: mark present and (when a scene exists) build + attach. */
  present(): void {
    if (this._disposed) return;
    this._visible = true;
    if (this.opts.scene && !this._mesh) {
      this._buildThreeNode();
      this.opts.scene.add(this._mesh!);
    }
  }

  /** Write a fresh height field into the scratch buffer + GPU attribute. */
  update(heights: Float64Array): void {
    if (this._disposed || !this._visible) return;
    const n = this.gridN;
    const count = n * n;
    const copy = Math.min(count, heights.length);
    let sum = 0;
    for (let i = 0; i < copy; i++) {
      const h = heights[i];
      this._heights[i] = h;
      this._positions[i * 3 + 1] = h;
      sum += h;
    }
    this._lastSampleHeight = copy > 0 ? sum / copy : 0;
    // Height→color ramp (spec §5.2): runs regardless of _geometry so headless
    // CI can sample colors. In-place into _colors (shared with the GPU attr).
    this._lastRange = applyHeightRamp(this._heights, copy, this._colors, this._palette);
    this._dirty = true;
    if (this._geometry) {
      const attr = this._geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (attr) {
        (attr.array as Float32Array).set(this._positions);
        attr.needsUpdate = true;
      }
      const colAttr = this._geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (colAttr) {
        // _colors IS colAttr.array (shared buffer) — just flag it for upload.
        colAttr.needsUpdate = true;
      }
      this._geometry.computeBoundingSphere();
    }
  }

  clearDirty(): void {
    this._dirty = false;
  }

  /**
   * Internal color summary backing the seam probe's colorStats (spec §5.3).
   * Lives on the impl only, NOT on the PreviewScratchMesh public interface, and
   * the seam that exposes it stays non-enumerable (IEP-AC-08). Headless-safe:
   * reads the CPU buffers, never `_geometry`.
   *
   * distinctColors: count of 8-bit-quantized unique RGB triples (quantizer
   * documented in the test; chosen so float jitter can't undercount a real
   * ramp while a flat fill collapses to 1). colorVariance: variance of the
   * Rec.709 luminance proxy across vertices.
   */
  previewColorStats(): {
    minH: number;
    maxH: number;
    distinctColors: number;
    colorVariance: number;
  } {
    const count = this.gridN * this.gridN;
    const seen = new Set<number>();
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const r = this._colors[i * 3];
      const g = this._colors[i * 3 + 1];
      const b = this._colors[i * 3 + 2];
      // Quantize linear RGB to 8 bits per channel; pack into one int key.
      const qr = Math.round(clamp01(r) * 255);
      const qg = Math.round(clamp01(g) * 255);
      const qb = Math.round(clamp01(b) * 255);
      seen.add((qr << 16) | (qg << 8) | qb);
      // Rec.709 luminance proxy for variance.
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
    const mean = n > 0 ? sum / n : 0;
    const colorVariance = n > 0 ? Math.max(0, sumSq / n - mean * mean) : 0;
    return {
      minH: this._lastRange.minH,
      maxH: this._lastRange.maxH,
      distinctColors: seen.size,
      colorVariance,
    };
  }

  /**
   * Remove from the scene graph, free GPU buffers, drop references.
   * Idempotent; safe to call on commit, cancel, abandon, or unmount.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._visible = false;
    if (this._mesh && this.opts.scene) {
      this.opts.scene.remove(this._mesh);
    }
    this._geometry?.dispose();
    this._material?.dispose();
    this._geometry = null;
    this._material = null;
    this._mesh = null;
  }

  /** Internal: build a stripped unlit vertex-colored mesh over the XZ lattice. */
  private _buildThreeNode(): void {
    const n = this.gridN;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this._positions.slice(), 3));
    // Color attribute shares the _colors buffer (no per-frame realloc, spec §11);
    // update() flags needsUpdate after rewriting _colors in place.
    geometry.setAttribute("color", new THREE.BufferAttribute(this._colors, 3));
    // Grid topology indices (two triangles per cell), built once.
    const indices: number[] = [];
    for (let iz = 0; iz < n - 1; iz++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const a = iz * n + ix;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    // Unlit scratch material, now vertex-colored (no flat gray). Still no
    // lighting/splat/triplanar/water — materials.ts stays untouched.
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "preview-scratch";
    mesh.userData.isPreview = true;
    this._geometry = geometry;
    this._material = material;
    this._mesh = mesh;
  }
}

/** Convert three sRGB hex stops to a 9-value linear-RGB ramp (three out of the helper). */
function srgbStopsToLinear(
  hex: readonly [number, number, number],
): [number, number, number, number, number, number, number, number, number] {
  const out: number[] = [];
  for (const h of hex) {
    const c = new THREE.Color(h);
    c.convertSRGBToLinear();
    out.push(c.r, c.g, c.b);
  }
  return out as [
    number, number, number,
    number, number, number,
    number, number, number,
  ];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
