import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Decrypter } from "age-encryption";
import { Client } from "pg";

export const REQUIRED_POSTGRES_SERVER_VERSION_NUM = 180004;

interface RestoreTarget {
  url: URL;
  database: string;
  env: NodeJS.ProcessEnv;
}

interface DatabaseAdminClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

interface DatabaseVerificationClient {
  connect(): Promise<void>;
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface IsolatedRestoreDatabase {
  database: string;
  databaseUrl: string;
  cleanup(): Promise<boolean>;
}

function maintenanceTarget(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    (database !== "postgres" && database !== "template1")
  ) {
    throw new Error("restore administration requires the postgres or template1 maintenance database");
  }
  return url;
}

export async function createIsolatedRestoreDatabase(input: {
  adminDatabaseUrl: string;
  suffix?: string;
  clientFactory?: (connectionString: string) => DatabaseAdminClient;
  now?: () => number;
}): Promise<IsolatedRestoreDatabase> {
  const adminUrl = maintenanceTarget(input.adminDatabaseUrl);
  const suffix = input.suffix ?? `${(input.now ?? Date.now)()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]{1,80}$/.test(suffix)) throw new Error("isolated restore database suffix is invalid");
  const database = `qm_restore_${suffix}`;
  const createClient = input.clientFactory ?? ((connectionString) => new Client({ connectionString }));
  const admin = createClient(adminUrl.toString());
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  target.searchParams.set("application_name", "qm-backup-restore");
  let cleaned = false;
  return {
    database,
    databaseUrl: target.toString(),
    async cleanup() {
      if (cleaned) return true;
      const cleanupClient = createClient(adminUrl.toString());
      await cleanupClient.connect();
      try {
        await cleanupClient.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        cleaned = true;
        return true;
      } finally {
        await cleanupClient.end();
      }
    },
  };
}

export function assertIsolatedRestoreTarget(databaseUrl: string, environment: NodeJS.ProcessEnv = {}): RestoreTarget {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !/^qm_restore_[a-z0-9_]+$/.test(database) ||
    url.searchParams.get("application_name") !== "qm-backup-restore"
  ) {
    throw new Error("database URL is not an explicit isolated restore target");
  }
  return {
    url,
    database,
    env: {
      ...environment,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database,
      ...(url.searchParams.get("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode")! } : {}),
    },
  };
}

async function defaultRunPgRestore(args: string[], env: NodeJS.ProcessEnv, source: Readable): Promise<void> {
  const process = spawn("pg_restore", args, { env, stdio: ["pipe", "ignore", "pipe"] });
  let stderrBytes = 0;
  process.stderr.on("data", (chunk) => {
    stderrBytes += Math.min(chunk.length, Math.max(0, 64 * 1024 - stderrBytes));
  });
  const exited = new Promise<void>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore failed with ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}`));
    });
  });
  try {
    await Promise.all([pipeline(source, process.stdin), exited]);
  } catch (error) {
    process.kill("SIGKILL");
    throw error;
  }
}

export async function restoreEncryptedDatabase(input: {
  encrypted: Uint8Array;
  identity: string;
  targetDatabaseUrl: string;
  environment?: NodeJS.ProcessEnv;
  runPgRestore?: (args: string[], env: NodeJS.ProcessEnv, source: Readable) => Promise<void>;
}): Promise<void> {
  const target = assertIsolatedRestoreTarget(input.targetDatabaseUrl, input.environment);
  const decrypter = new Decrypter();
  decrypter.addIdentity(input.identity);
  const encryptedSource = Readable.toWeb(Readable.from(Buffer.from(input.encrypted)), {
    strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.length },
  }) as ReadableStream<Uint8Array>;
  const plaintext = await decrypter.decrypt(encryptedSource);
  const args = ["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", target.database];
  await (input.runPgRestore ?? defaultRunPgRestore)(args, target.env, Readable.fromWeb(plaintext));
}

export async function verifyRestoredDatabase(input: {
  databaseUrl: string;
  expected: Record<string, string | number | boolean>;
  clientFactory?: (connectionString: string) => DatabaseVerificationClient;
}): Promise<{
  postgresServerVersionNum: number;
  postgresVersion: boolean;
  schema: boolean;
  rowBounds: boolean;
  timestamps: boolean;
  organization: boolean;
  applicationHealth: boolean;
}> {
  assertIsolatedRestoreTarget(input.databaseUrl);
  const client = input.clientFactory
    ? input.clientFactory(input.databaseUrl)
    : (new Client({ connectionString: input.databaseUrl }) as unknown as DatabaseVerificationClient);
  await client.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const version = await client.query<{ server_version_num: number }>(
      "SELECT current_setting('server_version_num')::int AS server_version_num",
    );
    const actualVersion = Number(version.rows[0]?.server_version_num ?? 0);
    const expected = requiredDatabaseInvariants(input.expected);
    const postgresVersion =
      expected.targetPostgresServerVersionNum === REQUIRED_POSTGRES_SERVER_VERSION_NUM &&
      actualVersion === REQUIRED_POSTGRES_SERVER_VERSION_NUM;
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const actualTables = new Set(tables.rows.map((row) => row.table_name));
    const { minimumTableCount, expectedRows, expectedTimestamps, requiredApplicationTables } = expected;
    const schema =
      tables.rows.length === minimumTableCount &&
      Object.keys(expectedRows).length === minimumTableCount &&
      Object.keys(expectedRows).every((table) => actualTables.has(table)) &&
      [...actualTables].every((table) => Object.hasOwn(expectedRows, table));
    let rowBounds = schema;
    for (const [table, expected] of Object.entries(expectedRows)) {
      const rows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`);
      if (rows.rows[0]?.count !== expected) rowBounds = false;
    }
    let timestamps = schema;
    for (const [key, expectedMaximum] of Object.entries(expectedTimestamps)) {
      const [table, column, extra] = key.split(".");
      if (!table || !column || extra || !safeIdentifier(table) || !safeIdentifier(column)) {
        throw new Error("expected database timestamp key is invalid");
      }
      const rows = await client.query<{ maximum: string | null }>(
        `SELECT CASE WHEN max("${column}") IS NULL THEN NULL ELSE floor(extract(epoch from max("${column}")) * 1000000)::text END AS maximum FROM "${table}"`,
      );
      if ((rows.rows[0]?.maximum ?? "") !== expectedMaximum) timestamps = false;
    }
    let organization = true;
    if (expected.organizationId) {
      const columns = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name IN ('organization_id', 'org_id')`,
      );
      organization = false;
      for (const column of columns.rows) {
        if (!/^[a-z_][a-z0-9_]*$/.test(column.table_name) || !/^[a-z_][a-z0-9_]*$/.test(column.column_name)) continue;
        const found = await client.query(
          `SELECT 1 FROM "${column.table_name}" WHERE "${column.column_name}" = $1 LIMIT 1`,
          [expected.organizationId],
        );
        if (found.rowCount) {
          organization = true;
          break;
        }
      }
    }
    let applicationHealth = requiredApplicationTables.length > 0;
    for (const table of requiredApplicationTables) {
      if (!actualTables.has(table)) {
        applicationHealth = false;
        continue;
      }
      const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`);
      if (result.rows[0]?.count !== expectedRows[table]) applicationHealth = false;
    }
    return {
      postgresServerVersionNum: actualVersion,
      postgresVersion,
      schema,
      rowBounds,
      timestamps,
      organization,
      applicationHealth,
    };
  } finally {
    await client.end();
  }
}

export function requiredDatabaseInvariants(input: Record<string, string | number | boolean>): {
  targetPostgresServerVersionNum: number;
  minimumTableCount: number;
  expectedRows: Record<string, string>;
  expectedTimestamps: Record<string, string>;
  requiredApplicationTables: string[];
  organizationId: string;
} {
  const targetPostgresServerVersionNum = Number(input.targetPostgresServerVersionNum);
  if (targetPostgresServerVersionNum !== REQUIRED_POSTGRES_SERVER_VERSION_NUM) {
    throw new Error("expected PostgreSQL server version is invalid");
  }
  const minimumTableCount = Number(input.minimumTableCount);
  if (!Number.isInteger(minimumTableCount) || minimumTableCount <= 0) {
    throw new Error("expected minimum table count is invalid");
  }
  const expectedRows = expectedNumericRecord(input.tableRowCountsJson, "table row counts", true);
  if (Object.keys(expectedRows).length !== minimumTableCount)
    throw new Error("expected table row counts are incomplete");
  const expectedTimestamps = expectedNumericRecord(input.tableMaxTimestampsJson, "table timestamps", true);
  const requiredApplicationTables = expectedIdentifierList(input.requiredApplicationTablesJson, "application tables");
  if (requiredApplicationTables.some((table) => !Object.hasOwn(expectedRows, table))) {
    throw new Error("expected application tables are not covered by row counts");
  }
  if (typeof input.organizationId !== "string" || !input.organizationId.trim()) {
    throw new Error("expected organization is invalid");
  }
  return {
    targetPostgresServerVersionNum,
    minimumTableCount,
    expectedRows,
    expectedTimestamps,
    requiredApplicationTables,
    organizationId: input.organizationId,
  };
}

function safeIdentifier(value: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(value);
}

function expectedNumericRecord(
  value: string | number | boolean | undefined,
  label: string,
  requireEntries = false,
): Record<string, string> {
  if (typeof value !== "string") return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`expected ${label} are invalid`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (!safeIdentifier(key) && !(key.includes(".") && key.split(".").every(safeIdentifier))) {
      throw new Error(`expected ${label} contain an invalid identifier`);
    }
    if (typeof item !== "string" || !/^[0-9]+$/.test(item)) throw new Error(`expected ${label} are invalid`);
    result[key] = item;
  }
  if (requireEntries && !Object.keys(result).length) throw new Error(`expected ${label} are incomplete`);
  return result;
}

function expectedIdentifierList(value: string | number | boolean | undefined, label: string): string[] {
  if (typeof value !== "string") return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((item) => typeof item !== "string" || !safeIdentifier(item))
  ) {
    throw new Error(`expected ${label} are invalid`);
  }
  return [...new Set(parsed)];
}
