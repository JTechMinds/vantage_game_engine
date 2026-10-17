/**
 * fly-camera.ts — pure free-fly input model for the camera navigation overhaul
 * (spec-camera-navigation.md §4.1).
 *
 * Input→pose math ONLY: no DOM, no renderer import, no setCamera, no rAF,
 * no wall-clock, no Math.random. Imported ONLY by the demo shell and its test —
 * never by terrain-renderer.ts's factory — so the renderer's public/enumerable
 * surface and the closed method set stay byte-identical (COMPAT-2).
 *
 * Conventions (decided in spec §4.1/§5, do not rediscover):
 *  - Y-up, world meters. yaw unbounded; pitch clamped to ±pitchLimitRad.
 *  - yaw 0 = looking -Z; yaw increases counter-clockwise viewed from +Y, so a
 *    RIGHT drag (dx>0) DECREASES yaw (turns the camera right — spec §5.2).
 *  - pitch positive = looking up; a DOWN drag (dy>0) decreases pitch.
 *  - W follows the FULL view vector (fly-style, U-Q3): looking down + W descends.
 *  - A/D strafe on the world horizontal plane (cross(forward, world-up)).
 *  - Q/E move on the world-vertical axis regardless of pitch.
 *  - Composite direction is normalized so diagonals are not sqrt2 faster.
 *  - stepFly is linear in dtSeconds (frame-rate independent, spec §5.3).
 */

import type { CameraPose } from './types.ts';

/** Free-fly controller state. Yaw unbounded; pitch clamped. Y-up, meters. */
export interface FlyState {
  x: number;
  y: number;
  z: number;
  yaw: number;   // radians, unbounded
  pitch: number; // radians, clamped to ±FlyConfig.pitchLimitRad
}

/** One frame's held-key snapshot (edge-triggered key state collected by the shell). */
export interface FlyInput {
  forward: boolean; // W
  back: boolean;    // S
  left: boolean;    // A
  right: boolean;   // D
  up: boolean;      // Q
  down: boolean;    // E
  boost: boolean;   // Shift
}

/** Tunables (U-CAM-4). Sized to the 512 m world; @Jordan dials on the feel pass. */
export interface FlyConfig {
  moveSpeed: number;       // m/s at 1x (base)
  boostMultiplier: number; // x moveSpeed while Shift held
  lookSensitivity: number; // radians of rotation per pixel of drag
  pitchLimitRad: number;   // pitch clamp (radians), e.g. 89 deg
}

/** Unit view-direction vector from yaw/pitch. yaw 0 = looking -Z; pitch + = up. */
export function forwardFromYawPitch(
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/** Clamp pitch into [-limit, +limit]; pure; never flips. */
export function clampPitch(pitch: number, limitRad: number): number {
  const lim = Math.abs(limitRad);
  if (pitch > lim) return lim;
  if (pitch < -lim) return -lim;
  return pitch;
}

/**
 * Apply a pixel drag delta to yaw/pitch (spec §5.2 sign convention):
 * dx > 0 (drag right) turns the camera right; dy > 0 (drag down) pitches down.
 * Pitch is clamped after each delta; yaw wraps freely. Returns new state.
 */
export function applyLook(
  state: FlyState,
  dxPixels: number,
  dyPixels: number,
  cfg: FlyConfig,
): FlyState {
  return {
    ...state,
    yaw: state.yaw - dxPixels * cfg.lookSensitivity,
    pitch: clampPitch(state.pitch - dyPixels * cfg.lookSensitivity, cfg.pitchLimitRad),
  };
}

/** Invert forwardFromYawPitch: derive yaw/pitch from a unit view vector. */
export function yawPitchFromForward(f: { x: number; y: number; z: number }): { yaw: number; pitch: number } {
  const len = Math.hypot(f.x, f.y, f.z) || 1;
  const x = f.x / len;
  const y = f.y / len;
  const z = f.z / len;
  return {
    yaw: Math.atan2(-x, -z),
    pitch: clampPitch(Math.asin(Math.max(-1, Math.min(1, y))), Math.PI / 2),
  };
}

/** World up axis (Y-up convention of CameraPose). */
const WORLD_UP = { x: 0, y: 1, z: 0 };

/**
 * Integrate held keys for dtSeconds. Linear in dt (frame-rate independent,
 * spec §5.3). Composite direction normalized so W+D is not sqrt2 faster
 * (spec §5.4). Look axes untouched — movement never changes yaw/pitch.
 */
export function stepFly(
  state: FlyState,
  input: FlyInput,
  dtSeconds: number,
  cfg: FlyConfig,
): FlyState {
  const fwd = forwardFromYawPitch(state.yaw, state.pitch);
  // World-horizontal strafe axis: cross(forward, world-up). Pitch clamped to
  // <90deg keeps forward non-parallel to world-up, so this is always defined.
  let rx = fwd.y * WORLD_UP.z - fwd.z * WORLD_UP.y;
  let ry = fwd.z * WORLD_UP.x - fwd.x * WORLD_UP.z;
  let rz = fwd.x * WORLD_UP.y - fwd.y * WORLD_UP.x;
  const rlen = Math.hypot(rx, ry, rz);
  if (rlen > 0) {
    rx /= rlen;
    ry /= rlen;
    rz /= rlen;
  }

  const fSign = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  const sSign = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const vSign = (input.up ? 1 : 0) - (input.down ? 1 : 0);

  let dx = fwd.x * fSign + rx * sSign;
  let dy = fwd.y * fSign + ry * sSign + vSign;
  let dz = fwd.z * fSign + rz * sSign;

  const dlen = Math.hypot(dx, dy, dz);
  if (dlen === 0 || dtSeconds === 0) return { ...state };

  const speed = cfg.moveSpeed * (input.boost ? cfg.boostMultiplier : 1) * dtSeconds;
  const k = speed / dlen; // normalize composite, then scale by speed
  dx *= k;
  dy *= k;
  dz *= k;

  return {
    x: state.x + dx,
    y: state.y + dy,
    z: state.z + dz,
    yaw: state.yaw,
    pitch: state.pitch,
  };
}

/** Project state to the existing pose-only seam input. target = position + forward. */
export function poseFromFly(state: FlyState): CameraPose {
  const f = forwardFromYawPitch(state.yaw, state.pitch);
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    targetX: state.x + f.x,
    targetY: state.y + f.y,
    targetZ: state.z + f.z,
  };
}

/** World-scaled defaults for the 512 m world (spec §9 U-Q4 proposal). */
export const DEFAULT_FLY_CONFIG: FlyConfig = {
  moveSpeed: 40,
  boostMultiplier: 3,
  lookSensitivity: 0.0035,
  pitchLimitRad: (89 * Math.PI) / 180,
};
