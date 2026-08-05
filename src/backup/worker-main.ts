import { loadConfig } from "../config.ts";
import { createPostgresMapFactory } from "../persistence/durable-map.ts";
import { createBackupAuditStore } from "./audit-store.ts";
import { createBackupConfigStore, type StoredBackupConfiguration } from "./config-store.ts";
import { createRestoreDrillStore } from "./drill-store.ts";
import { createBackupJobStore, type BackupDeploymentLease, type BackupWorkerHeartbeat } from "./job-store.ts";
import type { BackupAuditEvent, BackupJob, RestoreDrill } from "./types.ts";
import { createBackupWorker, type BackupFilesystemInput } from "./worker.ts";

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for the backup worker`);
  return value.trim();
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function stringArray(value: string | undefined, name: string): string[] {
  const parsed: unknown = JSON.parse(required(value, name));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }
  return parsed.map((entry) => entry.trim());
}

function filesystemInputs(value: string | undefined, name: string): BackupFilesystemInput[] {
  const parsed: unknown = JSON.parse(required(value, name));
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${name} entry is invalid`);
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "source" && key !== "archiveRoot") ||
      typeof record.source !== "string" ||
      typeof record.archiveRoot !== "string" ||
      !record.source.trim() ||
      !record.archiveRoot.trim()
    ) {
      throw new Error(`${name} entry is invalid`);
    }
    return { source: record.source, archiveRoot: record.archiveRoot };
  });
}

const config = loadConfig();
const environment = config.layerEnv ?? {};
const databaseUrl = required(config.databaseUrl, "DATABASE_URL");
const connectorSecretKey = required(config.connectorSecretKey, "CONNECTOR_SECRET_KEY");
const maps = createPostgresMapFactory(databaseUrl);
const backupConfig = createBackupConfigStore(
  config.orgId,
  maps.map<StoredBackupConfiguration>("backup_configuration"),
  connectorSecretKey,
);
const jobs = createBackupJobStore(
  maps.map<BackupJob>("backup_jobs"),
  maps.map<BackupDeploymentLease>("backup_deployment_leases"),
  maps.map<BackupWorkerHeartbeat>("backup_worker_heartbeat"),
);
const drills = createRestoreDrillStore(maps.map<RestoreDrill>("backup_restore_drills"));
const audit = createBackupAuditStore(maps.map<BackupAuditEvent>("backup_audit_events"));
const worker = createBackupWorker(
  {
    organizationId: config.orgId,
    databaseUrl,
    scratchRoot: required(environment.BACKUP_SCRATCH_DIR, "BACKUP_SCRATCH_DIR"),
    operationalIdentityFile: required(environment.BACKUP_OPERATIONAL_IDENTITY_FILE, "BACKUP_OPERATIONAL_IDENTITY_FILE"),
    deploymentInputs: filesystemInputs(environment.BACKUP_DEPLOYMENT_INPUTS_JSON, "BACKUP_DEPLOYMENT_INPUTS_JSON"),
    secretInputs: filesystemInputs(environment.BACKUP_SECRET_INPUTS_JSON, "BACKUP_SECRET_INPUTS_JSON"),
    allowedRoots: stringArray(environment.BACKUP_ALLOWED_ROOTS_JSON, "BACKUP_ALLOWED_ROOTS_JSON"),
    sourceImages: stringArray(environment.BACKUP_SOURCE_IMAGES_JSON ?? "[]", "BACKUP_SOURCE_IMAGES_JSON"),
    sourceCommit: config.buildSha ?? "development",
    applicationVersion: environment.BACKUP_APPLICATION_VERSION ?? "0.1.0",
    ...(environment.BACKUP_RESTORE_ADMIN_DATABASE_URL
      ? { restoreAdminDatabaseUrl: environment.BACKUP_RESTORE_ADMIN_DATABASE_URL }
      : {}),
    environment,
    ...(environment.PG_DUMP_BIN ? { pgDumpBin: environment.PG_DUMP_BIN } : {}),
    pollMs: positiveInteger(environment.BACKUP_WORKER_POLL_MS, 1000, "BACKUP_WORKER_POLL_MS"),
    leaseTtlMs: positiveInteger(environment.BACKUP_WORKER_LEASE_TTL_MS, 120_000, "BACKUP_WORKER_LEASE_TTL_MS"),
    heartbeatMs: positiveInteger(environment.BACKUP_WORKER_HEARTBEAT_MS, 30_000, "BACKUP_WORKER_HEARTBEAT_MS"),
  },
  { config: backupConfig, jobs, drills, audit },
);

worker.start();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await maps.pool.close();
};

process.on("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.on("SIGINT", () => void stop().finally(() => process.exit(0)));
