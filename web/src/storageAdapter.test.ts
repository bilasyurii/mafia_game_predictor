import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalStorageAdapter } from "./storageAdapter";

/**
 * No jsdom dependency: window.localStorage is a small get/set/remove
 * surface, so a plain in-memory object standing in for it is enough to
 * verify LocalStorageAdapter really delegates to window.localStorage
 * (rather than, say, silently no-op-ing) without pulling in a real DOM.
 */
function installFakeWindow(): Record<string, string> {
  const backing: Record<string, string> = {};
  const fakeStorage = {
    getItem: (key: string) => (key in backing ? backing[key] : null),
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
  };
  (globalThis as any).window = { localStorage: fakeStorage };
  return backing;
}

test("LocalStorageAdapter round-trips through window.localStorage", () => {
  const backing = installFakeWindow();
  const adapter = new LocalStorageAdapter();

  assert.equal(adapter.getItem("k"), null);
  adapter.setItem("k", "v1");
  assert.equal(backing.k, "v1");
  assert.equal(adapter.getItem("k"), "v1");

  adapter.setItem("k", "v2");
  assert.equal(adapter.getItem("k"), "v2");

  adapter.removeItem("k");
  assert.equal(adapter.getItem("k"), null);
  assert.equal("k" in backing, false);
});
