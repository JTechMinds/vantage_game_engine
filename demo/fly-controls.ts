/**
 * fly-controls.ts — demo-shell input wiring for the free-fly camera
 * (spec-camera-navigation.md §4.2/§4.3).
 *
 * This is the ONLY place the fly gesture surface touches the DOM. It is a thin
 * event translator: pointer/keyboard events → FlyState/FlyInput mutations in
 * the PURE `fly-camera.ts` model, plus an `onPoseDirty` callback so the demo
 * shell keeps its coalescing flag (cameraDirty) and its single-setCamera rAF
 * tick (PA-1a-08 shape lives in terrain-demo.ts, untouched).
 *
 * Structural scoping (spec §4.3, plan §6 — binding):
 *  - Look `pointerdown`/`pointermove` are registered on the CANVAS only — never
 *    on document/window — so a pointerdown landing on the panel/banner is
 *    consumed by that UI and never arms the drag. Ownership is decided ONCE at
 *    pointerdown: a drag started in the viewport keeps rotating until
 *    `pointerup` even if the cursor crosses the panel mid-drag.
 *  - Key handling is registered on window (held-key state must survive the
 *    cursor leaving the canvas) but DEFERS — without `preventDefault` —
 *    whenever `uiOwnsFocus()` is true. The panel's own root keydown keeps
 *    owning Escape/Enter (IEP-AC-14); this is one shared focus notion, not a
 *    second guard that consumes keys.
 *
 * The module is instantiated by the demo shell AND by the FLY-AC-10 jsdom
 * negative-control test, so the production listener code is what the gates
 * actually exercise.
 */

import {
  DEFAULT_FLY_CONFIG,
  applyLook,
  stepFly,
  yawPitchFromForward,
  type FlyConfig,
  type FlyInput,
  type FlyState,
} from "../src/engine/layer1/renderer/fly-camera.ts";
import type { CameraPose } from "../src/engine/layer1/renderer/types.ts";

/** UI hosts whose focus means the viewport does NOT own the keyboard (§4.3). */
export const UI_HOST_IDS = ["panel-container", "edit-banner-host", "preset-bar", "preset-state"];

/** e.code → FlyInput field. Layout-agnostic (spec §4.2). */
const CODE_TO_ACTION: Record<string, keyof FlyInput> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  KeyQ: "up",
  KeyE: "down",
  ShiftLeft: "boost",
  ShiftRight: "boost",
};

export interface FlyControlsOptions {
  /** The 3D viewport element — the ONLY look-drag listener target. */
  canvas: HTMLCanvasElement;
  /** Called after any look/move mutation so the shell can flag cameraDirty. */
  onPoseDirty: () => void;
  /** Tunables; defaults to DEFAULT_FLY_CONFIG (U-Q4 feel-pass numbers). */
  config?: FlyConfig;
}

export interface FlyControls {
  /** Current controller state (copy). */
  getState(): FlyState;
  /** Replace state wholesale (boot pose, presets, #cam= hash path — COMPAT-4). */
  setState(next: FlyState): void;
  /** Current held-key snapshot (copy). */
  getInput(): FlyInput;
  /**
   * Advance held-key movement by dt seconds (pure stepFly). Returns true if a
   * move applied. The caller (demo tick) owns the dt clamp and the dirty flag.
   */
  advance(dtSeconds: number): boolean;
  /** Detach all listeners (teardown; not used by the demo page itself). */
  dispose(): void;
}

/** Derive a FlyState from an existing CameraPose (COMPAT-4 hash/preset path). */
export function flyStateFromPose(pose: CameraPose): FlyState {
  const f = {
    x: pose.targetX - pose.x,
    y: pose.targetY - pose.y,
    z: pose.targetZ - pose.z,
  };
  const { yaw, pitch } = yawPitchFromForward(f);
  return { x: pose.x, y: pose.y, z: pose.z, yaw, pitch };
}

/**
 * Read-only predicate: "is focus inside a UI host (panel/banner/preset bar)?"
 * Single source of truth shared with the camera controller (plan §5 — the
 * shared focus-guard invariant). It NEVER consumes keys; it only answers.
 */
export function makeUiOwnsFocus(canvas: HTMLCanvasElement): () => boolean {
  return function uiOwnsFocus(): boolean {
    const a = document.activeElement;
    if (!a || a === document.body || a === canvas) return false; // viewport owns
    return UI_HOST_IDS.some((id) => {
      const host = document.getElementById(id);
      return host ? host.contains(a) : false;
    });
  };
}

/** Build the fly input controller over the given canvas. */
export function createFlyControls(opts: FlyControlsOptions): FlyControls {
  const { canvas, onPoseDirty } = opts;
  const cfg: FlyConfig = opts.config ?? DEFAULT_FLY_CONFIG;
  const uiOwnsFocus = makeUiOwnsFocus(canvas);

  let state: FlyState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const input: FlyInput = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    boost: false,
  };

  /* ---------------- keyboard (window, gated by shared focus guard) ------- */

  function onKeyDown(e: KeyboardEvent): void {
    // Defer entirely when a UI host owns focus: no state change and no key
    // consumption, so the panel keeps Escape/Enter/typing (IEP-AC-14).
    if (uiOwnsFocus()) return;
    const action = CODE_TO_ACTION[e.code];
    if (!action) return;
    input[action] = true;
    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent): void {
    const action = CODE_TO_ACTION[e.code];
    if (!action) return;
    input[action] = false;
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  /* ---------------- look drag (canvas ONLY; ownership at pointerdown) ---- */

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e: PointerEvent): void {
    // Left button = look. A pointerdown landing on UI never reaches this
    // listener (canvas-scoped registration) — that is the structural scoping.
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / missing pointerId: capture is an optimization, not a gate */
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dx === 0 && dy === 0) return;
    state = applyLook(state, dx, dy, cfg);
    onPoseDirty();
  }

  // window pointerup (PA-1a-08 precedent): a drag authored in the viewport
  // keeps rotating until release even if the cursor crosses the panel mid-drag.
  function onPointerUp(): void {
    dragging = false;
  }

  canvas.addEventListener("pointerdown", onPointerDown as EventListener);
  canvas.addEventListener("pointermove", onPointerMove as EventListener);
  window.addEventListener("pointerup", onPointerUp);

  /* ---------------- API --------------------------------------------------- */

  return {
    getState: () => ({ ...state }),
    setState: (next: FlyState) => {
      state = { ...next };
      onPoseDirty();
    },
    getInput: () => ({ ...input }),
    advance(dtSeconds: number): boolean {
      if (dtSeconds <= 0) return false;
      if (
        !input.forward && !input.back && !input.left && !input.right &&
        !input.up && !input.down
      ) {
        return false;
      }
      state = stepFly(state, input, dtSeconds, cfg);
      return true;
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("pointerdown", onPointerDown as EventListener);
      canvas.removeEventListener("pointermove", onPointerMove as EventListener);
      window.removeEventListener("pointerup", onPointerUp);
    },
  };
}
