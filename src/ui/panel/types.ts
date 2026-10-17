/**
 * Reusable layer-editor panel — public type contract.
 *
 * This module is framework-generic and layer-agnostic. It must never import
 * from any layer implementation (terrain, layer2, engine internals). Concrete
 * panels import THESE types and supply a `PanelDef` + `ApiBinding`.
 */

export type ControlType = 'slider' | 'number' | 'select' | 'toggle' | 'button' | 'text';

export type ActionId = 'randomize' | 'reset' | 'save' | 'load' | 'wireframe';

export type PanelMode = 'inline' | 'modal';

export interface SectionDef {
  id: string;
  label: string;
}

export interface ControlOption {
  value: string | number;
  label: string;
}

export type VisibilityPredicate = (params: Record<string, unknown>) => boolean;

export interface ControlDef {
  key: string;
  label: string;
  type: ControlType;
  section: string;
  order: number;
  tooltip?: string;
  /** Numeric constraints (slider, number): */
  min?: number;
  max?: number;
  step?: number;
  default?: number | string;
  /** Select: */
  options?: ControlOption[];
  /** Toggle: */
  defaultBool?: boolean;
  /** Display: */
  unit?: string;
  disabled?: boolean | VisibilityPredicate;
  visible?: boolean | VisibilityPredicate;
  /**
   * If true, changes to this control trigger geometry regeneration on the
   * bound API. The binding debounces these keys during drag; shader-only
   * keys (default) update immediately. Default: false.
   */
  regenerates?: boolean;
}

export interface ValidationError {
  key: string;
  message: string;
  code: 'out-of-range' | 'invalid-type' | 'invalid-enum' | 'unknown-field' | 'custom';
}

/**
 * The only contract the panel shell knows about its backing engine layer.
 * The binding layer is the sole code that maps this interface to concrete
 * API method names. The shell never sees terrain/renderer internals.
 */
export interface ApiBinding {
  getParams(): Record<string, unknown>;
  setParams(patch: Record<string, unknown>): void;
  validate(params?: Record<string, unknown>): ValidationError[];
  generate(): void;
  randomize(): void;
  reset(): void;
  serialize(): string;
  deserialize(json: string): void;
  setWireframe(on: boolean): void;
  on(event: string, handler: (payload: unknown) => void): () => void;
  telemetry(): Telemetry;
}

export interface Telemetry {
  generationTimeMs: number;
  triangleCount: number;
  textureCount: number;
}

export interface StorageAdapter {
  save(name: string, json: string): Promise<void>;
  load(name: string): Promise<string>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export interface PanelDef {
  title: string;
  sections: SectionDef[];
  controls: ControlDef[];
  /** Standard actions to render in the action bar. */
  actions: ActionId[];
  /** API binding that connects controls/actions to the engine layer. */
  binding: ApiBinding;
  /** Optional storage adapter enabling save/load. */
  storage?: StorageAdapter;
  /** Rendering mode. Default: inline. */
  mode?: PanelMode;
  /**
   * IEP Phase-2 (spec 4.4): optional non-enumerable engine preview seam
   * the shell forwards to the binding controller so a regenerates-control drag
   * drives a live preview. Structural type (no engine import); the concrete
   * seam rides the renderer devOnly hook. Optional: appearance-only panels
   * and existing callers are unchanged.
   */
  previewSeam?: {
    begin(): void;
    setLiveValue(patch: Record<string, unknown>): void;
    endCommit(): void;
    cancel(): void;
    dispose(): void;
  };
  /**
   * IEP Usability F1: optional committed-terrain visibility handle wired at the
   * composition site to the renderer's non-enumerable devOnly setCommittedVisible
   * hook (debugHideSky family — NOT a preview-seam method, NOT public). The
   * binding controller drives it at the same lifecycle points as the preview
   * seam so the committed group is hidden while a staged-edit preview is the
   * on-screen terrain. Structural type (no engine import). Optional: appearance-
   * only panels and existing callers are unchanged (visibility never toggles).
   */
  committedVisibility?: { set(on: boolean): void };
}

export interface PanelMountOptions {
  /** Container element to render into. */
  container: HTMLElement;
  /** CSS class prefix for styling hooks. */
  className?: string;
  /**
   * IEP Usability F2: optional element at the TOP of the scene viewport where
   * the OK/Cancel banner renders instead of the in-panel row. Additive and
   * optional: when absent, controls render in-panel exactly as at baseline
   * (no regression for appearance-only panels, mini-inline, existing AC tests).
   */
  bannerContainer?: HTMLElement;
}

export interface PanelHandle {
  /** Re-reads params from the binding and refreshes all controls. */
  refresh(): void;
  /** Removes DOM, tears down event subscriptions. Idempotent. */
  unmount(): void;
  /** The panel's root element (for tests / external focus management). */
  readonly root: HTMLElement;
}
