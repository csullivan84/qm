import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixSyncStateStore, type MatrixSyncStateRecord } from "../src/matrix/sync-state.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("Matrix sync state durably advances a cursor only for the active lease", async () => {
  let now = 1000;
  const store = createMatrixSyncStateStore(createMemoryMap<MatrixSyncStateRecord>(), () => now);
  const first = await store.claim("matrix:one", "core-a", 100);
  assert.ok(first);
  assert.equal(await store.cursor("matrix:one", first.token), null);
  await store.advance("matrix:one", first.token, "batch-1", 100);
  assert.equal(await store.cursor("matrix:one", first.token), "batch-1");

  assert.equal(await store.claim("matrix:one", "core-b", 100), null);
  await assert.rejects(store.advance("matrix:one", "wrong-token", "stolen", 100), /lease/);

  now = 1200;
  const second = await store.claim("matrix:one", "core-b", 100);
  assert.ok(second);
  assert.equal(await store.cursor("matrix:one", second.token), "batch-1");
  await store.advance("matrix:one", second.token, "batch-2", 100);
  await store.release("matrix:one", second.token);

  const third = await store.claim("matrix:one", "core-c", 100);
  assert.ok(third);
  assert.equal(await store.cursor("matrix:one", third.token), "batch-2");
});

test("Matrix sync state namespaces cursors by homeserver and authenticated bot", () => {
  const store = createMatrixSyncStateStore(createMemoryMap<MatrixSyncStateRecord>());
  assert.equal(
    store.identityKey("https://matrix.example.com", "@qm:example.com"),
    store.identityKey("https://matrix.example.com/", "@qm:example.com"),
  );
  assert.notEqual(
    store.identityKey("https://matrix.example.com", "@qm:example.com"),
    store.identityKey("https://other.example.com", "@qm:example.com"),
  );
  assert.notEqual(
    store.identityKey("https://matrix.example.com", "@qm:example.com"),
    store.identityKey("https://matrix.example.com", "@other:example.com"),
  );
  assert.notEqual(
    store.identityKey("https://matrix.example.com", "@qm:example.com", "first"),
    store.identityKey("https://matrix.example.com", "@qm:example.com", "second"),
  );
});
