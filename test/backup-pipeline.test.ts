import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateRecoveryIdentity } from "../src/backup/age.ts";
import { MAX_BACKUP_COMPONENT_BYTES } from "../src/backup/archive.ts";
import { createBackupConfigStore, type StoredBackupConfiguration } from "../src/backup/config-store.ts";
import {
  createBackupJobStore,
  type BackupDeploymentLease,
  type BackupJob,
  type BackupWorkerHeartbeat,
} from "../src/backup/job-store.ts";
import { runBackupPipeline } from "../src/backup/pipeline.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";

async function setup(generationOffset = 0) {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  const operational = await generateRecoveryIdentity();
  const offline = await generateRecoveryIdentity();
  const config = createBackupConfigStore(
    "default-org",
    createMemoryMap<StoredBackupConfiguration>(),
    Buffer.alloc(32, 8),
    () => now,
  );
  await config.set(
    {
      enabled: true,
      deploymentId: "example-host",
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
  const status = (await config.status())!;
  const generation = status.generation;
  const jobs = createBackupJobStore(
    createMemoryMap<BackupJob>(),
    createMemoryMap<BackupDeploymentLease>(),
    createMemoryMap<BackupWorkerHeartbeat>(),
    () => now,
  );
  const job = await jobs.request({
    organizationId: "default-org",
    deploymentId: "example-host",
    configurationGeneration: generation + generationOffset,
    configurationIncarnationId: status.configurationIncarnationId!,
    purpose: "manual",
    retentionClass: "manual",
    requestedBy: "admin",
    idempotencyKey: "manual-proof",
    sourceRevision: "a".repeat(40),
  });
  const claim = await jobs.claim("worker", 600_000);
  assert.ok(claim);
  return { now, config, jobs, job, claim };
}

test("backup pipeline refuses work from another configuration generation before destination access", async () => {
  const state = await setup(-1);
  const scratchRoot = await mkdtemp(join(tmpdir(), "qm-backup-generation-"));
  let destinationAccesses = 0;
  try {
    const result = await runBackupPipeline({
      claim: state.claim,
      config: state.config,
      jobs: state.jobs,
      scratchRoot,
      async policyInspect() {
        destinationAccesses++;
        throw new Error("unexpected destination policy access");
      },
      artifacts: {
        async database() {
          throw new Error("unexpected database access");
        },
        async deployment() {
          throw new Error("unexpected deployment access");
        },
        async secrets() {
          throw new Error("unexpected secrets access");
        },
      },
      objectStore: {
        async probe() {
          destinationAccesses++;
          return null;
        },
        async upload() {
          throw new Error("unexpected upload");
        },
        async verify() {
          throw new Error("unexpected verification");
        },
        async download() {
          throw new Error("unexpected download");
        },
      },
      sourceImages: [],
      applicationVersion: "0.1.0",
      now: () => state.now,
    });
    assert.equal(result.state, "terminal_failure");
    assert.equal(result.errorCode, "configuration_generation_mismatch");
    assert.equal(result.configurationGeneration, 1);
    assert.equal(destinationAccesses, 0);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test("backup pipeline captures encrypted components, uploads once, verifies fully, and cleans scratch", async () => {
  const state = await setup();
  const scratchRoot = await mkdtemp(join(tmpdir(), "qm-backup-pipeline-"));
  const objects = new Map<string, { bytes: Buffer; sha256: string; immutableUntil?: number; versionId: string }>();
  let fullVerifications = 0;
  try {
    const result = await runBackupPipeline({
      claim: state.claim,
      config: state.config,
      jobs: state.jobs,
      scratchRoot,
      policyInspect: async () => ({
        checkedAt: state.now,
        reachable: "pass",
        private: "pass",
        bucketScoped: "pass",
        leastPrivilege: "pass",
        serverSideEncryption: "pass",
        lifecycle: "pass",
        objectLock: "unavailable",
      }),
      artifacts: {
        async database(outputPath) {
          await writeFile(outputPath, "encrypted database", { mode: 0o600 });
          return {
            postgresServerVersion: "18.4",
            postgresClientVersion: "18.4",
            expectedDatabaseInvariants: { organizationId: "default-org", minimumTableCount: 1 },
          };
        },
        async deployment(outputPath) {
          await writeFile(outputPath, "encrypted deployment", { mode: 0o600 });
        },
        async secrets(outputPath) {
          await writeFile(outputPath, "encrypted secrets", { mode: 0o600 });
        },
      },
      objectStore: {
        async probe(key) {
          const object = objects.get(key);
          return object
            ? {
                versionId: object.versionId,
                sizeBytes: object.bytes.length,
                sha256: object.sha256,
                ...(object.immutableUntil ? { immutableUntil: object.immutableUntil } : {}),
              }
            : null;
        },
        async upload(key, bytes, sha256, immutableUntil) {
          assert.equal(objects.has(key), false);
          objects.set(key, { bytes: Buffer.from(bytes), sha256, immutableUntil, versionId: "v1" });
          return { versionId: "v1", sizeBytes: bytes.length, sha256, immutableUntil };
        },
        async verify(key, versionId, sizeBytes, sha256, immutableUntil) {
          const object = objects.get(key)!;
          assert.equal(versionId, object.versionId);
          assert.equal(object.bytes.length, sizeBytes);
          assert.equal(object.sha256, sha256);
          assert.equal(object.immutableUntil, immutableUntil);
          return { versionId: object.versionId, sizeBytes, sha256, immutableUntil };
        },
        async download(key, versionId) {
          assert.equal(versionId, objects.get(key)!.versionId);
          return objects.get(key)!.bytes;
        },
      },
      sourceImages: ["localhost/qm@sha256:" + "b".repeat(64)],
      applicationVersion: "0.1.0",
      async fullVerify(bytes, manifest) {
        fullVerifications++;
        assert.ok(bytes.length > 0);
        assert.equal(manifest.jobId, state.job.id);
      },
      now: () => state.now,
    });

    assert.equal(result.state, "complete");
    assert.equal(result.checksumMatches, true);
    assert.equal(fullVerifications, 1);
    assert.equal(objects.size, 1);
    assert.deepEqual(await readdir(scratchRoot), []);
    assert.equal((await state.config.status())?.validation?.objectLock, "unavailable");
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test("backup pipeline fails closed on a pre-existing ambiguous object and never overwrites it", async () => {
  const state = await setup();
  const scratchRoot = await mkdtemp(join(tmpdir(), "qm-backup-collision-"));
  let uploads = 0;
  try {
    const result = await runBackupPipeline({
      claim: state.claim,
      config: state.config,
      jobs: state.jobs,
      scratchRoot,
      policyInspect: async () => ({
        checkedAt: state.now,
        reachable: "pass",
        private: "pass",
        bucketScoped: "pass",
        leastPrivilege: "pass",
        serverSideEncryption: "pass",
        lifecycle: "pass",
        objectLock: "pass",
      }),
      artifacts: {
        async database(outputPath) {
          await mkdir(join(outputPath, ".."), { recursive: true });
          await writeFile(outputPath, "database");
          return {
            postgresServerVersion: "18.4",
            postgresClientVersion: "18.4",
            expectedDatabaseInvariants: { minimumTableCount: 1 },
          };
        },
        async deployment(outputPath) {
          await writeFile(outputPath, "deployment");
        },
        async secrets(outputPath) {
          await writeFile(outputPath, "secrets");
        },
      },
      objectStore: {
        async probe() {
          return { versionId: "foreign", sizeBytes: 1, sha256: "f".repeat(64) };
        },
        async upload() {
          uploads++;
          throw new Error("must not upload");
        },
        async verify() {
          throw new Error("must not verify");
        },
        async download() {
          throw new Error("must not download");
        },
      },
      sourceImages: [],
      applicationVersion: "0.1.0",
      now: () => state.now,
    });
    assert.equal(result.state, "terminal_failure");
    assert.equal(result.errorCode, "object_key_collision");
    assert.equal(uploads, 0);
    assert.deepEqual(await readdir(scratchRoot), []);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test("backup pipeline rejects oversized encrypted components before loading them into memory", async () => {
  const state = await setup();
  const scratchRoot = await mkdtemp(join(tmpdir(), "qm-backup-size-limit-"));
  let uploads = 0;
  try {
    const result = await runBackupPipeline({
      claim: state.claim,
      config: state.config,
      jobs: state.jobs,
      scratchRoot,
      policyInspect: async () => ({
        checkedAt: state.now,
        reachable: "pass",
        private: "pass",
        bucketScoped: "pass",
        leastPrivilege: "pass",
        serverSideEncryption: "pass",
        lifecycle: "pass",
        objectLock: "pass",
      }),
      artifacts: {
        async database(outputPath) {
          await writeFile(outputPath, "");
          await truncate(outputPath, MAX_BACKUP_COMPONENT_BYTES + 1);
          return {
            postgresServerVersion: "18.4",
            postgresClientVersion: "18.4",
            expectedDatabaseInvariants: { minimumTableCount: 1 },
          };
        },
        async deployment(outputPath) {
          await writeFile(outputPath, "");
        },
        async secrets(outputPath) {
          await writeFile(outputPath, "");
        },
      },
      objectStore: {
        async probe() {
          return null;
        },
        async upload() {
          uploads++;
          throw new Error("must not upload");
        },
        async verify() {
          throw new Error("must not verify");
        },
        async download() {
          throw new Error("must not download");
        },
      },
      sourceImages: [],
      applicationVersion: "0.1.0",
      now: () => state.now,
    });

    assert.equal(result.state, "terminal_failure");
    assert.equal(result.errorCode, "archive_size_limit");
    assert.equal(uploads, 0);
    assert.deepEqual(await readdir(scratchRoot), []);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});
