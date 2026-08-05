import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { samePerson } from "../directory/person.ts";

const LOCAL_AUTH_MIN_PASSWORD_CHARS = 12;
const LOCAL_AUTH_MAX_PASSWORD_BYTES = 256;
const LOCAL_AUTH_DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;
const LOCAL_AUTH_DEFAULT_RESET_TTL_MS = 60 * 60_000;
const LOCAL_AUTH_BOOTSTRAP_TTL_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_SCRYPT = { n: 131_072, r: 8, p: 1, keyLength: 32 };
const TOKEN_BYTES = 32;

export interface LocalAuthUser {
  username: string;
  enabled: boolean;
  passwordSet: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  activeSessions: number;
}

export interface LocalAuthSession {
  username: string;
  expiresAt: number;
}

export interface StoredLocalAuthUser {
  username: string;
  passwordHash: string | null;
  bootstrapOpen: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

export interface LocalAuthPersistence {
  readonly durable: boolean;
  createUserWithReset(username: string, tokenHash: string, now: number, expiresAt: number): Promise<boolean>;
  bootstrapUserWithReset(
    username: string,
    tokenHash: string,
    now: number,
    expiresAt: number,
  ): Promise<"created" | "refreshed" | "pending" | "ready">;
  getUser(username: string): Promise<StoredLocalAuthUser | null>;
  listUsers(now: number): Promise<LocalAuthUser[]>;
  commitLogin(input: {
    username: string;
    expectedPasswordHash: string;
    tokenHash: string;
    now: number;
    expiresAt: number;
  }): Promise<boolean>;
  resolveSession(tokenHash: string, now: number): Promise<LocalAuthSession | null>;
  revokeSession(tokenHash: string): Promise<void>;
  setPassword(username: string, passwordHash: string, now: number): Promise<boolean>;
  setEnabled(username: string, enabled: boolean, now: number): Promise<boolean>;
  beginPasswordReset(username: string, tokenHash: string, now: number, expiresAt: number): Promise<boolean>;
  consumePasswordReset(input: {
    tokenHash: string;
    passwordHash: string;
    sessionTokenHash: string;
    now: number;
    sessionExpiresAt: number;
  }): Promise<LocalAuthSession | null>;
}

export class LocalAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LocalAuthError";
    this.status = status;
  }
}

export interface PasswordHashCost {
  n: number;
  r: number;
  p: number;
  keyLength: number;
}

export interface LocalAuthServiceOptions {
  now?: () => number;
  passwordHashCost?: PasswordHashCost;
  sessionTtlMs?: number;
  resetTtlMs?: number;
  randomToken?: () => string;
}

export interface LocalAuthService {
  readonly durable: boolean;
  listUsers(): Promise<LocalAuthUser[]>;
  createUser(username: string): Promise<{ user: LocalAuthUser; setupCode: string; expiresAt: number }>;
  setPassword(username: string, password: string): Promise<void>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
  beginPasswordReset(username: string): Promise<{ setupCode: string; expiresAt: number }>;
  bootstrapAdmin(input: {
    username: string;
    setupCode: string;
    adminPrincipals: readonly string[];
  }): Promise<{ username: string; pending: boolean }>;
  authenticate(username: string, password: string): Promise<{ token: string; session: LocalAuthSession } | null>;
  resolveSession(token: string): Promise<LocalAuthSession | null>;
  revokeSession(token: string): Promise<void>;
  completePasswordReset(setupCode: string, password: string): Promise<{ token: string; session: LocalAuthSession }>;
}

export function normalizeLocalUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new LocalAuthError(400, "username must be 3 to 64 lowercase letters, numbers, dots, underscores, or hyphens");
  }
  return username;
}

function validateLocalPassword(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (password.length < LOCAL_AUTH_MIN_PASSWORD_CHARS) {
    throw new LocalAuthError(400, `password must be at least ${LOCAL_AUTH_MIN_PASSWORD_CHARS} characters`);
  }
  if (bytes > LOCAL_AUTH_MAX_PASSWORD_BYTES) {
    throw new LocalAuthError(400, `password must be at most ${LOCAL_AUTH_MAX_PASSWORD_BYTES} bytes`);
  }
}

function scryptKey(password: string, salt: Buffer, cost: PasswordHashCost): Promise<Buffer> {
  const maxmem = Math.max(32 * 1024 * 1024, 256 * cost.n * cost.r);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, cost.keyLength, { N: cost.n, r: cost.r, p: cost.p, maxmem }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashLocalPassword(password: string, cost: PasswordHashCost = DEFAULT_SCRYPT): Promise<string> {
  validateLocalPassword(password);
  const salt = randomBytes(16);
  const derived = await scryptKey(password, salt, cost);
  return ["", "scrypt", "1", cost.n, cost.r, cost.p, salt.toString("base64url"), derived.toString("base64url")].join(
    "$",
  );
}

function parsedPasswordHash(encoded: string): { cost: PasswordHashCost; salt: Buffer; expected: Buffer } | null {
  const parts = encoded.split("$");
  if (parts.length !== 8 || parts[0] !== "" || parts[1] !== "scrypt" || parts[2] !== "1") return null;
  const n = Number(parts[3]);
  const r = Number(parts[4]);
  const p = Number(parts[5]);
  let salt: Buffer;
  let expected: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(parts[6]!) || !/^[A-Za-z0-9_-]+$/.test(parts[7]!)) return null;
    salt = Buffer.from(parts[6]!, "base64url");
    expected = Buffer.from(parts[7]!, "base64url");
    if (salt.toString("base64url") !== parts[6] || expected.toString("base64url") !== parts[7]) return null;
  } catch {
    return null;
  }
  if (
    !Number.isInteger(n) ||
    n < 1024 ||
    n > 1_048_576 ||
    (n & (n - 1)) !== 0 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 16 ||
    n * r > DEFAULT_SCRYPT.n * DEFAULT_SCRYPT.r ||
    salt.length < 16 ||
    expected.length < 16 ||
    expected.length > 64
  ) {
    return null;
  }
  return { cost: { n, r, p, keyLength: expected.length }, salt, expected };
}

export async function verifyLocalPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsedPasswordHash(encoded);
  if (!parsed) return false;
  const tooLong = Buffer.byteLength(password, "utf8") > LOCAL_AUTH_MAX_PASSWORD_BYTES;
  const actual = await scryptKey(
    tooLong ? password.slice(0, LOCAL_AUTH_MAX_PASSWORD_BYTES) : password,
    parsed.salt,
    parsed.cost,
  );
  return !tooLong && actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

function tokenHash(label: string, token: string): string {
  return createHash("sha256").update(`${label}\0${token}`, "utf8").digest("base64url");
}

function userView(user: StoredLocalAuthUser, activeSessions = 0): LocalAuthUser {
  return {
    username: user.username,
    enabled: user.enabled,
    passwordSet: user.passwordHash !== null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    ...(user.lastLoginAt === undefined ? {} : { lastLoginAt: user.lastLoginAt }),
    activeSessions,
  };
}

export function createMemoryLocalAuthPersistence(): LocalAuthPersistence {
  const users = new Map<string, StoredLocalAuthUser>();
  const sessions = new Map<string, { username: string; expiresAt: number }>();
  const resets = new Map<string, { username: string; expiresAt: number }>();

  const revokeUserSessions = (username: string): void => {
    for (const [hash, session] of sessions) if (session.username === username) sessions.delete(hash);
  };
  const revokeUserResets = (username: string): void => {
    for (const [hash, reset] of resets) if (reset.username === username) resets.delete(hash);
  };
  const prune = (now: number): void => {
    for (const [hash, session] of sessions) if (session.expiresAt <= now) sessions.delete(hash);
    for (const [hash, reset] of resets) if (reset.expiresAt <= now) resets.delete(hash);
  };

  return {
    durable: false,
    async createUserWithReset(username, hash, now, expiresAt) {
      if (users.has(username)) return false;
      users.set(username, {
        username,
        passwordHash: null,
        bootstrapOpen: false,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      resets.set(hash, { username, expiresAt });
      return true;
    },
    async bootstrapUserWithReset(username, hash, now, expiresAt) {
      const user = users.get(username);
      if (!user) {
        users.set(username, {
          username,
          passwordHash: null,
          bootstrapOpen: true,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        });
        resets.set(hash, { username, expiresAt });
        return "created";
      }
      if (user.passwordHash) return "ready";
      if (!user.bootstrapOpen) return "pending";
      user.updatedAt = now;
      revokeUserResets(username);
      resets.set(hash, { username, expiresAt });
      return "refreshed";
    },
    async getUser(username) {
      return users.get(username) ?? null;
    },
    async listUsers(now) {
      prune(now);
      return [...users.values()]
        .map((user) =>
          userView(user, [...sessions.values()].filter((session) => session.username === user.username).length),
        )
        .sort((a, b) => a.username.localeCompare(b.username));
    },
    async commitLogin(input) {
      const user = users.get(input.username);
      if (!user || !user.enabled || user.passwordHash !== input.expectedPasswordHash) return false;
      user.lastLoginAt = input.now;
      user.updatedAt = input.now;
      sessions.set(input.tokenHash, { username: input.username, expiresAt: input.expiresAt });
      return true;
    },
    async resolveSession(hash, now) {
      prune(now);
      const session = sessions.get(hash);
      if (!session || !users.get(session.username)?.enabled) return null;
      return { username: session.username, expiresAt: session.expiresAt };
    },
    async revokeSession(hash) {
      sessions.delete(hash);
    },
    async setPassword(username, passwordHash, now) {
      const user = users.get(username);
      if (!user) return false;
      user.passwordHash = passwordHash;
      user.bootstrapOpen = false;
      user.updatedAt = now;
      revokeUserSessions(username);
      revokeUserResets(username);
      return true;
    },
    async setEnabled(username, enabled, now) {
      const user = users.get(username);
      if (!user) return false;
      user.enabled = enabled;
      user.updatedAt = now;
      if (!enabled) {
        revokeUserSessions(username);
        revokeUserResets(username);
      }
      return true;
    },
    async beginPasswordReset(username, hash, now, expiresAt) {
      const user = users.get(username);
      if (!user) return false;
      user.bootstrapOpen = false;
      user.updatedAt = now;
      revokeUserResets(username);
      resets.set(hash, { username, expiresAt });
      return true;
    },
    async consumePasswordReset(input) {
      prune(input.now);
      const reset = resets.get(input.tokenHash);
      if (!reset) return null;
      const user = users.get(reset.username);
      if (!user || !user.enabled) return null;
      user.passwordHash = input.passwordHash;
      user.bootstrapOpen = false;
      user.lastLoginAt = input.now;
      user.updatedAt = input.now;
      revokeUserResets(user.username);
      revokeUserSessions(user.username);
      sessions.set(input.sessionTokenHash, { username: user.username, expiresAt: input.sessionExpiresAt });
      return { username: user.username, expiresAt: input.sessionExpiresAt };
    },
  };
}

export function createLocalAuthService(
  persistence: LocalAuthPersistence = createMemoryLocalAuthPersistence(),
  options: LocalAuthServiceOptions = {},
): LocalAuthService {
  const now = options.now ?? Date.now;
  const passwordHashCost = options.passwordHashCost ?? DEFAULT_SCRYPT;
  const sessionTtlMs = options.sessionTtlMs ?? LOCAL_AUTH_DEFAULT_SESSION_TTL_MS;
  const resetTtlMs = options.resetTtlMs ?? LOCAL_AUTH_DEFAULT_RESET_TTL_MS;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0)
    throw new Error("local-auth session TTL must be positive");
  if (!Number.isSafeInteger(resetTtlMs) || resetTtlMs <= 0) throw new Error("local-auth reset TTL must be positive");
  const mintToken = options.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  const dummySalt = Buffer.alloc(16, 0x5a);

  const requireUser = async (rawUsername: string): Promise<StoredLocalAuthUser> => {
    const username = normalizeLocalUsername(rawUsername);
    const user = await persistence.getUser(username);
    if (!user) throw new LocalAuthError(404, "local user not found");
    return user;
  };

  const issueReset = async (username: string, ttlMs: number, setupCode = mintToken()) => {
    if (setupCode.length < 32) throw new LocalAuthError(400, "setup code must be at least 32 characters");
    const at = now();
    const expiresAt = at + ttlMs;
    const saved = await persistence.beginPasswordReset(
      username,
      tokenHash("local-password-reset-v1", setupCode),
      at,
      expiresAt,
    );
    if (!saved) throw new LocalAuthError(404, "local user not found");
    return { setupCode, expiresAt };
  };

  return {
    durable: persistence.durable,
    listUsers() {
      return persistence.listUsers(now());
    },
    async createUser(rawUsername) {
      const username = normalizeLocalUsername(rawUsername);
      const at = now();
      const setupCode = mintToken();
      const expiresAt = at + resetTtlMs;
      if (
        !(await persistence.createUserWithReset(
          username,
          tokenHash("local-password-reset-v1", setupCode),
          at,
          expiresAt,
        ))
      ) {
        throw new LocalAuthError(409, "local user already exists");
      }
      const stored = await persistence.getUser(username);
      return { user: userView(stored!), setupCode, expiresAt };
    },
    async setPassword(rawUsername, password) {
      const user = await requireUser(rawUsername);
      const passwordHash = await hashLocalPassword(password, passwordHashCost);
      if (!(await persistence.setPassword(user.username, passwordHash, now()))) {
        throw new LocalAuthError(404, "local user not found");
      }
    },
    async setEnabled(rawUsername, enabled) {
      const user = await requireUser(rawUsername);
      if (!(await persistence.setEnabled(user.username, enabled, now()))) {
        throw new LocalAuthError(404, "local user not found");
      }
    },
    async beginPasswordReset(rawUsername) {
      const user = await requireUser(rawUsername);
      return issueReset(user.username, resetTtlMs);
    },
    async bootstrapAdmin(input) {
      const username = normalizeLocalUsername(input.username);
      if (input.setupCode.length < 32) throw new LocalAuthError(400, "setup code must be at least 32 characters");
      if (!input.adminPrincipals.some((principal) => samePerson(principal, username))) {
        throw new LocalAuthError(400, "bootstrap user must already hold an admin grant");
      }
      const at = now();
      const state = await persistence.bootstrapUserWithReset(
        username,
        tokenHash("local-password-reset-v1", input.setupCode),
        at,
        at + LOCAL_AUTH_BOOTSTRAP_TTL_MS,
      );
      return { username, pending: state !== "ready" };
    },
    async authenticate(rawUsername, password) {
      const username = (() => {
        try {
          return normalizeLocalUsername(rawUsername);
        } catch {
          return null;
        }
      })();
      const user = username ? await persistence.getUser(username) : null;
      const usableHash = user?.passwordHash ?? null;
      const verified = usableHash
        ? await verifyLocalPassword(password, usableHash)
        : await scryptKey("local-auth-dummy-password", dummySalt, passwordHashCost).then(() => false);
      if (!user || !user.enabled || !usableHash || !verified) return null;
      const token = mintToken();
      const at = now();
      const session = { username: user.username, expiresAt: at + sessionTtlMs };
      const committed = await persistence.commitLogin({
        username: user.username,
        expectedPasswordHash: usableHash,
        tokenHash: tokenHash("local-session-v1", token),
        now: at,
        expiresAt: session.expiresAt,
      });
      return committed ? { token, session } : null;
    },
    resolveSession(token) {
      if (!token || token.length > 256) return Promise.resolve(null);
      return persistence.resolveSession(tokenHash("local-session-v1", token), now());
    },
    revokeSession(token) {
      if (!token || token.length > 256) return Promise.resolve();
      return persistence.revokeSession(tokenHash("local-session-v1", token));
    },
    async completePasswordReset(setupCode, password) {
      if (!setupCode || setupCode.length > 256) throw new LocalAuthError(400, "invalid or expired setup code");
      const passwordHash = await hashLocalPassword(password, passwordHashCost);
      const token = mintToken();
      const at = now();
      const session = await persistence.consumePasswordReset({
        tokenHash: tokenHash("local-password-reset-v1", setupCode),
        passwordHash,
        sessionTokenHash: tokenHash("local-session-v1", token),
        now: at,
        sessionExpiresAt: at + sessionTtlMs,
      });
      if (!session) throw new LocalAuthError(400, "invalid or expired setup code");
      return { token, session };
    },
  };
}
