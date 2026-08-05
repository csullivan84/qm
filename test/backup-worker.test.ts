import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateRecoveryIdentity } from "../src/backup/age.ts";
import { createBackupAuditStore } from "../src/backup/audit-store.ts";
import { createBackupConfigStore, type StoredBackupConfiguration } from "../src/backup/config-store.ts";
import { createRestoreDrillStore } from "../src/backup/drill-store.ts";
import {
  createBackupJobStore,
  type BackupDeploymentLease,
  type BackupWorkerHeartbeat,
} from "../src/backup/job-store.ts";
import type { BackupAuditEvent, BackupJob, RestoreDrill } from "../src/backup/types.ts";
import { captureDatabaseSnapshot, createBackupWorker, scheduledRetentionClass } from "../src/backup/worker.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";

test("backup worker schedules each interval exactly once and publishes its durable heartbeat", async () => {
  const now = Date.UTC(2026, 7, 4, 12, 10, 0);
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-worker-"));
  try {
    const operational = await generateRecoveryIdentity();
    const offline = await generateRecoveryIdentity();
    const identityFile = join(directory, "operational.agekey");
    await writeFile(identityFile, operational.identity, { mode: 0o600 });
    const config = createBackupConfigStore(
      "default-org",
      createMemoryMap<StoredBackupConfiguration>(),
      Buffer.alloc(32, 7),
      () => now,
    );
    await config.set(
      {
        enabled: true,
        deploymentId: "qm",
        endpoint: "https://s3.us-west-004.backblazeb2.com",
        bucket: "qm-backups-test",
        prefix: "qm/production",
        keyId: "key",
        applicationKey: "application-key",
        operationalRecipient: operational.recipient,
        scheduleIntervalMinutes: 60,
        retention: { hourlyDays: 7, dailyDays: 35, monthlyDays: 400, predeployDays: 30, manualDays: 90 },
        objectLock: { required: true, mode: "GOVERNANCE", minimumDays: 30 },
      },
      "admin",
      null,
      null,
      configurationIncarnationId,
    );
    await config.setOfflineRecipient(offline.recipient, offline.fingerprint, "admin", 1, configurationIncarnationId);
    await config.markKitIssued(offline.fingerprint, "admin", 2, configurationIncarnationId, now);
    await config.acknowledgeKit(offline.fingerprint, "admin", now);
    const jobMap = createMemoryMap<BackupJob>();
    const jobs = createBackupJobStore(
      jobMap,
      createMemoryMap<BackupDeploymentLease>(),
      createMemoryMap<BackupWorkerHeartbeat>(),
      () => now,
    );
    const drills = createRestoreDrillStore(createMemoryMap<RestoreDrill>(), () => now);
    const audit = createBackupAuditStore(createMemoryMap<BackupAuditEvent>(), () => now);
    const worker = createBackupWorker(
      {
        organizationId: "default-org",
        databaseUrl: "postgresql://qm:secret@postgres/qm",
        scratchRoot: join(directory, "scratch"),
        operationalIdentityFile: identityFile,
        deploymentInputs: [],
        secretInputs: [],
        allowedRoots: [directory],
        sourceImages: [],
        sourceCommit: "a".repeat(40),
        applicationVersion: "0.1.0",
      },
      {
        config,
        jobs,
        drills,
        audit,
        now: () => now,
        objectStore: () => ({
          async probe() {
            return null;
          },
          async upload(_key, bytes, sha256) {
            return { versionId: "version-1", sizeBytes: bytes.length, sha256 };
          },
          async verify(_key, versionId, sizeBytes, sha256) {
            return { versionId, sizeBytes, sha256 };
          },
          async download() {
            return Buffer.alloc(0);
          },
          async list() {
            return [];
          },
          close() {},
        }),
        runPipeline: async ({ claim, jobs: store }) => {
          await store.transition(claim.job.id, claim.token, "dumping");
          await store.transition(claim.job.id, claim.token, "encrypting");
          await store.transition(claim.job.id, claim.token, "uploading");
          await store.recordUpload(claim.job.id, claim.token, {
            objectKey: "qm/production/object",
            objectVersionId: "version-1",
            sizeBytes: 10,
            archiveSha256: "b".repeat(64),
          });
          await store.transition(claim.job.id, claim.token, "verifying");
          return store.complete(claim.job.id, claim.token, {
            objectKey: "qm/production/object",
            objectVersionId: "version-1",
            sizeBytes: 10,
            archiveSha256: "b".repeat(64),
            verifiedAt: now,
            checksumMatches: true,
          });
        },
      },
    );

    assert.equal(await worker.runOnce(), "backup");
    assert.equal(await worker.runOnce(), "idle");
    const stored = await jobs.list("default-org");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.state, "complete");
    assert.equal(stored[0]?.configurationGeneration, 2);
    assert.equal((await jobs.latestWorkerHeartbeat())?.at, now);
    assert.equal(
      (await audit.list("default-org")).some((event) => event.action === "backup.run.finished"),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduled retention advances from hourly to daily and monthly at UTC boundaries", () => {
  assert.equal(scheduledRetentionClass(Date.UTC(2026, 7, 4, 12), 60), "hourly");
  assert.equal(scheduledRetentionClass(Date.UTC(2026, 7, 4, 0), 60), "daily");
  assert.equal(scheduledRetentionClass(Date.UTC(2026, 7, 1, 0), 60), "monthly");
  assert.equal(scheduledRetentionClass(Date.UTC(2027, 0, 1, 0), 90), "monthly");
});

test("database dump and exact invariants share one exported PostgreSQL snapshot", async () => {
  const operations: string[] = [];
  const client = {
    async connect() {
      operations.push("CONNECT");
    },
    async query(text: string) {
      operations.push(text);
      if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot_id: "00000003-0000001b-1" }] };
      if (text.includes("server_version_num")) {
        return { rows: [{ server_version: "18.4", server_version_num: 180004 }] };
      }
      if (text.includes("information_schema.tables")) return { rows: [{ table_name: "sessions" }] };
      if (text.includes("information_schema.columns")) {
        return { rows: [{ table_name: "sessions", column_name: "updated_at" }] };
      }
      if (text.includes("count(*)")) return { rows: [{ count: "2" }] };
      if (text.includes("max(")) return { rows: [{ maximum: "1785890000000000" }] };
      return { rows: [] };
    },
    async end() {
      operations.push("END");
    },
  };
  let capturedSnapshot = "";
  const metadata = await captureDatabaseSnapshot({
    databaseUrl: "postgresql://qm:secret@postgres/qm",
    organizationId: "default-org",
    recipients: ["age1recipient"],
    outputPath: "/private/recovery/database.dump.age",
    pgDumpBin: "pg_dump",
    environment: {},
    clientFactory: () => client,
    readClientVersion: async () => "pg_dump (PostgreSQL) 18.4",
    capture: async (input) => {
      operations.push("CAPTURE");
      capturedSnapshot = input.snapshotId ?? "";
      return { sizeBytes: 1 };
    },
  });

  assert.equal(capturedSnapshot, "00000003-0000001b-1");
  assert.equal(metadata.expectedDatabaseInvariants.tableRowCountsJson, JSON.stringify({ sessions: "2" }));
  assert.equal(
    metadata.expectedDatabaseInvariants.tableMaxTimestampsJson,
    JSON.stringify({ "sessions.updated_at": "1785890000000000" }),
  );
  assert.ok(operations.indexOf("SELECT pg_export_snapshot() AS snapshot_id") < operations.indexOf("CAPTURE"));
  assert.ok(operations.indexOf("CAPTURE") < operations.indexOf("COMMIT"));
  assert.equal(operations.at(-1), "END");
});

test("database snapshot transaction rolls back when pg_dump capture fails", async () => {
  const operations: string[] = [];
  const client = {
    async connect() {},
    async query(text: string) {
      operations.push(text);
      if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot_id: "00000003-0000001b-1" }] };
      if (text.includes("server_version_num")) {
        return { rows: [{ server_version: "18.4", server_version_num: 180004 }] };
      }
      if (text.includes("information_schema.tables")) return { rows: [{ table_name: "sessions" }] };
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("count(*)")) return { rows: [{ count: "2" }] };
      return { rows: [] };
    },
    async end() {
      operations.push("END");
    },
  };

  await assert.rejects(
    captureDatabaseSnapshot({
      databaseUrl: "postgresql://qm:secret@postgres/qm",
      organizationId: "default-org",
      recipients: ["age1recipient"],
      outputPath: "/private/recovery/database.dump.age",
      pgDumpBin: "pg_dump",
      environment: {},
      clientFactory: () => client,
      readClientVersion: async () => "pg_dump (PostgreSQL) 18.4",
      capture: async () => {
        throw new Error("pg_dump failed");
      },
    }),
    /pg_dump failed/,
  );
  assert.ok(operations.includes("ROLLBACK"));
  assert.equal(operations.at(-1), "END");
});
