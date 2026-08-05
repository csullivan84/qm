import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { inspectB2Destination } from "./b2-policy.ts";
import { captureEncryptedDatabase, createEncryptedAllowlistedTar } from "./capture.ts";
import type { BackupConfigStore, EffectiveBackupConfiguration } from "./config-store.ts";
import type { createRestoreDrillStore } from "./drill-store.ts";
import type { BackupJobStore } from "./job-store.ts";
import { createB2ObjectStore } from "./object-store.ts";
import { runBackupPipeline, type BackupDatabaseSnapshotMetadata } from "./pipeline.ts";
import { RestoreVerificationFailure, verifyBackupRestore } from "./restore-verifier.ts";
import type { createBackupAuditStore } from "./audit-store.ts";
import { REQUIRED_POSTGRES_SERVER_VERSION_NUM } from "./restore.ts";

type RestoreDrillStore = ReturnType<typeof createRestoreDrillStore>;
type BackupAuditStore = ReturnType<typeof createBackupAuditStore>;

export interface BackupFilesystemInput {
  source: string;
  archiveRoot: string;
}

export interface BackupWorkerSettings {
  organizationId: string;
  databaseUrl: string;
  scratchRoot: string;
  operationalIdentityFile: string;
  deploymentInputs: BackupFilesystemInput[];
  secretInputs: BackupFilesystemInput[];
  allowedRoots: string[];
  sourceImages: string[];
  sourceCommit: string;
  applicationVersion: string;
  restoreAdminDatabaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  pgDumpBin?: string;
  pollMs?: number;
  leaseTtlMs?: number;
  heartbeatMs?: number;
}

interface BackupWorkerDependencies {
  config: BackupConfigStore;
  jobs: BackupJobStore;
  drills: RestoreDrillStore;
  audit: BackupAuditStore;
  policyInspect?: typeof inspectB2Destination;
  objectStore?: typeof createB2ObjectStore;
  runPipeline?: typeof runBackupPipeline;
  verifyRestore?: typeof verifyBackupRestore;
  now?: () => number;
}

interface DatabaseSnapshotClient {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

async function privateIdentity(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("operational recovery identity must be a private regular file");
  }
  const identity = (await readFile(path, { encoding: "utf8" })).trim();
  if (!identity.startsWith("AGE-SECRET-KEY-")) throw new Error("operational recovery identity is invalid");
  return identity;
}

async function commandVersion(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const process = spawn(command, ["--version"], { env: environment, stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", resolve);
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdout) {
    size += chunk.length;
    if (size > 4096) {
      process.kill("SIGKILL");
      throw new Error("PostgreSQL client version output exceeded its limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  const code = await exited;
  if (code !== 0) throw new Error("PostgreSQL client version command failed");
  return Buffer.concat(chunks).toString("utf8").trim().slice(0, 100);
}

async function databaseMetadata(
  client: DatabaseSnapshotClient,
  organizationId: string,
  pgDumpBin: string,
  environment: NodeJS.ProcessEnv,
  readClientVersion: (command: string, environment: NodeJS.ProcessEnv) => Promise<string> = commandVersion,
): Promise<BackupDatabaseSnapshotMetadata> {
  const version = await client.query(
    "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num')::int AS server_version_num",
  );
  if (Number(version.rows[0]?.server_version_num) !== REQUIRED_POSTGRES_SERVER_VERSION_NUM) {
    throw new Error("backup database must use PostgreSQL server_version_num 180004");
  }
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const timestampColumns = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('timestamp with time zone', 'timestamp without time zone')
      ORDER BY table_name, column_name`,
  );
  const tableRowCounts: Record<string, string> = {};
  for (const row of tables.rows) {
    const table = String(row.table_name ?? "");
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("database table identifier is invalid");
    const count = await client.query(`SELECT count(*)::text AS count FROM "${table}"`);
    tableRowCounts[table] = String(count.rows[0]?.count ?? "0");
  }
  const tableMaxTimestamps: Record<string, string> = {};
  for (const row of timestampColumns.rows) {
    const table = String(row.table_name ?? "");
    const column = String(row.column_name ?? "");
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(column)) {
      throw new Error("database timestamp identifier is invalid");
    }
    const maximum = await client.query(
      `SELECT CASE WHEN max("${column}") IS NULL THEN NULL ELSE floor(extract(epoch from max("${column}")) * 1000000)::text END AS maximum FROM "${table}"`,
    );
    const value = maximum.rows[0]?.maximum;
    if (value) tableMaxTimestamps[`${table}.${column}`] = String(value);
  }
  const requiredApplicationTables = ["sessions", "session_entries", "runs"].filter((table) =>
    Object.hasOwn(tableRowCounts, table),
  );
  return {
    postgresServerVersion: String(version.rows[0]?.server_version ?? "unknown"),
    postgresClientVersion: await readClientVersion(pgDumpBin, environment),
    expectedDatabaseInvariants: {
      organizationId,
      targetPostgresServerVersionNum: REQUIRED_POSTGRES_SERVER_VERSION_NUM,
      minimumTableCount: tables.rows.length,
      tableRowCountsJson: JSON.stringify(tableRowCounts),
      tableMaxTimestampsJson: JSON.stringify(tableMaxTimestamps),
      requiredApplicationTablesJson: JSON.stringify(requiredApplicationTables),
    },
  };
}

export async function captureDatabaseSnapshot(input: {
  databaseUrl: string;
  organizationId: string;
  recipients: string[];
  outputPath: string;
  pgDumpBin: string;
  environment: NodeJS.ProcessEnv;
  clientFactory?: (databaseUrl: string) => DatabaseSnapshotClient;
  capture?: typeof captureEncryptedDatabase;
  readClientVersion?: (command: string, environment: NodeJS.ProcessEnv) => Promise<string>;
}): Promise<BackupDatabaseSnapshotMetadata> {
  const client = input.clientFactory
    ? input.clientFactory(input.databaseUrl)
    : (new Client({ connectionString: input.databaseUrl }) as unknown as DatabaseSnapshotClient);
  await client.connect();
  let active = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    active = true;
    await client.query("SET TIME ZONE 'UTC'");
    const exported = await client.query("SELECT pg_export_snapshot() AS snapshot_id");
    const snapshotId = String(exported.rows[0]?.snapshot_id ?? "");
    if (!/^[0-9a-f]+-[0-9a-f]+-[0-9]+$/i.test(snapshotId)) {
      throw new Error("PostgreSQL did not export a valid backup snapshot");
    }
    const metadata = await databaseMetadata(
      client,
      input.organizationId,
      input.pgDumpBin,
      input.environment,
      input.readClientVersion,
    );
    await (input.capture ?? captureEncryptedDatabase)({
      databaseUrl: input.databaseUrl,
      recipients: input.recipients,
      outputPath: input.outputPath,
      snapshotId,
      pgDumpBin: input.pgDumpBin,
      environment: input.environment,
    });
    await client.query("COMMIT");
    active = false;
    return metadata;
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function scheduleSlot(now: number, intervalMinutes: number): number {
  const interval = intervalMinutes * 60_000;
  return Math.floor(now / interval) * interval;
}

export function scheduledRetentionClass(scheduledFor: number, intervalMinutes: number): "hourly" | "daily" | "monthly" {
  const previous = scheduledFor - intervalMinutes * 60_000;
  const currentDate = new Date(scheduledFor);
  const previousDate = new Date(previous);
  if (
    currentDate.getUTCFullYear() !== previousDate.getUTCFullYear() ||
    currentDate.getUTCMonth() !== previousDate.getUTCMonth()
  ) {
    return "monthly";
  }
  if (currentDate.getUTCDate() !== previousDate.getUTCDate()) return "daily";
  return "hourly";
}

export function createBackupWorker(settings: BackupWorkerSettings, deps: BackupWorkerDependencies) {
  const now = deps.now ?? Date.now;
  const holder = `backup-worker:${randomUUID()}`;
  const pollMs = settings.pollMs ?? 1000;
  const leaseTtlMs = settings.leaseTtlMs ?? 120_000;
  const heartbeatMs = settings.heartbeatMs ?? 30_000;
  const environment = settings.environment ?? {};
  const pgDumpBin = settings.pgDumpBin ?? "pg_dump";
  let running = false;
  let stopped = true;
  let loop: Promise<void> | null = null;

  const audit = (action: string, resource: string, detail: Record<string, string | number | boolean | null>) =>
    deps.audit.record({
      organizationId: settings.organizationId,
      actor: holder,
      action,
      resource,
      detail,
    });

  const schedule = async (): Promise<void> => {
    const config = await deps.config.effective();
    if (
      !config ||
      !config.enabled ||
      config.suspended ||
      !config.configurationIncarnationId ||
      !config.recoveryKit?.acknowledgedAt
    )
      return;
    const scheduledFor = scheduleSlot(now(), config.scheduleIntervalMinutes);
    const retentionClass = scheduledRetentionClass(scheduledFor, config.scheduleIntervalMinutes);
    await deps.jobs.request({
      organizationId: settings.organizationId,
      deploymentId: config.deploymentId,
      configurationGeneration: config.generation,
      configurationIncarnationId: config.configurationIncarnationId,
      purpose: "scheduled",
      retentionClass,
      requestedBy: holder,
      idempotencyKey: `scheduled:${config.configurationIncarnationId}:${config.generation}:${scheduledFor}`,
      sourceRevision: settings.sourceCommit,
      scheduledFor,
    });
  };

  const heartbeat = async (generation: number, configurationIncarnationId?: string): Promise<void> => {
    await deps.jobs.workerHeartbeat(holder, generation, configurationIncarnationId);
  };

  const withLeaseHeartbeat = async <T>(
    jobId: string,
    token: string,
    generation: number,
    configurationIncarnationId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    let pending = Promise.resolve();
    let heartbeatError: unknown;
    const pulse = () => {
      pending = pending
        .then(() =>
          Promise.all([
            deps.jobs.heartbeat(jobId, token, leaseTtlMs),
            heartbeat(generation, configurationIncarnationId),
          ]).then(() => undefined),
        )
        .catch((error) => {
          heartbeatError = error;
        });
    };
    const timer = setInterval(pulse, heartbeatMs);
    timer.unref();
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      clearInterval(timer);
      await pending;
    }
    const job = await deps.jobs.get(jobId);
    if (heartbeatError && job?.leaseToken === token) throw heartbeatError;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  const withDrillHeartbeat = async <T>(
    drillId: string,
    token: string,
    generation: number,
    configurationIncarnationId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    let pending = Promise.resolve();
    const pulse = () => {
      pending = pending
        .then(() =>
          Promise.all([
            deps.drills.heartbeat(drillId, token, leaseTtlMs),
            heartbeat(generation, configurationIncarnationId),
          ]),
        )
        .then(() => undefined)
        .catch(() => undefined);
    };
    const timer = setInterval(pulse, heartbeatMs);
    timer.unref();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      await pending;
    }
  };

  const artifacts = () => ({
    async database(outputPath: string, recipients: string[]) {
      return captureDatabaseSnapshot({
        databaseUrl: settings.databaseUrl,
        organizationId: settings.organizationId,
        recipients,
        outputPath,
        pgDumpBin,
        environment,
      });
    },
    async deployment(outputPath: string, recipients: string[]) {
      await createEncryptedAllowlistedTar({
        inputs: settings.deploymentInputs,
        allowedRoots: settings.allowedRoots,
        recipients,
        outputPath,
      });
    },
    async secrets(outputPath: string, recipients: string[]) {
      await createEncryptedAllowlistedTar({
        inputs: settings.secretInputs,
        allowedRoots: settings.allowedRoots,
        recipients,
        outputPath,
      });
    },
  });

  const runBackup = async (): Promise<boolean> => {
    const claim = await deps.jobs.claim(holder, leaseTtlMs);
    if (!claim) return false;
    const config = await deps.config.effective();
    if (!config) {
      await deps.jobs.fail(claim.job.id, claim.token, { retryable: false, code: "configuration_missing" });
      return true;
    }
    if (
      !config.configurationIncarnationId ||
      claim.job.configurationGeneration !== config.generation ||
      claim.job.configurationIncarnationId !== config.configurationIncarnationId
    ) {
      await deps.jobs.fail(claim.job.id, claim.token, {
        retryable: false,
        code: "configuration_generation_mismatch",
      });
      return true;
    }
    let objectStore: ReturnType<typeof createB2ObjectStore> | undefined;
    try {
      const identity = await privateIdentity(settings.operationalIdentityFile);
      objectStore = (deps.objectStore ?? createB2ObjectStore)(config);
      const result = await withLeaseHeartbeat(
        claim.job.id,
        claim.token,
        config.generation,
        config.configurationIncarnationId,
        () =>
          (deps.runPipeline ?? runBackupPipeline)({
            claim,
            config: deps.config,
            jobs: deps.jobs,
            scratchRoot: settings.scratchRoot,
            policyInspect: (effective) => (deps.policyInspect ?? inspectB2Destination)(effective),
            artifacts: artifacts(),
            objectStore: objectStore!,
            sourceImages: settings.sourceImages,
            applicationVersion: settings.applicationVersion,
            ...(settings.restoreAdminDatabaseUrl
              ? {
                  fullVerify: (
                    archive: Buffer,
                    manifest: Parameters<typeof verifyBackupRestore>[0]["expectedManifest"],
                    _effective: EffectiveBackupConfiguration,
                  ) =>
                    (deps.verifyRestore ?? verifyBackupRestore)({
                      archive,
                      expectedArchiveSha256: claim.job.archiveSha256,
                      identity,
                      restoreAdminDatabaseUrl: settings.restoreAdminDatabaseUrl!,
                      environment,
                      expectedManifest: manifest,
                    }).then(() => undefined),
                }
              : {}),
            now,
          }),
      );
      await audit("backup.run.finished", result.id, {
        state: result.state,
        attemptCount: result.attemptCount,
        checksumMatches: result.checksumMatches ?? false,
      });
    } catch {
      const current = await deps.jobs.get(claim.job.id);
      if (current?.leaseToken === claim.token) {
        await deps.jobs.fail(claim.job.id, claim.token, {
          retryable: false,
          code: "worker_configuration_invalid",
        });
      }
      await audit("backup.run.failed", claim.job.id, { code: "worker_configuration_invalid" });
    } finally {
      objectStore?.close();
    }
    return true;
  };

  const runDrill = async (): Promise<boolean> => {
    const claim = await deps.drills.claim(holder, leaseTtlMs);
    if (!claim) return false;
    const startedAt = now();
    let cleanup = false;
    try {
      if (!settings.restoreAdminDatabaseUrl) throw new RestoreVerificationFailure("restore_target_unavailable", false);
      const [config, backup] = await Promise.all([deps.config.effective(), deps.jobs.get(claim.drill.sourceBackupId)]);
      if (
        !config ||
        !config.configurationIncarnationId ||
        claim.drill.configurationGeneration !== config.generation ||
        claim.drill.configurationIncarnationId !== config.configurationIncarnationId ||
        backup?.configurationGeneration !== config.generation ||
        backup?.configurationIncarnationId !== config.configurationIncarnationId ||
        backup.state !== "complete" ||
        !backup.objectKey ||
        !backup.objectVersionId ||
        !backup.archiveSha256 ||
        !backup.sizeBytes
      ) {
        throw new RestoreVerificationFailure("recovery_point_unavailable", false);
      }
      const identity = await privateIdentity(settings.operationalIdentityFile);
      const objectStore = (deps.objectStore ?? createB2ObjectStore)(config);
      try {
        const archive = await objectStore.download(backup.objectKey, backup.objectVersionId, backup.sizeBytes + 1);
        const proof = await withDrillHeartbeat(
          claim.drill.id,
          claim.token,
          config.generation,
          config.configurationIncarnationId,
          () =>
            (deps.verifyRestore ?? verifyBackupRestore)({
              archive,
              expectedArchiveSha256: backup.archiveSha256,
              identity,
              restoreAdminDatabaseUrl: settings.restoreAdminDatabaseUrl!,
              environment,
              now,
            }),
        );
        cleanup = proof.cleanup;
        await deps.drills.complete(claim.drill.id, claim.token, proof);
        await audit("backup.restore-drill.complete", claim.drill.id, {
          backupId: backup.id,
          durationMs: proof.durationMs,
          cleanup: proof.cleanup,
        });
      } finally {
        objectStore.close();
      }
    } catch (error) {
      if (error instanceof RestoreVerificationFailure) cleanup = error.cleanup;
      await deps.drills.fail(claim.drill.id, claim.token, "restore_drill_failed", cleanup);
      await audit("backup.restore-drill.failed", claim.drill.id, {
        durationMs: now() - startedAt,
        cleanup,
      });
    }
    return true;
  };

  const runOnce = async (): Promise<"backup" | "drill" | "idle"> => {
    await mkdir(settings.scratchRoot, { recursive: true, mode: 0o700 });
    const status = await deps.config.status();
    await heartbeat(status?.generation ?? 0, status?.configurationIncarnationId);
    await schedule();
    if (await runBackup()) return "backup";
    if (await runDrill()) return "drill";
    return "idle";
  };

  const runLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await runOnce();
      } catch (error) {
        console.error("[backup-worker] cycle failed:", error instanceof Error ? error.message : "unknown error");
      }
      if (!stopped) await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  };

  return {
    holder,
    runOnce,
    start() {
      if (running) return;
      running = true;
      stopped = false;
      loop = runLoop().finally(() => {
        running = false;
      });
    },
    async stop() {
      stopped = true;
      await loop;
    },
  };
}
