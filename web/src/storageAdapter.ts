import { StorageAdapter } from "../../src/app/storage";

/**
 * Binds the existing StorageAdapter interface (src/app/storage.ts,
 * unchanged) to the real browser window.localStorage - the only file in
 * this whole application that touches `window`/`localStorage` directly.
 * Everything else (src/app/, src/web/viewModel.ts) is storage-agnostic.
 */
export class LocalStorageAdapter implements StorageAdapter {
  getItem(key: string): string | null {
    return window.localStorage.getItem(key);
  }
  setItem(key: string, value: string): void {
    window.localStorage.setItem(key, value);
  }
  removeItem(key: string): void {
    window.localStorage.removeItem(key);
  }
}
