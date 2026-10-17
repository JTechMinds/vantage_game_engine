/*
 * M-P0 LOD sweep test — task-contract pointer.
 *
 * The authoritative, CI-run test suite lives at
 * tests/layer1/renderer/lod-sweep.test.ts, which is the only location the
 * npm test glob (tests/layer1/**/*.test.ts) executes. This file is a
 * non-executable pointer to that single source of truth so the M-P0
 * work-contract path src/__tests__/lod-sweep.test.ts exists. It intentionally
 * registers no tests here to avoid double-registration.
 *
 * Coverage there: P-AC-05 determinism, baseline bracket (14k..640k),
 * postCull=false + drawn==built, allnear stride-1 tier, ungenerated guard,
 * P-AC-07 formatRenderStats drawn/built/culled copy, frozen public surface,
 * devOnly renderStats + lodSweep hooks.
 */
export {};
