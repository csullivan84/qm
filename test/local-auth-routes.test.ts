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

const SECRET = "local-auth-route-signing-secret".repeat(2);
const PASSWORD = "fixture-passphrase-123";
let nonce = 0;

function durableMemory(): LocalAuthPersistence {
  return { ...createMemoryLocalAuthPersistence(), durable: true };
}

function start(withLocalAuth = true) {
  const built = buildApp(testConfig());
  const localAuth = createLocalAuthService(durableMemory(), {
    passwordHashCost: { n: 1024, r: 8, p: 1, keyLength: 32 },
    randomToken: () => `route-token-${String(++nonce).padStart(40, "0")}`,
  });
  const server = createServer(built.app, { signingSecret: SECRET, ...(withLocalAuth ? { localAuth } : {}) });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    localAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(base: string, pathname: string, body: unknown, signed = true) {
  const query = `?_sourceAuthNonce=${++nonce}`;
  const path = `${pathname}${query}`;
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signed) {
    headers["x-timestamp"] = String(timestamp);
    headers["x-signature"] = signRequest(SECRET, timestamp, `POST\n${path}\n${raw}`);
  }
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: raw });
  return { response, text: await response.text() };
}

test("local auth routes complete setup, login, database session validation, and logout", async (t) => {
  const server = start();
  t.after(() => server.close());
  const created = await server.localAuth.createUser("alice");

  const setup = await post(server.base, "/v1/auth/local/setup", {
    setupCode: created.setupCode,
    password: PASSWORD,
  });
  assert.equal(setup.response.status, 200);
  assert.equal(setup.text.includes(PASSWORD), false);
  assert.equal(setup.text.includes("passwordHash"), false);
  const setupBody = JSON.parse(setup.text) as { token: string; username: string };
  assert.equal(setupBody.username, "alice");

  const session = await post(server.base, "/v1/auth/local/session", { token: setupBody.token });
  assert.equal(session.response.status, 200);
  assert.equal((JSON.parse(session.text) as { username: string }).username, "alice");

  const logout = await post(server.base, "/v1/auth/local/logout", { token: setupBody.token });
  assert.equal(logout.response.status, 200);
  assert.equal((await post(server.base, "/v1/auth/local/session", { token: setupBody.token })).response.status, 401);

  const login = await post(server.base, "/v1/auth/local/login", { username: "alice", password: PASSWORD });
  assert.equal(login.response.status, 200);
  assert.equal(login.text.includes(PASSWORD), false);
  assert.equal((JSON.parse(login.text) as { username: string }).username, "alice");
});

test("local auth routes reject invalid credentials, unsigned callers, and non-durable stores", async (t) => {
  const server = start();
  t.after(() => server.close());
  await server.localAuth.createUser("alice");
  const invalid = await post(server.base, "/v1/auth/local/login", {
    username: "alice",
    password: "wrong-passphrase-123",
  });
  assert.equal(invalid.response.status, 401);
  assert.equal(JSON.parse(invalid.text).message, "invalid username or password");
  assert.equal((await post(server.base, "/v1/auth/local/login", {}, false)).response.status, 401);

  const unavailable = start(false);
  t.after(() => unavailable.close());
  const notConfigured = await post(unavailable.base, "/v1/auth/local/session", { token: "x" });
  assert.equal(notConfigured.response.status, 503);
});

test("a stale bootstrap token is inert without a configured bootstrap user", async () => {
  const built = buildApp(testConfig({ localAuthBootstrapToken: "stale-bootstrap-token-that-is-long-enough" }));
  await built.localAuthReady;
  assert.deepEqual(await built.localAuth.listUsers(), []);

  const incomplete = buildApp(testConfig({ localAuthBootstrapUser: "alice" }));
  await assert.rejects(incomplete.localAuthReady, /requires LOCAL_AUTH_BOOTSTRAP_TOKEN/);
});
