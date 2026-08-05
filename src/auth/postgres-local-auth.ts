import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { LocalAuthPersistence, LocalAuthSession, LocalAuthUser, StoredLocalAuthUser } from "./local-auth.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS local_auth_users(
    username      TEXT PRIMARY KEY,
    password_hash TEXT,
    bootstrap_open BOOLEAN NOT NULL DEFAULT FALSE,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    last_login_at BIGINT
  )`,
  `ALTER TABLE local_auth_users ADD COLUMN IF NOT EXISTS bootstrap_open BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS local_auth_sessions(
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES local_auth_users(username) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS local_auth_sessions_user_expiry
    ON local_auth_sessions(username, expires_at)`,
  `CREATE INDEX IF NOT EXISTS local_auth_sessions_expiry
    ON local_auth_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS local_auth_password_resets(
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES local_auth_users(username) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS local_auth_password_resets_user
    ON local_auth_password_resets(username)`,
  `CREATE INDEX IF NOT EXISTS local_auth_password_resets_expiry
    ON local_auth_password_resets(expires_at)`,
];

function storedUser(row: Record<string, unknown>): StoredLocalAuthUser {
  return {
    username: row.username as string,
    passwordHash: (row.password_hash as string | null) ?? null,
    bootstrapOpen: row.bootstrap_open === true,
    enabled: row.enabled === true,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_login_at == null ? {} : { lastLoginAt: Number(row.last_login_at) }),
  };
}

function listedUser(row: Record<string, unknown>): LocalAuthUser {
  return {
    username: row.username as string,
    enabled: row.enabled === true,
    passwordSet: row.password_set === true,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_login_at == null ? {} : { lastLoginAt: Number(row.last_login_at) }),
    activeSessions: Number(row.active_sessions),
  };
}

export function createPostgresLocalAuthPersistence(connectionString: string): LocalAuthPersistence {
  const pg = createPgPool(connectionString, SCHEMA);
  let nextPruneAt = Number.NEGATIVE_INFINITY;

  const prune = async (now: number): Promise<void> => {
    if (now < nextPruneAt) return;
    nextPruneAt = now + 60_000;
    await Promise.all([
      pg.query("DELETE FROM local_auth_sessions WHERE expires_at <= $1", [now]),
      pg.query("DELETE FROM local_auth_password_resets WHERE expires_at <= $1", [now]),
    ]);
  };

  return {
    durable: true,
    async createUserWithReset(username, tokenHash, now, expiresAt) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const result = await client.query(
          `INSERT INTO local_auth_users(username, password_hash, bootstrap_open, enabled, created_at, updated_at)
           VALUES ($1, NULL, FALSE, TRUE, $2, $2)
           ON CONFLICT(username) DO NOTHING`,
          [username, now],
        );
        if (result.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO local_auth_password_resets(token_hash, username, created_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [tokenHash, username, now, expiresAt],
        );
        return true;
      });
    },
    async bootstrapUserWithReset(username, tokenHash, now, expiresAt) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const inserted = await client.query(
          `INSERT INTO local_auth_users(username, password_hash, bootstrap_open, enabled, created_at, updated_at)
           VALUES ($1, NULL, TRUE, TRUE, $2, $2)
           ON CONFLICT(username) DO NOTHING`,
          [username, now],
        );
        if (inserted.rowCount === 1) {
          await client.query(
            `INSERT INTO local_auth_password_resets(token_hash, username, created_at, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [tokenHash, username, now, expiresAt],
          );
          return "created";
        }
        const locked = await client.query(
          `SELECT password_hash, bootstrap_open FROM local_auth_users WHERE username = $1 FOR UPDATE`,
          [username],
        );
        const user = locked.rows[0];
        if (user?.password_hash) return "ready";
        if (user?.bootstrap_open !== true) return "pending";
        await client.query("DELETE FROM local_auth_password_resets WHERE username = $1", [username]);
        await client.query(
          `INSERT INTO local_auth_password_resets(token_hash, username, created_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [tokenHash, username, now, expiresAt],
        );
        await client.query("UPDATE local_auth_users SET updated_at = $2 WHERE username = $1", [username, now]);
        return "refreshed";
      });
    },
    async getUser(username) {
      const rows = await pg.q(
        `SELECT username, password_hash, bootstrap_open, enabled, created_at, updated_at, last_login_at
         FROM local_auth_users WHERE username = $1`,
        [username],
      );
      return rows[0] ? storedUser(rows[0]) : null;
    },
    async listUsers(now) {
      await prune(now);
      const rows = await pg.q(
        `SELECT u.username, u.enabled, u.password_hash IS NOT NULL AS password_set,
                u.created_at, u.updated_at, u.last_login_at,
                count(s.token_hash)::int AS active_sessions
         FROM local_auth_users u
         LEFT JOIN local_auth_sessions s ON s.username = u.username AND s.expires_at > $1
         GROUP BY u.username, u.enabled, u.password_hash, u.created_at, u.updated_at, u.last_login_at
         ORDER BY u.username`,
        [now],
      );
      return rows.map(listedUser);
    },
    async commitLogin(input) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const locked = await client.query(
          `SELECT password_hash, enabled FROM local_auth_users WHERE username = $1 FOR UPDATE`,
          [input.username],
        );
        const user = locked.rows[0];
        if (!user || user.enabled !== true || user.password_hash !== input.expectedPasswordHash) return false;
        await client.query("UPDATE local_auth_users SET last_login_at = $2, updated_at = $2 WHERE username = $1", [
          input.username,
          input.now,
        ]);
        await client.query(
          `INSERT INTO local_auth_sessions(token_hash, username, created_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [input.tokenHash, input.username, input.now, input.expiresAt],
        );
        return true;
      });
    },
    async resolveSession(tokenHash, now) {
      await prune(now);
      const rows = await pg.q(
        `SELECT s.username, s.expires_at
         FROM local_auth_sessions s
         JOIN local_auth_users u ON u.username = s.username
         WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.enabled = TRUE`,
        [tokenHash, now],
      );
      if (!rows[0]) return null;
      return { username: rows[0].username as string, expiresAt: Number(rows[0].expires_at) } satisfies LocalAuthSession;
    },
    async revokeSession(tokenHash) {
      await pg.query("DELETE FROM local_auth_sessions WHERE token_hash = $1", [tokenHash]);
    },
    async setPassword(username, passwordHash, now) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const updated = await client.query(
          "UPDATE local_auth_users SET password_hash = $2, bootstrap_open = FALSE, updated_at = $3 WHERE username = $1",
          [username, passwordHash, now],
        );
        if (updated.rowCount !== 1) return false;
        await client.query("DELETE FROM local_auth_sessions WHERE username = $1", [username]);
        await client.query("DELETE FROM local_auth_password_resets WHERE username = $1", [username]);
        return true;
      });
    },
    async setEnabled(username, enabled, now) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const updated = await client.query(
          "UPDATE local_auth_users SET enabled = $2, updated_at = $3 WHERE username = $1",
          [username, enabled, now],
        );
        if (updated.rowCount !== 1) return false;
        if (!enabled) {
          await client.query("DELETE FROM local_auth_sessions WHERE username = $1", [username]);
          await client.query("DELETE FROM local_auth_password_resets WHERE username = $1", [username]);
        }
        return true;
      });
    },
    async beginPasswordReset(username, tokenHash, now, expiresAt) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const updated = await client.query(
          "UPDATE local_auth_users SET bootstrap_open = FALSE, updated_at = $2 WHERE username = $1",
          [username, now],
        );
        if (updated.rowCount !== 1) return false;
        await client.query("DELETE FROM local_auth_password_resets WHERE username = $1", [username]);
        await client.query(
          `INSERT INTO local_auth_password_resets(token_hash, username, created_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [tokenHash, username, now, expiresAt],
        );
        return true;
      });
    },
    async consumePasswordReset(input) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const candidate = await client.query("SELECT username FROM local_auth_password_resets WHERE token_hash = $1", [
          input.tokenHash,
        ]);
        const username = candidate.rows[0]?.username as string | undefined;
        if (!username) return null;
        const user = await client.query("SELECT enabled FROM local_auth_users WHERE username = $1 FOR UPDATE", [
          username,
        ]);
        if (user.rows[0]?.enabled !== true) return null;
        const reset = await client.query(
          `SELECT token_hash
           FROM local_auth_password_resets
           WHERE token_hash = $1 AND username = $2 AND expires_at > $3
           FOR UPDATE`,
          [input.tokenHash, username, input.now],
        );
        if (reset.rowCount !== 1) return null;
        await client.query(
          `UPDATE local_auth_users
           SET password_hash = $2, bootstrap_open = FALSE, last_login_at = $3, updated_at = $3
           WHERE username = $1`,
          [username, input.passwordHash, input.now],
        );
        await client.query("DELETE FROM local_auth_password_resets WHERE username = $1", [username]);
        await client.query("DELETE FROM local_auth_sessions WHERE username = $1", [username]);
        await client.query(
          `INSERT INTO local_auth_sessions(token_hash, username, created_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [input.sessionTokenHash, username, input.now, input.sessionExpiresAt],
        );
        return { username, expiresAt: input.sessionExpiresAt } satisfies LocalAuthSession;
      });
    },
  };
}
