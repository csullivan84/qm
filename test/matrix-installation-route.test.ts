import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function matrixFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/account/whoami")) return new Response(JSON.stringify({ user_id: "@qm:example.com" }));
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
}

function start(opts: { durable?: boolean; environment?: "absent" | "configured" | "partial" } = {}) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "matrix-route-")) }));
  const server = createInsecureTestServer(built.app, {
    replayDedupe: built.replayDedupe,
    matrixInstallation: built.matrixInstallation,
    matrixInstallationDurable: opts.durable ?? true,
    matrixInstallationFetch: matrixFetch(),
    matrixEnvironmentState: opts.environment ?? "absent",
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const installation = {
  homeserverUrl: "https://matrix.example.com",
  accessToken: "matrix-secret-token",
  allowedRoomIds: ["!room:example.com"],
  allowedUserIds: ["@alice:example.com"],
  principalMap: { "@alice:example.com": "alice" },
  syncTimeoutMs: 12000,
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

test("admin validates and stores a write-only Matrix token with durable surface policy", async () => {
  const srv = start();
  try {
    const denied = await fetch(`${srv.base}/v1/admin/matrix-installation`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify(installation),
    });
    assert.equal(denied.status, 403);

    const put = await fetch(`${srv.base}/v1/admin/matrix-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(installation),
    });
    assert.equal(put.status, 200);
    const putText = await put.text();
    assert.doesNotMatch(putText, /matrix-secret-token/);
    assert.match(putText, /@qm:example\.com/);
    assert.equal((await srv.built.matrixInstallation.get())?.accessToken, "matrix-secret-token");

    const update = await fetch(`${srv.base}/v1/admin/matrix-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...installation, accessToken: "", followThreads: false }),
    });
    assert.equal(update.status, 200);
    assert.equal((await srv.built.matrixInstallation.get())?.accessToken, "matrix-secret-token");
    assert.equal((await srv.built.matrixInstallation.get())?.followThreads, false);

    const status = await fetch(`${srv.base}/v1/admin/matrix-installation`, { headers: ADMIN });
    const statusText = await status.text();
    assert.equal(status.status, 200);
    assert.doesNotMatch(statusText, /matrix-secret-token/);
    assert.equal(JSON.parse(statusText).source, "admin");

    const removed = await fetch(`${srv.base}/v1/admin/matrix-installation`, { method: "DELETE", headers: ADMIN });
    assert.equal(removed.status, 200);
    assert.equal(await srv.built.matrixInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("admin rejects malformed Matrix policy before any secret is stored", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/matrix-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...installation, approvalModes: ["anything"] }),
    });
    assert.equal(put.status, 400);
    assert.match(await put.text(), /approval/i);
    assert.equal(await srv.built.matrixInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("environment-to-admin migration requires an explicit token that can be stored durably", async () => {
  const srv = start({ environment: "configured" });
  try {
    const status = await fetch(`${srv.base}/v1/admin/matrix-installation`, { headers: ADMIN });
    assert.deepEqual(await status.json(), {
      configured: true,
      managed: false,
      source: "environment",
      managementAvailable: true,
      tokenRequired: true,
    });

    const put = await fetch(`${srv.base}/v1/admin/matrix-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...installation, accessToken: "" }),
    });
    assert.equal(put.status, 400);
    assert.match(await put.text(), /accessToken is required/);
  } finally {
    await srv.close();
  }
});

test("admin refuses Matrix credential management when only process-memory storage is available", async () => {
  const srv = start({ durable: false });
  try {
    const put = await fetch(`${srv.base}/v1/admin/matrix-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(installation),
    });
    assert.equal(put.status, 503);
    assert.match(await put.text(), /durable_storage_required/);
    assert.equal(await srv.built.matrixInstallation.get(), null);
  } finally {
    await srv.close();
  }
});
