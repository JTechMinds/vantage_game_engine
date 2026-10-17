/**
 * ActionButtons — standard action bar for layer panels.
 *
 * Renders the standard action set (randomize, reset, save, load, wireframe)
 * declared by a PanelDef. Buttons are plain DOM; behavior is delegated to
 * the ActionHandlers supplied by the panel shell, so this module stays
 * layer-agnostic. Save/load dialogs live here because they are part of the
 * standard action UX, but they call only the injected handlers.
 */

import type { ActionId, StorageAdapter } from "./types.ts";
import { PANEL_STRINGS } from "./strings.ts";

export interface ActionHandlers {
  randomize: () => void;
  reset: () => void;
  /** Returns the serialized string to store; storage errors surface via onError. */
  save: (name: string) => Promise<void>;
  /** Loads a saved name; errors surface via onError. */
  load: (name: string) => Promise<void>;
  wireframe: (on: boolean) => void;
  onError: (message: string) => void;
  /** Reflect authoritative wireframe state into the toggle (event-driven). */
  getWireframeState: () => boolean;
}

export interface ActionButtonsView {
  root: HTMLElement;
  /** Reflect authoritative wireframe state into the toggle. */
  setWireframeState: (on: boolean) => void;
}

const ACTION_LABELS: Record<ActionId, string> = {
  randomize: PANEL_STRINGS.randomize,
  reset: PANEL_STRINGS.reset,
  save: PANEL_STRINGS.save,
  load: PANEL_STRINGS.load,
  wireframe: PANEL_STRINGS.wireframe,
};

export function renderActionButtons(
  actions: ActionId[],
  handlers: ActionHandlers,
  storage: StorageAdapter | undefined,
): ActionButtonsView {
  const root = document.createElement("div");
  root.className = "panel-actions";
  root.setAttribute("role", "toolbar");

  let wireframeToggle: HTMLInputElement | null = null;

  for (const action of actions) {
    if (action === "wireframe") {
      const wrap = document.createElement("label");
      wrap.className = "panel-actions__toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = handlers.getWireframeState();
      cb.dataset.action = "wireframe";
      cb.setAttribute("aria-label", ACTION_LABELS.wireframe);
      cb.addEventListener("change", () => handlers.wireframe(cb.checked));
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(ACTION_LABELS.wireframe));
      root.appendChild(wrap);
      wireframeToggle = cb;
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "panel-actions__button";
    btn.textContent = ACTION_LABELS[action];
    btn.dataset.action = action;
    btn.setAttribute("aria-label", ACTION_LABELS[action]);

    if (action === "randomize") btn.addEventListener("click", () => handlers.randomize());
    else if (action === "reset") btn.addEventListener("click", () => handlers.reset());
    else if (action === "save") btn.addEventListener("click", () => openSaveDialog());
    else if (action === "load") btn.addEventListener("click", () => openLoadDialog());

    root.appendChild(btn);
  }

  function openSaveDialog(): void {
    if (!storage) {
      handlers.onError(`${PANEL_STRINGS.saveFailed}: no storage configured`);
      return;
    }
    const dialog = buildDialog(PANEL_STRINGS.saveAs);
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = PANEL_STRINGS.saveNamePlaceholder;
    nameInput.setAttribute("aria-label", PANEL_STRINGS.saveNamePlaceholder);
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = PANEL_STRINGS.saveConfirm;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = PANEL_STRINGS.cancel;
    confirm.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        await handlers.save(name);
        close();
      } catch (e) {
        handlers.onError(`${PANEL_STRINGS.saveFailed}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    cancel.addEventListener("click", close);
    dialog.body.appendChild(nameInput);
    dialog.footer.appendChild(confirm);
    dialog.footer.appendChild(cancel);
    nameInput.focus();

    function close(): void {
      dialog.root.remove();
    }
  }

  async function openLoadDialog(): Promise<void> {
    if (!storage) {
      handlers.onError(`${PANEL_STRINGS.invalidConfig}: no storage configured`);
      return;
    }
    const dialog = buildDialog(PANEL_STRINGS.loadTitle);
    const list = document.createElement("select");
    list.setAttribute("aria-label", PANEL_STRINGS.loadTitle);
    let names: string[] = [];
    try {
      names = await storage.list();
    } catch (e) {
      handlers.onError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (names.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = PANEL_STRINGS.loadEmpty;
      dialog.body.appendChild(empty);
    } else {
      for (const name of names) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name;
        list.appendChild(o);
      }
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.textContent = PANEL_STRINGS.load;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = PANEL_STRINGS.cancel;
      confirm.addEventListener("click", async () => {
        try {
          await handlers.load(list.value);
          close();
        } catch (e) {
          handlers.onError(`${PANEL_STRINGS.invalidConfig}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      cancel.addEventListener("click", close);
      dialog.body.appendChild(list);
      dialog.footer.appendChild(confirm);
      dialog.footer.appendChild(cancel);
      confirm.focus();
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = PANEL_STRINGS.cancel;
    closeBtn.addEventListener("click", close);
    if (dialog.footer.childNodes.length === 0) dialog.footer.appendChild(closeBtn);

    function close(): void {
      dialog.root.remove();
    }
  }

  function setWireframeState(on: boolean): void {
    if (wireframeToggle) wireframeToggle.checked = on;
  }

  return { root, setWireframeState };
}

/** Minimal modal dialog helper (focus + Escape handled by the shell's trap). */
function buildDialog(title: string) {
  const root = document.createElement("div");
  root.className = "panel-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", title);
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("div");
  const footer = document.createElement("div");
  footer.className = "panel-dialog__footer";
  root.appendChild(heading);
  root.appendChild(body);
  root.appendChild(footer);
  document.body.appendChild(root);
  root.dataset.panelDialog = "true";
  return { root, body, footer };
}
