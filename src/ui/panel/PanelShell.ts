/**
 * PanelShell — reusable layer-editor panel shell.
 *
 * Composes the structural layout (title, section groups, controls, action
 * bar, status bar) from a declarative PanelDef + ApiBinding. This module is
 * framework-generic and layer-agnostic: it MUST NOT import from any layer
 * implementation (terrain, layer2, engine internals). Concrete panels import
 * THIS module, never the reverse.
 *
 * Modes:
 *  - inline: renders into the container slot, no backdrop.
 *  - modal:  overlay + backdrop, focus trap, Escape closes (calls onClose).
 *
 * IEP Phase-1 (spec-interactive-edit-preview-phase1.md §4.3 / §5): the shell
 * observes the binding's edit-intent state machine to render the transient
 * Cancel control and the Rebuilding indicator, gives an in-progress edit
 * precedence over the modal Escape-close, and forwards generation-started /
 * generation-complete to the binding. The shell still drives the engine only
 * through the binding + event subscription (panel stays a pure consumer).
 *
 * IEP Phase-3 (spec-interactive-edit-preview-phase3.md §4.2): the shell renders
 * the diff-derived "Unapplied changes" marker (visible IFF the staged diff is
 * non-empty — never a parallel boolean, §2D), the staged-batch OK / Cancel
 * controls (OK → ok(), Cancel → cancel()), and the marker↔indicator handoff
 * across the OK window (§2E). Keyboard: Escape reverts the batch and Enter
 * applies it, both behind the SAME Phase-1 focus guard and inert on an empty
 * batch (§2F / D13).
 *
 * Lifecycle: mountPanel() subscribes to API events and returns a handle;
 * handle.unmount() tears down subscriptions, timers, and DOM (idempotent).
 */

import type {
  PanelDef,
  PanelHandle,
  PanelMountOptions,
  ValidationError,
} from "./types.ts";
import { renderControl, type ControlView } from "./ControlRenderer.ts";
import { renderActionButtons } from "./ActionButtons.ts";
import { renderStatusBar } from "./StatusBar.ts";
import { createApiBindingController, type EditorState } from "./useApiBinding.ts";
import { attachEventSubscription } from "./useEventSubscription.ts";
import { PANEL_STRINGS } from "./strings.ts";

/**
 * Long-operation escalation threshold (spec §2C.4 / §7.3 engineer judgment).
 * The known ~448ms synchronous build must NOT escalate; a genuinely slow
 * device or a forced-delay test harness SHOULD. Tunable here so tests can
 * assert against it.
 */
const LONG_OP_THRESHOLD_MS = 600;

export function mountPanel(def: PanelDef, options: PanelMountOptions): PanelHandle {
  const mode = def.mode ?? "inline";
  const views = new Map<string, ControlView>();

  // --- Root structure -----------------------------------------------------
  const root = document.createElement("section");
  root.className = ["panel-shell", `panel-shell--${mode}`, options.className ?? ""]
    .filter(Boolean)
    .join(" ");
  root.setAttribute("aria-label", def.title);

  const titleEl = document.createElement("h2");
  titleEl.className = "panel-shell__title";
  titleEl.textContent = def.title;
  root.appendChild(titleEl);

  // --- Dirty marker (diff-derived; §2D) -----------------------------------
  // Visible IFF the staged-vs-committed diff is non-empty. Reads the binding's
  // isDirty() (the diff), never a shell-held boolean, so it cannot lie.
  const dirtyMarker = document.createElement("span");
  dirtyMarker.className = "panel-shell__dirty";
  dirtyMarker.dataset.role = "unapplied-marker";
  dirtyMarker.setAttribute("role", "status");
  dirtyMarker.textContent = PANEL_STRINGS.unappliedChanges;
  dirtyMarker.hidden = true;
  // IEP Usability F2: placement is decided once the banner buttons exist —
  // viewport-top banner (when options.bannerContainer is supplied) or the
  // baseline in-panel row.

  const controlsArea = document.createElement("div");
  controlsArea.className = "panel-shell__controls";
  root.appendChild(controlsArea);

  // Forward references assigned below; the editor-state callback only runs at
  // interaction time (after mount), so these are initialized by then.
  let statusBar: ReturnType<typeof renderStatusBar>;
  let cancelBtn: HTMLButtonElement;
  let okBtn: HTMLButtonElement;
  let longOpTimer: ReturnType<typeof setTimeout> | null = null;
  let bannerEl: HTMLElement | null = null;

  function clearLongOpTimer(): void {
    if (longOpTimer !== null) {
      clearTimeout(longOpTimer);
      longOpTimer = null;
    }
  }

  // --- Binding controller (single staged-edit / commit owner) --------------
  const controller = createApiBindingController(def.binding, def.controls, {
    setValue: (key, value) => views.get(key)?.setValue(value),
    setError: (key, error) => views.get(key)?.setError(error),
    setValidationSummary: (errors) => statusBar.setValidationSummary(errors),
    onEditorStateChange: (state) => setEditorUi(state),
    onDirtyChange: () => setMarkerUi(),
    // IEP Usability F3: the binding drives the overlay lifecycle synchronously
    // with the OK decision; unmount happens at generation-complete / revert.
    onGenerationOverlayChange: (visible) => setOverlayUi(visible),
  }, def.previewSeam, def.committedVisibility);

  /**
   * Render the marker from the DIFF (controller.isDirty()). Called on every
   * dirty change and on every editor-state transition so the marker always
   * agrees with the staged batch (spec §2D — the diff IS the state).
   */
  function setMarkerUi(): void {
    const dirty = controller.isDirty();
    dirtyMarker.hidden = !dirty;
    root.dataset.dirty = dirty ? "true" : "false";
  }

  function setEditorUi(state: EditorState): void {
    // Cancel is present for the whole dragging ∪ staged ∪ committing window.
    const editing = state === "dragging" || state === "staged" || state === "committing";
    cancelBtn.hidden = !editing;
    // OK applies the staged batch: only meaningful while a batch is dirty.
    okBtn.hidden = !controller.isDirty();
    okBtn.disabled = !controller.isDirty();
    root.dataset.editState = state;
    // F2: the viewport-top banner is present for the whole edit window; the
    // marker/OK inside it keep their own (diff-derived) hidden rules.
    if (bannerEl) bannerEl.hidden = !editing;

    if (state === "committing") {
      // Busy indicator shown synchronously on the OK-commit decision, and the
      // long-op escalation armed (spec §2C.1/§2C.4). Because ok() clears the
      // diff BEFORE this state lands, the marker has already hidden — so the
      // indicator covers the frame with no both-stale overlap (§2E).
      statusBar.setRebuildState("busy");
      clearLongOpTimer();
      longOpTimer = setTimeout(() => {
        longOpTimer = null;
        statusBar.setRebuildState("long");
      }, LONG_OP_THRESHOLD_MS);
    } else {
      // Dragging / Staged show no indicator (no rebuild in flight); Committed
      // clears. The marker (not the indicator) carries the staged signal.
      clearLongOpTimer();
      statusBar.setRebuildState("idle");
    }
    // Keep the marker in lockstep with the diff across every transition.
    setMarkerUi();
  }

  // --- Sections + controls (sorted, visibility/disabled predicates) -------
  function applyDerivedState(): void {
    const params = def.binding.getParams();
    for (const c of def.controls) {
      const view = views.get(c.key);
      if (!view) continue;
      const visible = typeof c.visible === "function" ? c.visible(params) : c.visible !== false;
      view.setVisible(visible);
      const disabled = typeof c.disabled === "function" ? c.disabled(params) : c.disabled === true;
      view.setDisabled(disabled);
    }
  }

  for (const section of def.sections) {
    const group = document.createElement("fieldset");
    group.className = "panel-section";
    group.dataset.section = section.id;
    const legend = document.createElement("legend");
    legend.textContent = section.label;
    group.appendChild(legend);

    const sorted = def.controls
      .filter((c) => c.section === section.id)
      .sort((a, b) => a.order - b.order);

    for (const c of sorted) {
      const view = renderControl(c, (key, value, opts) => controller.patch(key, value, opts));
      views.set(c.key, view);
      group.appendChild(view.root);
    }
    controlsArea.appendChild(group);
  }

  // --- Action bar -----------------------------------------------------------
  const actions = renderActionButtons(def.actions, {
    randomize: () => def.binding.randomize(),
    reset: () => def.binding.reset(),
    save: async (name) => {
      const json = def.binding.serialize();
      await def.storage!.save(name, json);
      statusBar.setMessage(`${name} saved`);
    },
    load: async (name) => {
      const json = await def.storage!.load(name);
      def.binding.deserialize(json);
      statusBar.setMessage(`${name} loaded`);
    },
    wireframe: (on) => def.binding.setWireframe(on),
    onError: (msg) => statusBar.setMessage(msg),
    getWireframeState: () => def.binding.getParams()["wireframe"] === true,
  }, def.storage);
  root.appendChild(actions.root);

  // --- Batch action row: OK + Cancel (transient; visible during a staged/  --
  //     edit window). Behavior is locked (OK = apply whole batch in one
  //     commit; Cancel = discard batch, zero rebuild). Exact styling is pending
  //     §9-Q5 operator sign-off, so the DOM is intentionally minimal and
  //     swappable without touching the logic (which lives in the binding).
  okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "panel-shell__ok";
  okBtn.dataset.role = "ok-batch";
  okBtn.textContent = PANEL_STRINGS.okApply;
  okBtn.title = PANEL_STRINGS.okApplyTitle;
  okBtn.hidden = true;
  okBtn.disabled = true;
  okBtn.addEventListener("click", () => controller.ok());

  cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "panel-shell__cancel";
  cancelBtn.dataset.role = "cancel-edit";
  cancelBtn.textContent = PANEL_STRINGS.cancelEdit;
  cancelBtn.title = PANEL_STRINGS.cancelBatchTitle;
  cancelBtn.hidden = true;
  cancelBtn.addEventListener("click", () => controller.cancel());

  // --- F2: viewport-top banner (optional) ------------------------------------
  // When the composition site supplies bannerContainer (an element pinned to
  // the TOP of the scene viewport), the marker + OK + Cancel render there as a
  // prominent banner INSTEAD of the in-panel row. Behavior is identical (same
  // controller.isDirty() source, same ok()/cancel() wiring, same hidden rules);
  // this is a DOM move, not a behavior change. Absent container -> baseline.
  if (options.bannerContainer) {
    bannerEl = document.createElement("div");
    bannerEl.className = "panel-banner";
    bannerEl.setAttribute("role", "region");
    bannerEl.setAttribute("aria-label", PANEL_STRINGS.bannerRegionLabel);
    bannerEl.dataset.role = "edit-banner";
    bannerEl.hidden = true;
    bannerEl.appendChild(dirtyMarker);
    bannerEl.appendChild(okBtn);
    bannerEl.appendChild(cancelBtn);
    options.bannerContainer.appendChild(bannerEl);
    // The same Phase-1 focus guard applies while focus sits inside the banner
    // (it is panel-owned chrome living outside the panel root).
    bannerEl.addEventListener("keydown", onKeyDown);
  } else {
    root.insertBefore(dirtyMarker, controlsArea);
  }

  // --- Status bar -----------------------------------------------------------
  statusBar = renderStatusBar();
  root.appendChild(statusBar.root);
  // OK + Cancel sit next to the status surface so they are hit-testable during
  // the whole editing window (IEP-AC-09 / IEP-AC-11).
  // F2: when the viewport-top banner owns these controls they already live in
  // the banner DOM — appending them here would reparent them out of the banner.
  if (!bannerEl) {
    root.appendChild(okBtn);
    root.appendChild(cancelBtn);
  }
  statusBar.onValidationErrorClick = (key) => {
    const view = views.get(key);
    if (view) {
      view.root.scrollIntoView({ block: "nearest" });
      view.input.focus();
    }
  };

  // --- F3: generation overlay (modal, indeterminate) --------------------------
  // Mounted synchronously with the OK decision (so the marker->overlay handoff
  // has no gap, spec 2E) and unmounted at generation-complete. The one-frame
  // commit deferral in the binding gives the browser a paint opportunity; on a
  // fast synchronous build the paint may coalesce, so the falsifiable contract
  // is the DOM LIFECYCLE (data-gen-overlay), not a screenshot pixel. Never a
  // fabricated percentage — indeterminate spinner + elapsed timer only.
  let overlayEl: HTMLElement | null = null;
  let overlayTimer: ReturnType<typeof setInterval> | null = null;
  let overlayPrevFocus: Element | null = null;
  function onOverlayKeydown(e: KeyboardEvent): void {
    // Modal focus trap: Escape/Enter are swallowed while a non-cancellable
    // commit is in flight (spec 2C; the revert-during-commit path stays
    // reachable only via the forced-delay harness, IEP-AC-04b).
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  function setOverlayUi(visible: boolean): void {
    if (visible) {
      if (overlayEl) return;
      const t0 = Date.now();
      overlayPrevFocus = document.activeElement;
      overlayEl = document.createElement("div");
      overlayEl.className = "panel-gen-overlay";
      overlayEl.dataset.genOverlay = "active";
      overlayEl.setAttribute("role", "status");
      overlayEl.setAttribute("aria-live", "polite");
      overlayEl.setAttribute("tabindex", "-1");
      const spinner = document.createElement("span");
      spinner.className = "panel-gen-overlay__spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "panel-gen-overlay__label";
      label.textContent = PANEL_STRINGS.generatingNewScene;
      const elapsed = document.createElement("span");
      elapsed.className = "panel-gen-overlay__elapsed";
      elapsed.dataset.role = "gen-elapsed";
      elapsed.textContent = "0 ms";
      overlayEl.appendChild(spinner);
      overlayEl.appendChild(label);
      overlayEl.appendChild(elapsed);
      overlayEl.addEventListener("keydown", onOverlayKeydown);
      (options.bannerContainer ?? options.container).appendChild(overlayEl);
      overlayEl.focus();
      overlayTimer = setInterval(() => {
        if (overlayEl) elapsed.textContent = `${Date.now() - t0} ms`;
      }, 100);
    } else {
      if (!overlayEl) return;
      if (overlayTimer !== null) { clearInterval(overlayTimer); overlayTimer = null; }
      overlayEl.removeEventListener("keydown", onOverlayKeydown);
      overlayEl.remove();
      overlayEl = null;
      if (overlayPrevFocus instanceof HTMLElement) overlayPrevFocus.focus();
      overlayPrevFocus = null;
    }
  }

  // --- Initial population ---------------------------------------------------
  setEditorUi(controller.getState());
  controller.refresh();
  applyDerivedState();
  try {
    statusBar.setTelemetry(def.binding.telemetry());
  } catch {
    /* telemetry is informational only */
  }

  // --- Event subscription ---------------------------------------------------
  let generationTimer: ReturnType<typeof setTimeout> | null = null;
  const detachEvents = attachEventSubscription(def.binding, {
    onStateChanged: () => {
      controller.refresh();
      applyDerivedState();
      actions.setWireframeState(def.binding.getParams()["wireframe"] === true);
    },
    onGenerationStarted: () => {
      // Forward to the commit owner so it knows the window is event-driven
      // (async engines keep Committing open until complete lands).
      controller.notifyGenerationStarted();
      // Anti-flicker safety net for NON-edit generations (randomize/reset/
      // deserialize). During an edit commit the editor state machine already
      // shows the indicator synchronously, and generation-complete clears this
      // timer before it can fire — so it never fights the state machine (§2C.2).
      if (generationTimer) clearTimeout(generationTimer);
      generationTimer = setTimeout(() => statusBar.setGenerating(true), 100);
    },
    onGenerationComplete: () => {
      if (generationTimer) {
        clearTimeout(generationTimer);
        generationTimer = null;
      }
      // Closes the Committing window via the state machine (indicator clears on
      // the committed frame). setGenerating(false) is an idempotent safety-net
      // clear for non-edit generations.
      controller.notifyGenerationComplete();
      statusBar.setGenerating(false);
      try {
        statusBar.setTelemetry(def.binding.telemetry());
      } catch {
        /* informational */
      }
    },
    onError: (payload) => {
      const p = payload as { message?: string; field?: string } | null;
      if (p?.message) statusBar.setMessage(p.message);
      if (p?.field) {
        const view = views.get(p.field);
        if (view) view.setError({ key: p.field, message: p.message ?? "Invalid value", code: "invalid" });
      }
    },
  });

  // --- Mount into container + modal behaviors --------------------------------
  let backdrop: HTMLElement | null = null;
  let previousFocus: Element | null = null;

  if (mode === "modal") {
    backdrop = document.createElement("div");
    backdrop.className = "panel-shell__backdrop";
    backdrop.appendChild(root);
    options.container.appendChild(backdrop);
    previousFocus = document.activeElement;
    root.setAttribute("tabindex", "-1");
    root.focus();
    root.addEventListener("keydown", onModalKeydown);
  } else {
    options.container.appendChild(root);
  }

  // Unified keyboard handling for BOTH modes (spec §2F / D13): an active/staged
  // edit takes precedence over the modal close. Escape reverts the batch; Enter
  // applies it. Both handlers share the SAME containment (the panel root only
  // sees the key while focus is inside it), so a modal that owns focus keeps its
  // Escape-to-close and never sees the panel consume the key. With no staged
  // batch neither key is consumed beyond Phase-1 semantics.
  root.addEventListener("keydown", onKeyDown);

  function onKeyDown(e: KeyboardEvent): void {
    const state = controller.getState();
    const editing = state === "dragging" || state === "staged" || state === "committing";
    if (e.key === "Escape") {
      if (editing) {
        // Cancel the in-progress / staged edit; do NOT let it reach the close.
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        controller.cancel();
        return;
      }
      if (mode === "modal") {
        // No edit in progress: Escape retains the existing close behavior.
        e.stopPropagation();
        unmount();
        if (previousFocus instanceof HTMLElement) previousFocus.focus();
      }
      return;
    }
    if (e.key === "Enter") {
      // Enter == ok() ONLY while the panel holds focus AND a batch is staged;
      // inert on an empty batch (no consume, no rebuild) — same guard as Escape.
      if (editing && controller.isDirty()) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        controller.ok();
      }
    }
  }

  function onModalKeydown(e: KeyboardEvent): void {
    // Escape/Enter are owned by onKeyDown (with edit precedence) — not handled
    // here. This handler keeps the modal focus trap only.
    if (e.key === "Tab") {
      // Focus trap: cycle within the panel (dialogs included).
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  let unmounted = false;

  function unmount(): void {
    if (unmounted) return;
    unmounted = true;
    detachEvents();
    controller.dispose(); // also closes the F3 overlay + restores committed visibility
    if (bannerEl) {
      bannerEl.removeEventListener("keydown", onKeyDown);
      bannerEl.remove();
      bannerEl = null;
    }
    if (generationTimer) clearTimeout(generationTimer);
    clearLongOpTimer();
    if (mode === "modal") root.removeEventListener("keydown", onModalKeydown);
    root.removeEventListener("keydown", onKeyDown);
    (backdrop ?? root).remove();
  }

  return {
    refresh: () => {
      controller.refresh();
      applyDerivedState();
    },
    unmount,
    root,
  };
}
