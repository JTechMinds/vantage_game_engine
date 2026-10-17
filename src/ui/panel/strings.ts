/**
 * Reusable panel UI strings — centralized for future i18n.
 * No layer-specific strings here; panel definitions supply their own labels.
 */

export const PANEL_STRINGS = {
  randomize: 'Randomize',
  reset: 'Reset',
  save: 'Save',
  load: 'Load',
  wireframe: 'Wireframe',
  generating: 'Generating…',
  saveAs: 'Save As',
  saveNamePlaceholder: 'Configuration name',
  saveConfirm: 'Confirm',
  cancel: 'Cancel',
  loadTitle: 'Load Configuration',
  loadEmpty: 'No saved configurations.',
  invalidConfig: 'Invalid configuration',
  saveFailed: 'Save failed',
  storageFull: 'Save failed: storage full',
  // IEP Phase-1 (spec 2C): edit-commit in-progress indicator copy.
  rebuilding: 'Rebuilding\u2026',
  rebuildingLong: 'Rebuilding\u2026 (this may take a moment)',
  cancelEdit: 'Cancel',
  // IEP Phase-3 (spec 2B / 2D): staged-edit batch controls + dirty marker.
  // Behavior is locked; exact look/placement is pending §9-Q5 sign-off, so
  // these are plain copy the shell renders into swappable DOM.
  unappliedChanges: 'Unapplied changes',
  okApply: 'Generate new scene',
  okApplyTitle: 'Apply all staged changes',
  cancelBatchTitle: 'Discard staged changes',
  // IEP Usability F2/F3: banner region label + generation overlay copy. The
  // relabel is user-facing ONLY — the action is still exactly one committed
  // rebuild (OK) / zero rebuild (Cancel); the tooltips keep saying so.
  bannerRegionLabel: 'Staged edit actions',
  generatingNewScene: 'Generating new scene…',
  invalidParam: 'invalid parameter',
  invalidParams: 'invalid parameters',
  telemetryPrefix: 'Telemetry',
} as const;

export type PanelStringKey = keyof typeof PANEL_STRINGS;
