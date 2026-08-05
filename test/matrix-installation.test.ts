import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { MatrixPluginConfig } from "../src/matrix/config.ts";
import {
  createMatrixInstallationStore,
  type StoredMatrixInstallation,
  validateMatrixInstallation,
} from "../src/surfaces/matrix-installation.ts";

const config: MatrixPluginConfig = {
  homeserverUrl: "https://matrix.example.com",
  accessToken: "matrix-secret-token",
  allowedRoomIds: ["!room:example.com"],
  allowedUserIds: ["@alice:example.com"],
  principalMap: { "@alice:example.com": "alice" },
  syncTimeoutMs: 12000,
  syncCursorPath: "/var/lib/qm/matrix-sync-cursor",
  deliveryMode: "edits",
  formattedMessages: true,
  followThreads: true,
  reactions: true,
  attachments: {
    enabled: true,
    maxCount: 5,
    maxBytes: 1000000,
    allowedMimeTypes: ["text/plain"],
    allowedMediaServerNames: ["example.com"],
  },
  approvalModes: ["once", "deny"],
};

test("Matrix installation encrypts its token and returns only public policy in status", async () => {
  const backing = createMemoryMap<StoredMatrixInstallation>();
  const store = createMatrixInstallationStore("default-org", backing, Buffer.alloc(32, 7));

  const status = await store.set({ config, updatedBy: "admin-alice" });
  assert.equal(status.configured, true);
  assert.equal(status.managed, true);
  assert.equal(status.homeserverUrl, "https://matrix.example.com");
  assert.deepEqual(status.approvalModes, ["once", "deny"]);
  assert.doesNotMatch(JSON.stringify(status), /matrix-secret-token/);
  assert.equal((await store.get())?.accessToken, "matrix-secret-token");
  assert.doesNotMatch(JSON.stringify(await backing.get("default-org")), /matrix-secret-token/);

  await store.delete("admin-alice");
  assert.equal(await store.get(), null);
  assert.deepEqual(await store.status(), { configured: false, managed: true });
});

test("Matrix installation rotates its sync generation only after an explicit disable", async () => {
  const backing = createMemoryMap<StoredMatrixInstallation>();
  const store = createMatrixInstallationStore("default-org", backing, Buffer.alloc(32, 7));

  await store.set({ config, updatedBy: "admin-alice" });
  const first = await store.runtime();
  assert.ok(first);
  await store.set({ config: { ...config, followThreads: false }, updatedBy: "admin-bob" });
  const updated = await store.runtime();
  assert.ok(updated);
  assert.equal(updated.syncGeneration, first.syncGeneration);

  await store.delete("admin-bob");
  await store.set({ config, updatedBy: "admin-alice" });
  const reenabled = await store.runtime();
  assert.ok(reenabled);
  assert.notEqual(reenabled.syncGeneration, first.syncGeneration);
});

test("Matrix disable drains acquired event leases before it completes and rejects new work", async () => {
  const store = createMatrixInstallationStore(
    "default-org",
    createMemoryMap<StoredMatrixInstallation>(),
    Buffer.alloc(32, 8),
  );
  await store.set({ config, updatedBy: "admin-alice" });
  const active = await store.runtime();
  assert.ok(active);
  const token = "event-lease";
  assert.equal(await store.acquireProcessingLease(active.version, token, Date.now() + 60_000), true);

  let disabled = false;
  const disabling = store.delete("admin-alice").then(() => {
    disabled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(disabled, false);

  await store.releaseProcessingLease(token);
  await disabling;
  assert.equal(disabled, true);
  assert.equal(await store.acquireProcessingLease(active.version, "late-event", Date.now() + 60_000), false);
});

test("Matrix installation validation proves bot identity and fail-closed room membership", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com" }));
    }
    if (url.endsWith("/joined_members")) {
      return new Response(
        JSON.stringify({ joined: { "@qm:example.com": {}, "@alice:example.com": { display_name: "Alice" } } }),
      );
    }
    return new Response(
      JSON.stringify([
        { type: "m.room.join_rules", content: { join_rule: "invite" } },
        { type: "m.room.history_visibility", content: { history_visibility: "joined" } },
        { type: "m.room.guest_access", content: { guest_access: "forbidden" } },
        { type: "m.room.member", state_key: "@qm:example.com", content: { membership: "join" } },
        { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
      ]),
    );
  };

  assert.deepEqual(await validateMatrixInstallation(config, fetchImpl), { botUserId: "@qm:example.com" });
  assert.equal(calls.length, 3);
});

test("Matrix installation validation rejects rooms with unapproved participants", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/account/whoami")) return new Response(JSON.stringify({ user_id: "@qm:example.com" }));
    if (url.endsWith("/joined_members")) {
      return new Response(JSON.stringify({ joined: { "@qm:example.com": {}, "@intruder:example.com": {} } }));
    }
    return new Response(
      JSON.stringify([
        { type: "m.room.join_rules", content: { join_rule: "invite" } },
        { type: "m.room.history_visibility", content: { history_visibility: "joined" } },
        { type: "m.room.guest_access", content: { guest_access: "forbidden" } },
        { type: "m.room.member", state_key: "@qm:example.com", content: { membership: "join" } },
        { type: "m.room.member", state_key: "@intruder:example.com", content: { membership: "join" } },
      ]),
    );
  };

  await assert.rejects(validateMatrixInstallation(config, fetchImpl), /unapproved participant/);
});
