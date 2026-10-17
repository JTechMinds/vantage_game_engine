/**
 * TerrainStorageAdapter — localStorage-backed StorageAdapter for terrain
 * configs. Thin key-value wrapper over whatever serialize() returns; the UI
 * never reshapes the JSON (spec §8.3).
 *
 * Key prefix: `layer1:` (spec §7). The adapter is injected into the panel;
 * tests use an in-memory adapter instead.
 */

import type { StorageAdapter } from "../../panel/index.ts";

const PREFIX = "layer1:";

export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export function createTerrainStorageAdapter(storage?: WebStorage): StorageAdapter {
  const backend: WebStorage =
    storage ??
    (typeof localStorage !== "undefined" ? localStorage : (undefined as never));

  function requireBackend(): WebStorage {
    if (!backend) throw new Error("no storage backend available");
    return backend;
  }

  return {
    async save(name: string, json: string): Promise<void> {
      try {
        requireBackend().setItem(PREFIX + name, json);
      } catch (e) {
        // Quota errors (SecurityError/QuotaExceededError) surface to the UI.
        throw new Error(
          e instanceof Error ? e.message : "storage write failed",
        );
      }
    },

    async load(name: string): Promise<string> {
      const value = requireBackend().getItem(PREFIX + name);
      if (value === null) throw new Error(`no saved configuration "${name}"`);
      return value;
    },

    async list(): Promise<string[]> {
      if (!backend) return [];
      const names: string[] = [];
      for (let i = 0; i < backend.length; i++) {
        const key = backend.key(i);
        if (key && key.startsWith(PREFIX)) {
          names.push(key.slice(PREFIX.length));
        }
      }
      return names.sort();
    },

    async remove(name: string): Promise<void> {
      requireBackend().removeItem(PREFIX + name);
    },
  };
}
