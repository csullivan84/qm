import assert from "node:assert/strict";
import test from "node:test";
import {
  createBackupJobStore,
  type BackupDeploymentLease,
  type BackupJob,
  type BackupWorkerHeartbeat,
} from "../src/backup/job-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";

test("backup jobs are idempotent, lease-exclusive, heartbeat-renewed, and safely reclaimable", async () => {
  let now = 1000;
  const store = createBackupJobStore(
    createMemoryMap<BackupJob>(),
    createMemoryMap<BackupDeploymentLease>(),
    createMemoryMap<BackupWorkerHeartbeat>(),
    () => now,
  );
  const requested = await store.request({
    organizationId: "default-org",
    deploymentId: "example-host",
    configurationGeneration: 7,
    configurationIncarnationId,
    purpose: "manual",
    retentionClass: "manual",
    requestedBy: "admin",
    idempotencyKey: "manual-1",
    sourceRevision: "a".repeat(40),
  });
  assert.equal(
    (
      await store.request({
        organizationId: "default-org",
        deploymentId: "example-host",
        configurationGeneration: 7,
        configurationIncarnationId,
        purpose: "manual",
        retentionClass: "manual",
        requestedBy: "admin",
        idempotencyKey: "manual-1",
        sourceRevision: "a".repeat(40),
      })
    ).id,
    requested.id,
  );

  const first = await store.claim("worker-a", 100);
  assert.ok(first);
  assert.equal(first.job.state, "preparing");
  assert.equal(first.job.configurationGeneration, 7);
  assert.equal(await store.claim("worker-b", 100), null);
  await store.transition(first.job.id, first.token, "dumping");
  now = 1050;
  await store.heartbeat(first.job.id, first.token, 100);
  now = 1120;
  assert.equal(await store.claim("worker-b", 100), null);

  now = 1200;
  const reclaimed = await store.claim("worker-b", 100);
  assert.ok(reclaimed);
  assert.equal(reclaimed.job.id, requested.id);
  assert.equal(reclaimed.job.configurationGeneration, 7);
  assert.equal(reclaimed.job.attemptCount, 2);
  await assert.rejects(store.transition(requested.id, first.token, "uploading"), /lease/);
  await store.transition(requested.id, reclaimed.token, "dumping");
  await store.transition(requested.id, reclaimed.token, "encrypting");
  await store.transition(requested.id, reclaimed.token, "uploading");
  await store.recordUpload(requested.id, reclaimed.token, {
    objectKey: "qm/qm-backup/v1/example-host/manual/point.qmbackup",
    objectVersionId: "v1",
    sizeBytes: 123,
    archiveSha256: "b".repeat(64),
    immutableUntil: now + 1000,
  });
  await store.transition(requested.id, reclaimed.token, "verifying");
  await assert.rejects(
    store.complete(requested.id, reclaimed.token, {
      objectKey: "qm/qm-backup/v1/example-host/manual/point.qmbackup",
      objectVersionId: "v2",
      sizeBytes: 123,
      archiveSha256: "b".repeat(64),
      verifiedAt: now,
      checksumMatches: true,
    }),
    /pinned uploaded version/,
  );
  await store.complete(requested.id, reclaimed.token, {
    objectKey: "qm/qm-backup/v1/example-host/manual/point.qmbackup",
    objectVersionId: "v1",
    sizeBytes: 123,
    archiveSha256: "b".repeat(64),
    verifiedAt: now,
    checksumMatches: true,
    immutableUntil: now + 1000,
  });
  assert.equal((await store.get(requested.id))?.state, "complete");
});

test("retryable failure preserves the stable job and object identity", async () => {
  let now = 1000;
  const store = createBackupJobStore(
    createMemoryMap<BackupJob>(),
    createMemoryMap<BackupDeploymentLease>(),
    createMemoryMap<BackupWorkerHeartbeat>(),
    () => now,
  );
  const job = await store.request({
    organizationId: "default-org",
    deploymentId: "example-host",
    configurationGeneration: 7,
    configurationIncarnationId,
    purpose: "scheduled",
    retentionClass: "hourly",
    requestedBy: "scheduler",
    idempotencyKey: "schedule-1",
    sourceRevision: "a".repeat(40),
  });
  const claim = await store.claim("worker", 100);
  assert.ok(claim);
  await store.fail(job.id, claim.token, { retryable: true, code: "destination_unavailable", retryAfter: 1200 });
  assert.equal((await store.get(job.id))?.state, "retryable_failure");
  now = 1199;
  assert.equal(await store.claim("worker", 100), null);
  now = 1200;
  const reclaimed = await store.claim("worker", 100);
  assert.equal(reclaimed?.job.id, job.id);
  assert.equal(reclaimed?.job.configurationGeneration, 7);
  assert.ok(reclaimed);
  await store.fail(job.id, reclaimed.token, { retryable: false, code: "manual_intervention" });
  const retried = await store.retry(job.id);
  assert.equal(retried.state, "queued");
  assert.equal(retried.configurationGeneration, 7);
});

test("backup job idempotency cannot cross configuration generations", async () => {
  const store = createBackupJobStore(
    createMemoryMap<BackupJob>(),
    createMemoryMap<BackupDeploymentLease>(),
    createMemoryMap<BackupWorkerHeartbeat>(),
  );
  const request = {
    organizationId: "default-org",
    deploymentId: "example-host",
    configurationGeneration: 7,
    configurationIncarnationId,
    purpose: "predeploy" as const,
    retentionClass: "predeploy" as const,
    requestedBy: "admin",
    idempotencyKey: "predeploy-one",
    sourceRevision: "a".repeat(40),
  };
  await store.request(request);
  await assert.rejects(store.request({ ...request, configurationGeneration: 8 }), /idempotency key conflicts/);
  await assert.rejects(
    store.request({ ...request, configurationIncarnationId: "00000000-0000-4000-8000-000000000002" }),
    /idempotency key conflicts/,
  );
});
