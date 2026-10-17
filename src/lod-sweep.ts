/*
 * M-P0 LOD sweep — task-contract re-export shim.
 *
 * The authoritative implementation lives at
 * src/engine/layer1/renderer/lod-sweep.ts (spec-layer1-performance-mp0.md §4.2),
 * where its ./lod.ts and ./types.ts imports resolve and the npm test glob runs
 * its tests. This file re-exports that module so the M-P0 work-contract path
 * src/lod-sweep.ts exists and points at the single source of truth. No logic is
 * duplicated here.
 */
export * from './engine/layer1/renderer/lod-sweep.ts';
