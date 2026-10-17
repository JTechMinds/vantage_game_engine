/**
 * jsdom environment helper for UI tests.
 *
 * Installs a jsdom-backed DOM as process globals via defineProperty (some
 * globals like `navigator` are getter-only on the global object).
 */

import { JSDOM } from "jsdom";

export interface TestDom {
  window: JSDOM["window"];
  document: Document;
  cleanup(): void;
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

export function setupDom(): TestDom {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const w = dom.window as unknown as Record<string, unknown>;
  define("window", dom.window);
  define("document", dom.window.document);
  define("navigator", dom.window.navigator);
  define("localStorage", dom.window.localStorage);
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "KeyboardEvent", "MouseEvent", "Event"]) {
    define(name, w[name]);
  }
  define("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  return {
    window: dom.window,
    document: dom.window.document,
    cleanup(): void {
      dom.window.close();
    },
  };
}

/** Minimal in-memory StorageAdapter for save/load tests. */
export function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    async save(name: string, json: string): Promise<void> {
      store.set(name, json);
    },
    async load(name: string): Promise<string> {
      const v = store.get(name);
      if (v === undefined) throw new Error(`missing "${name}"`);
      return v;
    },
    async list(): Promise<string[]> {
      return [...store.keys()].sort();
    },
    async remove(name: string): Promise<void> {
      store.delete(name);
    },
  };
}

export function click(el: Element): void {
  el.dispatchEvent(new (globalThis as never as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
}

export function pressKey(el: Element, key: string): void {
  el.dispatchEvent(new (globalThis as never as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key, bubbles: true }));
}

export function fireChange(el: Element, type = "change"): void {
  el.dispatchEvent(new (globalThis as never as { Event: typeof Event }).Event(type, { bubbles: true }));
}
