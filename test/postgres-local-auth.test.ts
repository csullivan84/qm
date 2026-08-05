import "./support/auto-fake-sprites.ts";

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createLocalAuthService } from "../src/auth/local-auth.ts";
import { createPostgresLocalAuthPersistence } from "../src/auth/postgres-local-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres local-auth tests";
const passwordHashCost = { n: 1024, r: 8, p: 1, keyLength: 32 };

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(
    "DROP TABLE IF EXISTS local_auth_password_resets, local_auth_sessions, local_auth_users, admin_grants CASCADE",
  );
  await pool.end();
});

test(
  "the configured bootstrap principal is durable, recoverable while pending, and protected after setup",
  { skip },
  async () => {
    const setupCode = "fixture-bootstrap-token-that-is-long-enough";
    const built = buildApp(
      testConfig({
        databaseUrl: URL!,
        adminGrants: "alice:org_admin",
        localAuthBootstrapUser: "alice",
        localAuthBootstrapToken: setupCode,
      }),
    );
    await built.localAuthReady;
    assert.equal((await built.localAuth.listUsers())[0]?.username, "alice");
    assert.equal((await built.localAuth.listUsers())[0]?.passwordSet, false);
    assert.equal((await built.admin.adminStatusOf({ id: "alice", type: "internal" })).role, "org_admin");

    const refreshedCode = "refreshed-bootstrap-token-that-is-long-enough";
    const pendingRestart = buildApp(
      testConfig({
        databaseUrl: URL!,
        adminGrants: "alice:org_admin",
        localAuthBootstrapUser: "alice",
        localAuthBootstrapToken: refreshedCode,
      }),
    );
    await pendingRestart.localAuthReady;
    await assert.rejects(() => pendingRestart.localAuth.completePasswordReset(setupCode, "fixture-bootstrap-password"));
    const password = "fixture-bootstrap-password";
    await pendingRestart.localAuth.completePasswordReset(refreshedCode, password);
    const restarted = buildApp(
      testConfig({
        databaseUrl: URL!,
        adminGrants: "alice:org_admin",
        localAuthBootstrapUser: "alice",
        localAuthBootstrapToken: "different-bootstrap-token-that-is-long-enough",
      }),
    );
    await restarted.localAuthReady;
    assert.ok(await restarted.localAuth.authenticate("alice", password));
    await assert.rejects(
      () => restarted.localAuth.completePasswordReset("different-bootstrap-token-that-is-long-enough", password),
      /invalid or expired setup code/,
    );
  },
);

test("Postgres local accounts persist hashes and revocable sessions across service instances", { skip }, async () => {
  const first = createLocalAuthService(createPostgresLocalAuthPersistence(URL!), { passwordHashCost });
  const created = await first.createUser("alice-test");
  const password = "fixture-password-one";
  const setup = await first.completePasswordReset(created.setupCode, password);

  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  const userRow = await pool.query("SELECT password_hash FROM local_auth_users WHERE username = $1", ["alice-test"]);
  assert.match(userRow.rows[0].password_hash, /^\$scrypt\$1\$/);
  assert.doesNotMatch(userRow.rows[0].password_hash, new RegExp(password));
  const sessionRows = await pool.query("SELECT token_hash FROM local_auth_sessions WHERE username = $1", [
    "alice-test",
  ]);
  assert.equal(sessionRows.rowCount, 1);
  assert.notEqual(sessionRows.rows[0].token_hash, setup.token);
  assert.notEqual(JSON.stringify(userRow.rows), created.setupCode);

  const restarted = createLocalAuthService(createPostgresLocalAuthPersistence(URL!), { passwordHashCost });
  assert.equal((await restarted.resolveSession(setup.token))?.username, "alice-test");
  assert.equal((await restarted.authenticate("alice-test", password))?.session.username, "alice-test");

  const reset = await restarted.beginPasswordReset("alice-test");
  assert.equal((await restarted.resolveSession(setup.token))?.username, "alice-test");
  const resetRows = await pool.query("SELECT token_hash FROM local_auth_password_resets WHERE username = $1", [
    "alice-test",
  ]);
  assert.equal(resetRows.rowCount, 1);
  assert.notEqual(resetRows.rows[0].token_hash, reset.setupCode);

  const afterReset = createLocalAuthService(createPostgresLocalAuthPersistence(URL!), { passwordHashCost });
  const newPassword = "fixture-password-two";
  const renewed = await afterReset.completePasswordReset(reset.setupCode, newPassword);
  await assert.rejects(() => afterReset.completePasswordReset(reset.setupCode, newPassword), /invalid or expired/);
  assert.equal(await afterReset.resolveSession(setup.token), null);
  assert.equal((await afterReset.resolveSession(renewed.token))?.username, "alice-test");
  assert.equal(await afterReset.authenticate("alice-test", password), null);
  assert.equal((await afterReset.authenticate("alice-test", newPassword))?.session.username, "alice-test");

  await afterReset.setEnabled("alice-test", false);
  assert.equal(await afterReset.resolveSession(renewed.token), null);
  assert.equal(await afterReset.authenticate("alice-test", newPassword), null);
  await pool.end();
});

test("Postgres disable and re-enable does not resurrect a pending setup code", { skip }, async () => {
  const auth = createLocalAuthService(createPostgresLocalAuthPersistence(URL!), { passwordHashCost });
  const created = await auth.createUser("contained-user");
  await auth.setEnabled("contained-user", false);
  await auth.setEnabled("contained-user", true);
  await assert.rejects(
    () => auth.completePasswordReset(created.setupCode, "fixture-contained-password"),
    /invalid or expired setup code/,
  );
});

test("Postgres reset consumption wins safely against login and can be consumed only once", { skip }, async () => {
  const auth = createLocalAuthService(createPostgresLocalAuthPersistence(URL!), { passwordHashCost });
  const created = await auth.createUser("race-user");
  const oldPassword = "fixture-race-password-old";
  await auth.completePasswordReset(created.setupCode, oldPassword);
  const reset = await auth.beginPasswordReset("race-user");
  const newPassword = "fixture-race-password-new";

  const [login, completed] = await Promise.all([
    auth.authenticate("race-user", oldPassword),
    auth.completePasswordReset(reset.setupCode, newPassword),
  ]);
  if (login) assert.equal(await auth.resolveSession(login.token), null);
  assert.equal(await auth.authenticate("race-user", oldPassword), null);
  assert.ok(await auth.authenticate("race-user", newPassword));
  assert.equal((await auth.resolveSession(completed.token))?.username, "race-user");

  const secondReset = await auth.beginPasswordReset("race-user");
  const attempts = await Promise.allSettled([
    auth.completePasswordReset(secondReset.setupCode, "fixture-race-password-one"),
    auth.completePasswordReset(secondReset.setupCode, "fixture-race-password-two"),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
});

test("Postgres local-auth schema upgrades a pre-bootstrap account table in place", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(`CREATE TABLE local_auth_users(
    username TEXT PRIMARY KEY,
    password_hash TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    last_login_at BIGINT
  )`);
  await pool.end();

  const auth = createLocalAuthService(createPostgresLocalAuthPersistence(URL!), { passwordHashCost });
  assert.deepEqual(await auth.listUsers(), []);

  const verify = new pg.Pool({ connectionString: URL });
  const column = await verify.query(
    `SELECT column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'local_auth_users' AND column_name = 'bootstrap_open'`,
  );
  assert.equal(column.rowCount, 1);
  assert.equal(column.rows[0].is_nullable, "NO");
  await verify.end();
});
