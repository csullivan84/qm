import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import {
  createLocalAuthService,
  createMemoryLocalAuthPersistence,
  type LocalAuthPersistence,
} from "../src/auth/local-auth.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "admin-local-user-route-secret".repeat(2);
const ACTOR = "admin-alice@default-org";
const PASSWORD = "fixture-passphrase-123";
let nonce = 0;

function start() {
  const built = buildApp(testConfig());
  const persistence: LocalAuthPersistence = { ...createMemoryLocalAuthPersistence(), durable: true };
  const localAuth = createLocalAuthService(persistence, {
    passwordHashCost: { n: 1024, r: 8, p: 1, keyLength: 32 },
    randomToken: () => `admin-route-token-${String(++nonce).padStart(40, "0")}`,
  });
  const server = createServer(built.app, {
    signingSecret: SECRET,
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    localAuth,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    localAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function request(base: string, method: string, pathname: string, body?: unknown) {
  const path = `${pathname}?_sourceAuthNonce=${++nonce}`;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "x-admin-actor": ACTOR,
    "x-timestamp": String(timestamp),
    "x-signature": signRequest(SECRET, timestamp, `${method}\n${path}\n${raw}`),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: raw }) });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

test("admins create local users and manage password, reset, enabled, and session state", async (t) => {
  const server = start();
  t.after(() => server.close());

  const created = await request(server.base, "POST", "/v1/admin/local-users", { username: "Alice" });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.user.username, "alice");
  assert.equal(created.body.user.passwordSet, false);
  assert.equal(created.text.includes("passwordHash"), false);

  const setup = await server.localAuth.completePasswordReset(created.body.setupCode, PASSWORD);
  assert.ok(await server.localAuth.resolveSession(setup.token));

  const newPassword = "replacement-passphrase-456";
  const changed = await request(server.base, "PUT", "/v1/admin/local-users/alice/password", {
    password: newPassword,
  });
  assert.equal(changed.response.status, 200);
  assert.deepEqual(changed.body, { ok: true });
  assert.equal(changed.text.includes(newPassword), false);
  assert.equal(await server.localAuth.resolveSession(setup.token), null);

  const login = await server.localAuth.authenticate("alice", newPassword);
  assert.ok(login);
  const reset = await request(server.base, "POST", "/v1/admin/local-users/alice/password-reset", {});
  assert.equal(reset.response.status, 200);
  assert.equal(reset.text.includes(newPassword), false);
  assert.ok(await server.localAuth.resolveSession(login!.token));
  assert.ok(await server.localAuth.authenticate("alice", newPassword));

  await server.localAuth.completePasswordReset(reset.body.setupCode, PASSWORD);
  assert.equal(await server.localAuth.resolveSession(login!.token), null);
  assert.equal(await server.localAuth.authenticate("alice", newPassword), null);
  const disabled = await request(server.base, "PUT", "/v1/admin/local-users/alice/enabled", { enabled: false });
  assert.equal(disabled.response.status, 200);
  assert.equal(await server.localAuth.authenticate("alice", PASSWORD), null);
  assert.equal(
    (await request(server.base, "PUT", "/v1/admin/local-users/alice/enabled", { enabled: true })).response.status,
    200,
  );

  const users = await request(server.base, "GET", "/v1/admin/users");
  assert.equal(users.response.status, 200);
  assert.deepEqual(
    users.body.localAccounts.map((user: { username: string }) => user.username),
    ["alice"],
  );
  assert.equal(users.text.includes("passwordHash"), false);

  const audit = JSON.stringify(await server.built.auditLog.events());
  assert.equal(audit.includes(PASSWORD), false);
  assert.equal(audit.includes(newPassword), false);
  assert.equal(audit.includes(created.body.setupCode), false);
  assert.equal(audit.includes(reset.body.setupCode), false);
});

test("admin local-user routes validate policy and refuse self-disable", async (t) => {
  const server = start();
  t.after(() => server.close());
  await request(server.base, "POST", "/v1/admin/local-users", { username: "admin-alice" });

  const selfDisable = await request(server.base, "PUT", "/v1/admin/local-users/admin-alice/enabled", {
    enabled: false,
  });
  assert.equal(selfDisable.response.status, 400);
  assert.match(selfDisable.body.message, /cannot disable your own/);
  const paddedSelfDisable = await request(server.base, "PUT", "/v1/admin/local-users/%20admin-alice%20/enabled", {
    enabled: false,
  });
  assert.equal(paddedSelfDisable.response.status, 400);
  assert.match(paddedSelfDisable.body.message, /cannot disable your own/);

  const weak = await request(server.base, "PUT", "/v1/admin/local-users/admin-alice/password", {
    password: "short",
  });
  assert.equal(weak.response.status, 400);
  assert.match(weak.body.message, /at least 12 characters/);
  assert.equal(weak.text.includes("short"), false);
});
