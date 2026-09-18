import { APP_SCHEMA_VERSION, AppState } from "./types";

/**
 * A minimal key-value storage abstraction, deliberately NOT window.localStorage
 * directly - the facade/tests run under Node (no `window`), and the future
 * browser UI binds this same interface to `window.localStorage` (get/set/
 * remove map directly onto localStorage.getItem/setItem/removeItem; nothing
 * about this interface is browser-specific). Keeping this boundary explicit
 * is the "minimal engine/API change" this milestone's app layer needs - no
 * core engine file references storage at all.
 */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Used by every test in this milestone, and a safe default for any environment without persistent storage. */
export class InMemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export const APP_STATE_STORAGE_KEY = "mafiaPredictor.appState";
export const CURRENT_APP_VERSION = "0.1.0";

function emptyAppState(): AppState {
  return { schemaVersion: APP_SCHEMA_VERSION, appVersion: CURRENT_APP_VERSION, currentGame: null, history: [] };
}

/**
 * Every past schemaVersion's migration to the CURRENT one, keyed by the
 * version being migrated FROM. Deliberately a plain, tiny lookup table (not
 * a framework) per this milestone's explicit "do not build a complicated
 * migration framework yet" instruction - a future breaking change adds one
 * more entry here, each a pure function of "old shape" (loosely typed, since
 * by definition it no longer matches AppState) to a valid AppState.
 */
const MIGRATIONS: Record<number, (old: any) => any> = {
  // no migrations needed yet - schemaVersion 1 is the first shape.
};

/**
 * Loads and migrates persisted state, or returns a fresh empty AppState if
 * nothing is stored yet OR the stored JSON is corrupted/unparseable -
 * corruption is a real, expected failure mode for hand-edited/truncated
 * localStorage, never allowed to crash the app. Runs every applicable
 * migration in order until schemaVersion matches APP_SCHEMA_VERSION.
 */
export function loadAppState(storage: StorageAdapter): AppState {
  const raw = storage.getItem(APP_STATE_STORAGE_KEY);
  if (raw === null) return emptyAppState();

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyAppState();
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.schemaVersion !== "number") {
    return emptyAppState();
  }

  let state = parsed;
  while (state.schemaVersion < APP_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[state.schemaVersion];
    if (!migrate) {
      // no migration path from this version - safest choice is a fresh
      // state rather than risking a corrupted/partial replay.
      return emptyAppState();
    }
    state = migrate(state);
  }

  return state as AppState;
}

export function saveAppState(storage: StorageAdapter, state: AppState): void {
  storage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
}

export function clearAppState(storage: StorageAdapter): void {
  storage.removeItem(APP_STATE_STORAGE_KEY);
}
