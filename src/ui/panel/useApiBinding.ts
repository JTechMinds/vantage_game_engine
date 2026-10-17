/**
 * API binding logic for the reusable panel.
 *
 * Owns the interaction between control edits and the bound ApiBinding. This is
 * the SINGLE owner of when a geometry-regenerating patch is applied to the
 * engine (IEP Phase-1/2/3, spec-interactive-edit-preview-phase*.md).
 *
 * Phase-3 (spec-interactive-edit-preview-phase3.md) makes this the staged-edit
 * owner. A regenerates:true control drag no longer commits on release; it
 * STAGES the final value into a diff-normalized pendingPatch accumulated over
 * the last-committed params. The user then applies the WHOLE batch atomically
 * via ok() (ONE setParams -> ONE committed rebuild regardless of how many
 * controls moved) or throws it all away via cancelBatch() (ZERO rebuild).
 * Fully-manual: nothing auto-commits on an idle clock (D14).
 *
 * The dirty signal is DERIVED from the diff (Object.keys(pendingPatch).length),
 * never a parallel boolean, so the 'Unapplied changes' marker cannot lie (§2D).
 *
 * Appearance-only controls (regenerates !== true) apply immediately on every
 * event, exactly as before — no regression.
 *
 * The binding never holds terrain/renderer internals - only the ApiBinding
 * interface from ./types.ts.
 */

import type { ApiBinding, ControlDef, ValidationError } from "./types.ts";

/**
 * Idle-timeout that closes a keyboard edit intent (spec §2A.4 / §7.3 engineer
 * judgment). Comfortably above human key-repeat, well below the ~448ms commit
 * cost so a nudged slider still STAGES promptly without a pointer release.
 * Exported so tests can drive it deterministically.
 *
 * NOTE (Phase 3): the idle timeout now closes the DRAG INTENT (stage), NOT a
 * commit. It never calls setParams (D14 fully-manual).
 */
export const IDLE_COMMIT_MS = 300;
export const MIN_OVERLAY_DWELL_MS = 400; // IEP-AC-09: min painted dwell for the Generating overlay (planner floor 300-500ms; engineer judgment).

/**
 * The panel edit-intent lifecycle states (spec §5.1). Phase 3 inserts
 * `staged` between `dragging` and `committing`: a released net-change edit
 * parks here (preview still visible, marker raised) until OK or Cancel.
 */
export type EditorState = "committed" | "dragging" | "staged" | "committing";

/**
 * IEP Phase-2 (spec 4.4): the non-enumerable engine preview seam the
 * controller drives during a regenerates-control drag (devOnly, invisible to
 * Object.keys, no new event). Its methods NEVER call setParams and NEVER move
 * commit/camera counters; the commit itself still runs through the public
 * setParams in applyPatch. Optional so appearance-only flows are unchanged.
 *
 * Phase 3 reuses the SAME five methods unchanged — only the PATCH it passes to
 * setLiveValue widens to the combined committed+pending effectivePatch, and the
 * timing of endCommit/cancel moves to OK/Cancel (spec §4.4). No seam widening.
 */
export interface PreviewSeam {
  begin(): void;
  setLiveValue(patch: Record<string, unknown>): void;
  endCommit(): void;
  cancel(): void;
  dispose(): void;
}

/**
 * IEP Usability F1: committed-terrain visibility handle (renderer devOnly
 * setCommittedVisible, debugHideSky family). Structural type (no engine
 * import); the composition site wires it to the renderer hook. Optional:
 * appearance-only panels omit it and committed visibility never toggles.
 */
export interface CommittedVisibility {
  set(on: boolean): void;
}

export interface BindingCallbacks {
  /** Update the control's displayed value (used for revert + refresh). */
  setValue: (key: string, value: unknown) => void;
  /** Show/clear an inline error under a control. */
  setError: (key: string, error: ValidationError | null) => void;
  /** Update the status-bar validation summary. */
  setValidationSummary: (errors: ValidationError[]) => void;
  /**
   * Fires on every editor-state transition. The PanelShell observes this to
   * render the Rebuilding indicator and the transient Cancel control. Optional
   * so existing callers (and appearance-only flows) keep working unchanged.
   */
  onEditorStateChange?: (state: EditorState) => void;
  /**
   * Phase 3 (spec §2D): fires whenever the staged-vs-committed diff changes
   * (stage / de-stage / OK / Cancel). The shell derives the 'Unapplied changes'
   * marker from isDirty() — this hook only tells it WHEN to re-read. Optional.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * IEP Usability F3: fires when the generation overlay should be shown (true)
   * or hidden (false). Mounted synchronously with the OK decision (F3 spec 2E
   * no-gap), unmounted at generation-complete / revert / dispose. Optional;
   * panels without F3 omit it.
   */
  onGenerationOverlayChange?: (visible: boolean) => void;
}

export interface ApiBindingController {
  /** Called when a control emits a change (live / intent-end / immediate). */
  patch: (
    key: string,
    value: unknown,
    opts?: { immediate?: boolean; phase?: "start" | "live" | "end" },
  ) => void;
  /** Re-read params from the API and push values into all controls. */
  refresh: () => void;
  /** Current authoritative param values (never the un-committed live value). */
  getParams: () => Record<string, unknown>;
  /** Last error per control key (for tests / status summary). */
  getErrors: () => ReadonlyMap<string, ValidationError>;
  /**
   * Release / external flush of an active dragging intent: STAGES the intent
   * (Phase 3). Does NOT commit. (Renamed semantics; name kept for callers.)
   */
  flush: () => void;
  /**
   * Zero-rebuild Cancel. During Dragging it reverts the active control; during
   * Staged it discards the WHOLE batch (cancelBatch); during Committing it is
   * the honest revert-during-OK-in-flight path (IEP-AC-04b).
   */
  cancel: () => void;
  /** Current editor-intent state (spec §5.1 state machine). */
  getState: () => EditorState;
  /**
   * Phase 3 (D10 / headline): apply the entire staged batch in ONE setParams
   * -> exactly ONE committed rebuild. No-op on an empty batch.
   */
  ok: () => void;
  /**
   * Phase 3 (D11): discard the whole staged batch — revert every staged slider
   * display to last-committed, dispose the scratch, ZERO committed rebuild.
   */
  cancelBatch: () => void;
  /**
   * Phase 3 (D12): the dirty signal is the diff, not a flag — true iff the
   * staged-vs-committed diff is non-empty. Never a parallel boolean.
   */
  isDirty: () => boolean;
  /** Keys currently staged (diff non-empty). For tests / marker inspection. */
  getPendingKeys: () => string[];
  /**
   * Called by the shell when the engine reports generation-started. Marks the
   * Committing window event-driven (async-capable engines keep it open).
   */
  notifyGenerationStarted: () => void;
  /**
   * Called by the shell when the engine reports generation-complete. Closes a
   * Committing window (the async/future case) and returns to Committed.
   */
  notifyGenerationComplete: () => void;
  /** Cancel pending timers (called on unmount). */
  dispose: () => void;
}

export function createApiBindingController(
  binding: ApiBinding,
  controls: ControlDef[],
  callbacks: BindingCallbacks,
  preview?: PreviewSeam,
  committedVisibility?: CommittedVisibility,
): ApiBindingController {
  const errors = new Map<string, ValidationError>();
  const controlByKey = new Map(controls.map((c) => [c.key, c]));
  let disposed = false;

  // --- Intent state machine (spec §5.1) ---------------------------------
  let state: EditorState = "committed";
  let activeKey: string | null = null;
  let pendingValue: unknown = undefined;
  let committedSnapshot: unknown = undefined;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Set true when the engine emits generation-started for the in-flight commit.
  // Distinguishes an event-emitting engine (sync or async) from a bare binding
  // that emits no events, so the Committing window auto-closes only for the
  // latter and stays open for an async engine until generation-complete lands.
  let generationInFlight = false;
  let overlayMountedAt = 0;
  let overlayDwellTimer = null as ReturnType<typeof setTimeout> | null;
  const hasRaf = (): boolean => typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function";
  function hideOverlayNow(): void { clearOverlayDwell(); callbacks.onGenerationOverlayChange?.(false); }
  function requestOverlayHide(): void {
    clearOverlayDwell();
    if (!hasRaf()) { hideOverlayNow(); return; }
    const remaining = MIN_OVERLAY_DWELL_MS - (Date.now() - overlayMountedAt);
    if (remaining <= 0) { hideOverlayNow(); return; }
    overlayDwellTimer = setTimeout(() => { overlayDwellTimer = null; callbacks.onGenerationOverlayChange?.(false); }, remaining);
  }
  function clearOverlayDwell(): void { if (overlayDwellTimer !== null) { clearTimeout(overlayDwellTimer); overlayDwellTimer = null; } }

  // --- Phase 3 staged-edit state (spec §2A / D9) ------------------------
  // The single staged batch: field -> staged value, accumulated over the
  // last-committed params. DIFF-NORMALIZED (§2A): a key equal to its committed
  // value is REMOVED, so staging a no-op or reverting-to-committed can never
  // raise the marker. This object IS the dirty state; there is no flag.
  const pendingPatch: Record<string, unknown> = {};
  // Snapshot of the committed values of the keys captured at the moment OK
  // commits, so a Cancel inside the Committing window can honestly revert to
  // pre-batch (IEP-AC-04b, extended to the multi-param batch). Empty otherwise.
  let commitRevert: Record<string, unknown> = {};

  function dirtySize(): number {
    return Object.keys(pendingPatch).length;
  }

  function isDirty(): boolean {
    return dirtySize() > 0;
  }

  /**
   * Set or remove a staged field, diff-normalized against the committed value.
   * Returns whether the dirty state CHANGED (so callers can fire onDirtyChange
   * once). Setting a value equal to committed removes the key (§2A).
   */
  function setPending(key: string, value: unknown): boolean {
    const committed = binding.getParams()[key];
    const before = isDirty();
    if (value === committed) {
      delete pendingPatch[key];
    } else {
      pendingPatch[key] = value;
    }
    return isDirty() !== before;
  }

  function notifyDirtyIfChanged(changed: boolean): void {
    if (changed) callbacks.onDirtyChange?.(isDirty());
  }

  /**
   * The patch passed to preview.setLiveValue: the WHOLE staged batch merged
   * with the live field being dragged (§2A / §4.1). The renderer merges this
   * over committed, so the scratch shows committed + pending(all staged) + live.
   */
  function effectivePatch(liveKey: string, liveValue: unknown): Record<string, unknown> {
    return { ...pendingPatch, [liveKey]: liveValue };
  }

  function setState(next: EditorState): void {
    if (state === next) return;
    state = next;
    callbacks.onEditorStateChange?.(next);
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Keyboard-sequence-end (or a pointer release that never fired `change`).
      // Phase 3: this STAGES the intent; it never commits (D14 fully-manual).
      if (activeKey !== null) stageIntent(activeKey, pendingValue);
    }, IDLE_COMMIT_MS);
  }

  function applyPatch(patch: Record<string, unknown>): void {
    // Validate first: some bindings (M-T1) silently ignore invalid patches
    // and only emit an error event, so validate() is the reliable gate.
    let issues: ValidationError[] = [];
    try {
      issues = binding.validate(patch);
    } catch (e) {
      issues = [
        {
          key: Object.keys(patch)[0] ?? "",
          message: e instanceof Error ? e.message : String(e),
          code: "custom",
        },
      ];
    }
    if (issues.length > 0) {
      reportErrors(issues, patch);
      return;
    }
    try {
      binding.setParams(patch);
    } catch (e) {
      reportErrors(
        [
          {
            key: Object.keys(patch)[0] ?? "",
            message: e instanceof Error ? e.message : String(e),
            code: "custom",
          },
        ],
        patch,
      );
      return;
    }
    clearErrorsFor(patch);
    // Refresh from authoritative state so external listeners agree.
    readAndPush();
  }

  function reportErrors(list: ValidationError[], patch: Record<string, unknown>): void {
    for (const issue of list) {
      errors.set(issue.key, issue);
      callbacks.setError(issue.key, issue);
    }
    callbacks.setValidationSummary([...errors.values()]);
    // Revert affected controls to authoritative values.
    const authoritative = binding.getParams();
    for (const issue of list) {
      if (issue.key in patch) {
        callbacks.setValue(issue.key, authoritative[issue.key]);
      }
    }
    // A failed validation attempt ends the intent with no generation started.
    if (state !== "committed") {
      clearIdleTimer();
      activeKey = null;
      committedSnapshot = undefined;
      commitRevert = {};
      setState("committed");
    }
  }

  function clearErrorsFor(patch: Record<string, unknown>): void {
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (errors.delete(key)) {
        callbacks.setError(key, null);
        changed = true;
      }
    }
    if (changed) callbacks.setValidationSummary([...errors.values()]);
  }

  function readAndPush(): void {
    const params = binding.getParams();
    for (const c of controls) {
      // Do not clobber a staged slider display while a batch is open: push the
      // STAGED value (which the user is previewing), not the committed value.
      if (c.key in pendingPatch) {
        callbacks.setValue(c.key, pendingPatch[c.key]);
        continue;
      }
      if (c.key in params) callbacks.setValue(c.key, params[c.key]);
    }
  }

  /** First drag tick / first geometry keydown: snapshot committed, enter Dragging. */
  function beginIntent(key: string, liveValue: unknown): void {
    if (state === "committed") {
      committedSnapshot = binding.getParams()[key];
      activeKey = key;
      pendingValue = liveValue;
      // IEP Phase-2: construct the disposable scratch preview on intent start.
      preview?.begin();
      // IEP Usability F1: committed hidden while the preview is the terrain.
      committedVisibility?.set(false);
      setState("dragging");
      // Reflect the initial live value on the combined preview.
      preview?.setLiveValue(effectivePatch(key, liveValue));
      return;
    }
    // Re-entrant edit during Staged/Committing/Dragging: begin a fresh drag
    // intent. The scratch is recreated under begin() (never two); the in-flight
    // OK (if any) still lands its single commit; this edit stages independently
    // (spec §5.2 edge 7).
    liveUpdate(key, liveValue);
  }

  /** In-drag / in-keyboard update: record the live value only. No setParams. */
  function liveUpdate(key: string, liveValue: unknown): void {
    if (state === "committed") {
      beginIntent(key, liveValue);
      return;
    }
    // Leaving Staged back into Dragging for a fresh control edit; the batch
    // stays staged (pendingPatch untouched) so the marker keeps reading it.
    if (state === "staged") setState("dragging");
    activeKey = key;
    pendingValue = liveValue;
    // IEP Phase-3: reflect committed + the WHOLE pending batch + this live
    // field in the preview (combined effect, spec §2A). Coalesced by the seam.
    preview?.setLiveValue(effectivePatch(key, liveValue));
    armIdleTimer();
  }

  /**
   * Phase 3 intent-end (release / idle-timeout): STAGE the recorded value into
   * the batch — NO setParams, NO endCommit (the scratch stays visible showing
   * the settled committed+pending preview). This is the one edge re-anchored
   * from Phase 2 §2D (release no longer commits; OK commits).
   */
  function stageIntent(key: string, value: unknown): void {
    clearIdleTimer();
    activeKey = key;
    pendingValue = value;
    // Diff-normalize against committed (§2A): a value equal to committed
    // removes the key (no-op stage -> no marker).
    const changed = setPending(key, value);
    notifyDirtyIfChanged(changed);
    if (isDirty()) {
      setState("staged");
      // Scratch stays visible; no endCommit, no dispose.
    } else {
      // No net staged change -> drop the scratch, back to Committed.
      preview?.dispose();
      committedVisibility?.set(true);
      activeKey = null;
      committedSnapshot = undefined;
      setState("committed");
    }
  }

  /**
   * Phase 3 (D10 / HEADLINE): apply the whole staged batch in ONE setParams.
   * Runs in a single synchronous block so the marker clears in the SAME tick as
   * the commit signal fires (spec §2E — never both stale, never neither):
   *   1. preview.endCommit()  — dispose scratch (hard-swap).
   *   2. snapshot revert + clear pendingPatch — marker clears (diff empties).
   *   3. setParams(patchCopy)  — fires generation-started synchronously -> the
   *                              Rebuilding indicator covers the frame.
   * EXACTLY one committed rebuild per OK regardless of batch size (IEP-AC-10).
   * No-op on an empty batch (§2B).
   */
  function ok(): void {
    if (disposed) return;
    if (!isDirty()) {
      // Empty batch: no-op, zero rebuild, marker stays absent (§2B / edge 8).
      return;
    }
    const patchCopy = { ...pendingPatch };
    // Snapshot the CURRENT committed values of the batch keys so a Cancel inside
    // the Committing window can revert to pre-batch (IEP-AC-04b).
    const authoritative = binding.getParams();
    commitRevert = {};
    for (const k of Object.keys(patchCopy)) commitRevert[k] = authoritative[k];
    // 1. F3 (spec 2C): clear the diff (marker clears) and MOUNT THE OVERLAY in
    //    the SAME synchronous block (2E: exactly one stale signal across the OK
    //    window). F1: the scratch stays visible and committed stays hidden until
    //    the NEW committed frame exists at generation-complete (no-blank rule)
    //    — endCommit moved into finishCommit.
    for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    callbacks.onDirtyChange?.(false);
    clearOverlayDwell(); overlayMountedAt = Date.now(); callbacks.onGenerationOverlayChange?.(true);
    activeKey = null;
    committedSnapshot = undefined;
    generationInFlight = false;
    // Show the busy indicator synchronously BEFORE the build.
    setState("committing");
    // 2. Defer the ONE public commit one animation frame (F3) so the overlay
    //    gets a paint opportunity on the synchronous engine.
    scheduleCommit(() => {
      // F3 teardown guard: if the panel unmounted during the one-frame
      // deferred window (e.g. a preset switch right after OK), do NOT let the
      // commit land after dispose() — that would rebuild committed terrain on a
      // torn-down view. One public commit per OK holds only while the panel lives.
      if (disposed) return;
      // 3. ONE public commit carrying the entire batch (single rebuild).
      applyPatch(patchCopy);
      // A synchronous M-T1 engine emits generation-started then generation-
      // complete INSIDE applyPatch; the shell forwards them, so by this line
      // state is already committed. An async engine leaves state=committing
      // with generationInFlight=true and closes on the later generation-
      // complete. A bare test binding emits neither event, so generationInFlight
      // stays false and we close here so state never sticks at Committing.
      if (state === "committing" && !generationInFlight) finishCommit();
    });
  }

  /**
   * IEP Usability F3: run the deferred commit on the next animation frame when
   * a browser rAF exists; run it SYNCHRONOUSLY otherwise (node test env), so
   * the cert-guaranteed single-commit ordering is unchanged for existing tests.
   */
  function scheduleCommit(run: () => void): void {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown })
      .requestAnimationFrame;
    if (typeof raf === "function") raf(() => raf(run)); // IEP-AC-09: two rAFs guarantee the mounted overlay is PAINTED before the blocking commit (a single rAF runs before the first paint, so the overlay composited zero times on the sync engine).
    else run();
  }

  function finishCommit(): void {
    activeKey = null;
    committedSnapshot = undefined;
    commitRevert = {};
    // F1+F3 no-blank ordering: the new committed frame now exists (generation-
    // complete or the sync-close), so dispose the scratch, reveal committed,
    // then drop the F3 overlay. Never a frame with committed-hidden AND
    // scratch-disposed AND no overlay.
    preview?.endCommit();
    committedVisibility?.set(true);
    requestOverlayHide();
    setState("committed");
  }

  /**
   * Phase 3 (D11): discard the whole staged batch. preview.cancel() disposes the
   * scratch; pendingPatch empties (marker clears); every staged slider display
   * reverts to last-committed; ZERO setParams / committed rebuild (IEP-AC-11).
   */
  function cancelBatch(): void {
    if (disposed) return;
    clearIdleTimer();
    // Revert every staged slider display to its committed value BEFORE emptying
    // the diff, so callbacks.setValue reads the committed value we still hold.
    const authoritative = binding.getParams();
    for (const key of Object.keys(pendingPatch)) {
      if (key in authoritative) callbacks.setValue(key, authoritative[key]);
    }
    preview?.cancel(); // dispose scratch (previewRebuildCount unmoved on action)
    // F1: committed revealed immediately — no rebuild, frame is unchanged.
    committedVisibility?.set(true);
    for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    callbacks.onDirtyChange?.(false); // marker clears (diff empties)
    activeKey = null;
    committedSnapshot = undefined;
    pendingValue = undefined;
    setState("committed");
  }

  /**
   * Zero-rebuild Cancel dispatcher (spec §2B / §5.2 / Phase 3 §2C). Behavior
   * depends on the current state:
   *   - Dragging: pure UI revert of the active control, ZERO engine work.
   *   - Staged:   discard the WHOLE batch (cancelBatch), ZERO engine work.
   *   - Committing: honest revert-during-OK-in-flight (a SECOND setParams back
   *     to committed; the extra generation-complete is MEASURED, never hidden —
   *     IEP-AC-04b, extended to the multi-param batch).
   */
  function cancel(): void {
    if (disposed) return;
    clearIdleTimer();
    if (state === "dragging") {
      // Primary cancel: pure UI revert, ZERO engine work.
      preview?.cancel();
      if (activeKey !== null && committedSnapshot !== undefined) {
        callbacks.setValue(activeKey, committedSnapshot);
      }
      // A mid-drag cancel does NOT touch an already-staged batch from a prior
      // control; only the active un-staged control reverts.
      activeKey = null;
      committedSnapshot = undefined;
      if (isDirty()) {
        // Other fields remain staged -> return to Staged, keep the scratch.
        setState("staged");
      } else {
        // F1: scratch disposed and batch empty -> committed is the terrain again.
        committedVisibility?.set(true);
        setState("committed");
      }
      return;
    }
    if (state === "staged") {
      cancelBatch();
      return;
    }
    if (state === "committing") {
      // Committing window (OK-in-flight). For the current synchronous engine the
      // committed batch has already landed, so the honest zero-regret path is a
      // SECOND setParams reverting to the pre-batch committed values (spec §5.2 /
      // IEP-AC-04b). Async engines would abort instead; that path is additive.
      const revertPatch = { ...commitRevert };
      // F1+F3: close the overlay window honestly — reveal committed and dispose
      // the scratch before the measured revert commit (IEP-AC-04b).
      preview?.endCommit();
      committedVisibility?.set(true);
      hideOverlayNow();
      setState("committed");
      activeKey = null;
      committedSnapshot = undefined;
      commitRevert = {};
      if (Object.keys(revertPatch).length > 0) applyPatch(revertPatch);
      return;
    }
    // Committed: nothing to cancel.
  }

  function patch(
    key: string,
    value: unknown,
    opts?: { immediate?: boolean; phase?: "start" | "live" | "end" },
  ): void {
    if (disposed) return;
    const def = controlByKey.get(key);
    const regenerating = def?.regenerates === true;

    // Appearance-only controls: unchanged immediate behavior.
    if (!regenerating) {
      applyPatch({ [key]: value });
      return;
    }

    // Geometry-affecting control: staged edit (Phase 3).
    if (opts?.immediate) {
      // Native `change` / release path -> STAGE (no commit; OK commits).
      stageIntent(key, value);
      return;
    }
    if (opts?.phase === "start") {
      beginIntent(key, value);
      return;
    }
    if (opts?.phase === "live") {
      liveUpdate(key, value);
      return;
    }
    // No phase + not immediate (programmatic patch on a regenerates control):
    // STAGE it, consistent with the interactive release path. The caller applies
    // via ok() (or the shell's OK control). No silent auto-commit — that would
    // reintroduce a per-edit commit the staged model forbids.
    stageIntent(key, value);
  }

  function flush(): void {
    // External release/flush: force-STAGE an active dragging intent once.
    if (state === "dragging" && activeKey !== null) {
      stageIntent(activeKey, pendingValue);
    } else {
      clearIdleTimer();
    }
  }

  function notifyGenerationStarted(): void {
    // The engine has begun a generation for the in-flight commit. Marks the
    // window event-driven so ok() does not auto-close it.
    generationInFlight = true;
  }

  function notifyGenerationComplete(): void {
    generationInFlight = false;
    if (state === "committing") finishCommit();
  }

  function dispose(): void {
    disposed = true;
    clearIdleTimer();
    activeKey = null;
    committedSnapshot = undefined;
    commitRevert = {};
    // Phase 3: drop the staged batch and ensure no scratch preview leaks.
    for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    preview?.dispose();
    // F1/F3 edge 5: never leak a hidden-committed or overlay-stuck state past
    // unmount — the next mount starts from a committed, visible, overlay-free view.
    committedVisibility?.set(true);
    hideOverlayNow();
  }

  return {
    patch,
    refresh: readAndPush,
    getParams: () => binding.getParams(),
    getErrors: () => errors,
    flush,
    cancel,
    getState: () => state,
    ok,
    cancelBatch,
    isDirty,
    getPendingKeys: () => Object.keys(pendingPatch),
    notifyGenerationStarted,
    notifyGenerationComplete,
    dispose,
  };
}
