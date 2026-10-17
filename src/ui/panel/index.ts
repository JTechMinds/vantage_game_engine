/**
 * Reusable layer-editor panel — public surface.
 *
 * Concrete layer panels (terrain, layer2, future layers) import ONLY from
 * this barrel. Internal helper modules are re-exported here as the single
 * public surface; anything not listed here is internal.
 *
 * This module must never import from any layer implementation.
 */

export { mountPanel } from "./PanelShell.ts";
export type {
  PanelDef,
  SectionDef,
  ControlDef,
  ControlType,
  ControlOption,
  ActionId,
  PanelMode,
  PanelMountOptions,
  PanelHandle,
  ApiBinding,
  StorageAdapter,
  Telemetry,
  ValidationError,
} from "./types.ts";
