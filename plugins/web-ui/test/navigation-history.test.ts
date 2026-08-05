import assert from "node:assert/strict";
import test from "node:test";
import { navigationScreen, writeNavigationHistory, type NavigationHistoryWriter } from "../src/navigation-history.ts";

function recorder(): {
  writer: NavigationHistoryWriter;
  calls: Array<{ method: string; state: unknown; url: string }>;
} {
  const calls: Array<{ method: string; state: unknown; url: string }> = [];
  return {
    calls,
    writer: {
      pushState: (state, _unused, url) => calls.push({ method: "push", state, url: String(url) }),
      replaceState: (state, _unused, url) => calls.push({ method: "replace", state, url: String(url) }),
    },
  };
}

test("deliberate navigation creates a restorable history entry", () => {
  const { writer, calls } = recorder();
  const state = { qm: true, view: "files", screen: "list" };
  assert.equal(writeNavigationHistory(writer, "/files", "push", state), true);
  assert.deepEqual(calls, [{ method: "push", state, url: "/files" }]);
});

test("normalization replaces the current history entry", () => {
  const { writer, calls } = recorder();
  const state = { qm: true, view: "keychain", screen: "list" };
  assert.equal(writeNavigationHistory(writer, "/keychain", "replace", state), true);
  assert.deepEqual(calls, [{ method: "replace", state, url: "/keychain" }]);
});

test("popstate restoration does not write history", () => {
  const { writer, calls } = recorder();
  assert.equal(writeNavigationHistory(writer, "/crons", "none", { qm: true }), false);
  assert.deepEqual(calls, []);
});

test("same-URL deliberate navigation can preserve distinct UI state", () => {
  const { writer, calls } = recorder();
  writeNavigationHistory(writer, "/", "push", { qm: true, screen: "conversation", threadRef: "web:test:new" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "push");
});

test("an unsaved conversation is restorable before its host mounts", () => {
  assert.equal(navigationScreen("chats", false, "web:test:new", null), "conversation");
});

test("saved and split conversations remain distinct from route lists", () => {
  assert.equal(navigationScreen("chats", false, null, "session-1"), "conversation");
  assert.equal(navigationScreen("chats", true, null, null), "split");
  assert.equal(navigationScreen("files", true, "web:test:new", "session-1"), "list");
  assert.equal(navigationScreen("chats", false, null, null), "list");
});
