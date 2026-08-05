import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalAuthError,
  createLocalAuthService,
  createMemoryLocalAuthPersistence,
  hashLocalPassword,
  verifyLocalPassword,
} from "../src/auth/local-auth.ts";

const TEST_COST = { n: 1024, r: 8, p: 1, keyLength: 32 };
const PASSWORD = "fixture-passphrase-123";

function service() {
  let now = 1_000_000;
  let token = 0;
  const auth = createLocalAuthService(createMemoryLocalAuthPersistence(), {
    now: () => now,
    passwordHashCost: TEST_COST,
    sessionTtlMs: 10_000,
    resetTtlMs: 5_000,
    randomToken: () => `test-token-${String(++token).padStart(40, "0")}`,
  });
  return { auth, advance: (ms: number) => (now += ms) };
}

test("passwords are salted scrypt hashes and never appear in stored encodings", async () => {
  const first = await hashLocalPassword(PASSWORD, TEST_COST);
  const second = await hashLocalPassword(PASSWORD, TEST_COST);
  assert.match(first, /^\$scrypt\$1\$1024\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(PASSWORD), false);
  assert.equal(await verifyLocalPassword(PASSWORD, first), true);
  assert.equal(await verifyLocalPassword("wrong-passphrase-123", first), false);
  assert.equal(await verifyLocalPassword(PASSWORD, "not-a-hash"), false);
});

test("new accounts require a one-time setup code that creates a database-backed session", async () => {
  const { auth } = service();
  const created = await auth.createUser(" Alice ");
  assert.equal(created.user.username, "alice");
  assert.equal(created.user.passwordSet, false);
  assert.equal(await auth.authenticate("alice", PASSWORD), null);

  const completed = await auth.completePasswordReset(created.setupCode, PASSWORD);
  assert.equal(completed.session.username, "alice");
  assert.deepEqual(await auth.resolveSession(completed.token), completed.session);
  await assert.rejects(() => auth.completePasswordReset(created.setupCode, PASSWORD), /invalid or expired setup code/);

  const listed = await auth.listUsers();
  assert.equal(listed[0]?.passwordSet, true);
  assert.equal(listed[0]?.activeSessions, 1);
});

test("password changes, resets, disables, and expiry revoke sessions", async () => {
  const { auth, advance } = service();
  const created = await auth.createUser("alice");
  const setup = await auth.completePasswordReset(created.setupCode, PASSWORD);
  assert.ok(await auth.resolveSession(setup.token));

  await auth.setPassword("alice", "replacement-passphrase-456");
  assert.equal(await auth.resolveSession(setup.token), null);
  const login = await auth.authenticate("ALICE", "replacement-passphrase-456");
  assert.ok(login);

  const reset = await auth.beginPasswordReset("alice");
  assert.ok(await auth.resolveSession(login!.token));
  assert.ok(await auth.authenticate("alice", "replacement-passphrase-456"));
  await auth.completePasswordReset(reset.setupCode, PASSWORD);
  assert.equal(await auth.resolveSession(login!.token), null);
  assert.equal(await auth.authenticate("alice", "replacement-passphrase-456"), null);

  const active = await auth.authenticate("alice", PASSWORD);
  assert.ok(active);
  await auth.setEnabled("alice", false);
  assert.equal(await auth.resolveSession(active!.token), null);
  assert.equal(await auth.authenticate("alice", PASSWORD), null);

  await auth.setEnabled("alice", true);
  const expiring = await auth.authenticate("alice", PASSWORD);
  assert.ok(expiring);
  advance(10_001);
  assert.equal(await auth.resolveSession(expiring!.token), null);
});

test("bootstrap only seeds an exact admin principal, refreshes pending setup, and preserves configured passwords", async () => {
  const { auth, advance } = service();
  await assert.rejects(
    () =>
      auth.bootstrapAdmin({
        username: "alice",
        setupCode: "bootstrap-code-that-is-long-enough-0001",
        adminPrincipals: ["someone-else"],
      }),
    /must already hold an admin grant/,
  );
  await assert.rejects(
    () =>
      auth.bootstrapAdmin({
        username: "alice",
        setupCode: "bootstrap-code-that-is-long-enough-0001",
        adminPrincipals: ["ALICE"],
      }),
    /must already hold an admin grant/,
  );

  const seeded = await auth.bootstrapAdmin({
    username: "alice",
    setupCode: "bootstrap-code-that-is-long-enough-0002",
    adminPrincipals: ["alice"],
  });
  assert.deepEqual(seeded, { username: "alice", pending: true });
  const pendingRepeat = await auth.bootstrapAdmin({
    username: "alice",
    setupCode: "bootstrap-code-that-is-long-enough-0003",
    adminPrincipals: ["alice"],
  });
  assert.deepEqual(pendingRepeat, { username: "alice", pending: true });
  await assert.rejects(
    () => auth.completePasswordReset("bootstrap-code-that-is-long-enough-0002", PASSWORD),
    /invalid or expired setup code/,
  );
  advance(7 * 24 * 60 * 60_000 + 1);
  const recovered = await auth.bootstrapAdmin({
    username: "alice",
    setupCode: "bootstrap-code-that-is-long-enough-0004",
    adminPrincipals: ["alice"],
  });
  assert.deepEqual(recovered, { username: "alice", pending: true });
  await auth.completePasswordReset("bootstrap-code-that-is-long-enough-0004", PASSWORD);

  const repeated = await auth.bootstrapAdmin({
    username: "alice",
    setupCode: "bootstrap-code-that-is-long-enough-0005",
    adminPrincipals: ["alice"],
  });
  assert.deepEqual(repeated, { username: "alice", pending: false });
  await assert.rejects(
    () => auth.completePasswordReset("bootstrap-code-that-is-long-enough-0005", PASSWORD),
    /invalid or expired setup code/,
  );
  assert.ok(await auth.authenticate("alice", PASSWORD));
});

test("invalid username syntax never aliases a real account", async () => {
  const { auth } = service();
  const created = await auth.createUser("invalid");
  await auth.completePasswordReset(created.setupCode, PASSWORD);
  assert.equal(await auth.authenticate("!", PASSWORD), null);
  assert.ok(await auth.authenticate("invalid", PASSWORD));
});

test("disabling an account permanently revokes outstanding setup codes", async () => {
  const { auth } = service();
  const created = await auth.createUser("contained-user");
  await auth.setEnabled("contained-user", false);
  await auth.setEnabled("contained-user", true);
  await assert.rejects(() => auth.completePasswordReset(created.setupCode, PASSWORD), /invalid or expired setup code/);
});

test("username and password policy failures are explicit without echoing credentials", async () => {
  const { auth } = service();
  await assert.rejects(
    () => auth.createUser("x"),
    (error: unknown) => {
      assert.ok(error instanceof LocalAuthError);
      assert.equal(error.status, 400);
      return true;
    },
  );
  const created = await auth.createUser("valid-user");
  await assert.rejects(() => auth.completePasswordReset(created.setupCode, "too-short"), /at least 12 characters/);
});
