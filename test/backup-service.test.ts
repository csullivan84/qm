import assert from "node:assert/strict";
import test from "node:test";
import { createBackupAuditStore } from "../src/backup/audit-store.ts";
import {
  createBackupConfigStore,
  type BackupConfigStore,
  type EffectiveBackupConfiguration,
  type StoredBackupConfiguration,
} from "../src/backup/config-store.ts";
import { createRestoreDrillStore } from "../src/backup/drill-store.ts";
import {
  createBackupJobStore,
  type BackupDeploymentLease,
  type BackupJob,
  type BackupWorkerHeartbeat,
} from "../src/backup/job-store.ts";
import { createBackupService } from "../src/backup/service.ts";
import type { BackupAuditEvent, BackupDestinationValidation, RestoreDrill } from "../src/backup/types.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const input = {
  enabled: true,
  deploymentId: "example-host",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  bucket: "qm-backups-test",
  prefix: "qm/production",
  keyId: "key-id",
  applicationKey: "application-key",
  operationalRecipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd3p0m",
  scheduleIntervalMinutes: 60,
  retention: { hourlyDays: 7, dailyDays: 35, monthlyDays: 400, predeployDays: 30, manualDays: 90 },
  objectLock: { required: true, mode: "GOVERNANCE" as const, minimumDays: 30 },
};
const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";
const replacementIncarnationId = "00000000-0000-4000-8000-000000000002";

function service() {
  return fixture().backup;
}

function fixture(
  inspect?: (
    candidate: EffectiveBackupConfiguration,
    config: BackupConfigStore,
    configRecords: ReturnType<typeof createMemoryMap<StoredBackupConfiguration>>,
  ) => Promise<BackupDestinationValidation>,
  wrapConfig?: (config: BackupConfigStore) => BackupConfigStore,
) {
  const now = () => 1000;
  const configRecords = createMemoryMap<StoredBackupConfiguration>();
  const config = createBackupConfigStore("default-org", configRecords, Buffer.alloc(32, 2), now);
  const jobRecords = createMemoryMap<BackupJob>();
  const jobs = createBackupJobStore(
    jobRecords,
    createMemoryMap<BackupDeploymentLease>(),
    createMemoryMap<BackupWorkerHeartbeat>(),
    now,
  );
  const drillRecords = createMemoryMap<RestoreDrill>();
  const drills = createRestoreDrillStore(drillRecords, now);
  const audit = createBackupAuditStore(createMemoryMap<BackupAuditEvent>(), now);
  const serviceConfig = wrapConfig?.(config) ?? config;
  const backup = createBackupService({
    organizationId: "default-org",
    config: serviceConfig,
    jobs,
    drills,
    audit,
    sourceCommit: "a".repeat(40),
    recoveryImage: "localhost/qm-backup@sha256:" + "b".repeat(64),
    inspectDestination: (candidate) =>
      inspect?.(candidate, config, configRecords) ??
      Promise.resolve({
        checkedAt: 1000,
        reachable: candidate.bucket === "qm-backups-test" ? "pass" : "fail",
        private: "pass",
        bucketScoped: "pass",
        leastPrivilege: "pass",
        serverSideEncryption: "pass",
        lifecycle: "pass",
        objectLock: "unavailable",
      }),
    now,
  });
  return { backup, config, configRecords, jobs, jobRecords, drillRecords };
}

function completeLegacyJob(id: string, generation: number): BackupJob {
  return {
    id,
    organizationId: "default-org",
    deploymentId: "old-host",
    configurationGeneration: generation,
    purpose: "manual",
    retentionClass: "manual",
    state: "complete",
    requestedAt: 800,
    completedAt: 900,
    requestedBy: "old-admin",
    idempotencyKey: id,
    sourceRevision: "0".repeat(40),
    attemptCount: 1,
    objectKey: `qm/qm-backup/v1/old-host/manual/${id}.qmbackup`,
    objectVersionId: `${id}-version`,
    sizeBytes: 100,
    archiveSha256: "1".repeat(64),
    verifiedAt: 900,
    checksumMatches: true,
  };
}

function completeLegacyDrill(id: string, backupId: string, generation: number): RestoreDrill {
  return {
    id,
    sourceBackupId: backupId,
    organizationId: "default-org",
    configurationGeneration: generation,
    state: "complete",
    requestedAt: 900,
    completedAt: 950,
    targetPostgresServerVersionNum: 180004,
    downloadVerified: true,
    checksumVerified: true,
    decrypted: true,
    restored: true,
    invariants: {
      postgresVersion: true,
      postgresServerVersionNum: 180004,
      schema: true,
      rowBounds: true,
      organization: true,
      timestamps: true,
      applicationHealth: true,
    },
    cleanup: true,
    verifierVersion: "legacy",
  };
}

test("backup service validates before replacing known-good configuration and never returns credentials", async () => {
  const backup = service();
  const status = await backup.configure(input, "admin");
  assert.equal(status.validation?.objectLock, "unavailable");
  assert.doesNotMatch(JSON.stringify(status), /application-key|key-id/);

  await assert.rejects(
    backup.configure({ ...input, bucket: "other-bucket", keyId: "new", applicationKey: "new-secret" }, "admin"),
    /destination validation/,
  );
  assert.equal((await backup.configuration())?.bucket, "qm-backups-test");
});

test("backup service refuses to attach validation to credentials changed during inspection", async () => {
  let raced = false;
  const { backup, config } = fixture(async (_candidate, store) => {
    if (!raced) {
      raced = true;
      await store.set(
        { ...input, keyId: "replacement-key", applicationKey: "replacement-application-key" },
        "other-admin",
        1,
        configurationIncarnationId,
      );
    }
    return {
      checkedAt: 1000,
      reachable: "pass",
      private: "pass",
      bucketScoped: "pass",
      leastPrivilege: "pass",
      serverSideEncryption: "pass",
      lifecycle: "pass",
      objectLock: "pass",
    };
  });
  await config.set(input, "seed-admin", null, null, configurationIncarnationId);

  await assert.rejects(
    backup.configure({ ...input, keyId: "", applicationKey: "", scheduleIntervalMinutes: 120 }, "admin"),
    /changed while the candidate was being validated/,
  );
  const effective = await config.effective();
  assert.equal(effective?.credential.keyId, "replacement-key");
  assert.equal(effective?.scheduleIntervalMinutes, 60);
  assert.equal((await config.status())?.validation, undefined);
});

test("backup service binds legacy validation to the exact stored configuration revision", async () => {
  let raced = false;
  const { backup, config, configRecords } = fixture(async (candidate, store, records) => {
    assert.equal(candidate.credential.keyId, input.keyId);
    if (!raced) {
      raced = true;
      const predecessor = await records.get("default-org");
      assert.ok(predecessor);
      await records.delete("default-org");
      await store.set(
        { ...input, keyId: "replacement-key", applicationKey: "replacement-application-key" },
        "legacy-admin",
        null,
        null,
        replacementIncarnationId,
      );
      const replacement = await records.get("default-org");
      assert.ok(replacement);
      const legacyReplacement = structuredClone(replacement) as StoredBackupConfiguration & {
        configurationIncarnationId?: string;
      };
      delete legacyReplacement.configurationIncarnationId;
      legacyReplacement.generation = predecessor.generation;
      await records.put("default-org", legacyReplacement);
    }
    return {
      checkedAt: 1000,
      reachable: "pass",
      private: "pass",
      bucketScoped: "pass",
      leastPrivilege: "pass",
      serverSideEncryption: "pass",
      lifecycle: "pass",
      objectLock: "pass",
    };
  });
  await config.set(input, "seed-admin", null, null, configurationIncarnationId);
  const seeded = await configRecords.get("default-org");
  assert.ok(seeded);
  const legacySeed = structuredClone(seeded) as StoredBackupConfiguration & { configurationIncarnationId?: string };
  delete legacySeed.configurationIncarnationId;
  await configRecords.put("default-org", legacySeed);

  await assert.rejects(
    backup.configure({ ...input, keyId: "", applicationKey: "", scheduleIntervalMinutes: 120 }, "admin"),
    /changed while the candidate was being validated/,
  );
  const effective = await config.effective();
  assert.equal(effective?.credential.keyId, "replacement-key");
  assert.equal(effective?.scheduleIntervalMinutes, 60);
  assert.equal((await config.status())?.validation, undefined);
});

test("backup service rejects validation after delete and recreate instead of inheriting new credentials", async () => {
  let raced = false;
  const { backup, config } = fixture(async (_candidate, store) => {
    if (!raced) {
      raced = true;
      await store.delete("other-admin");
      const deleted = await store.snapshot();
      await store.set(
        {
          ...input,
          deploymentId: "replacement-host",
          keyId: "replacement-key",
          applicationKey: "replacement-application-key",
        },
        "other-admin",
        deleted.generation,
        null,
        replacementIncarnationId,
      );
    }
    return {
      checkedAt: 1000,
      reachable: "pass",
      private: "pass",
      bucketScoped: "pass",
      leastPrivilege: "pass",
      serverSideEncryption: "pass",
      lifecycle: "pass",
      objectLock: "pass",
    };
  });
  await config.set(input, "seed-admin", null, null, configurationIncarnationId);

  await assert.rejects(
    backup.configure({ ...input, keyId: "", applicationKey: "", scheduleIntervalMinutes: 120 }, "admin"),
    /changed while the candidate was being validated/,
  );
  const effective = await config.effective();
  assert.equal(effective?.deploymentId, "replacement-host");
  assert.equal(effective?.credential.keyId, "replacement-key");
  assert.equal(effective?.scheduleIntervalMinutes, 60);
  assert.equal((await config.status())?.validation, undefined);
});

test("backup service rejects recovery-kit issuance after delete and recreate", async () => {
  let raced = false;
  const { backup, config } = fixture(undefined, (store) => ({
    ...store,
    async setOfflineRecipient(recipient, fingerprint, actor, expectedGeneration, expectedIncarnationId) {
      if (!raced) {
        raced = true;
        await store.delete("other-admin");
        const deleted = await store.snapshot();
        await store.set(
          {
            ...input,
            deploymentId: "replacement-host",
            keyId: "replacement-key",
            applicationKey: "replacement-application-key",
          },
          "other-admin",
          deleted.generation,
          null,
          replacementIncarnationId,
        );
      }
      return store.setOfflineRecipient(recipient, fingerprint, actor, expectedGeneration, expectedIncarnationId);
    },
  }));
  await config.set(input, "seed-admin", null, null, configurationIncarnationId);

  await assert.rejects(
    backup.issueRecoveryKit("correct horse battery staple", "admin"),
    /changed during recovery-kit issuance/,
  );
  const effective = await config.effective();
  assert.equal(effective?.deploymentId, "replacement-host");
  assert.equal(effective?.credential.keyId, "replacement-key");
  assert.equal((await config.status())?.recoveryKit, undefined);
});

test("backup service issues one encrypted recovery kit, acknowledges its fingerprint, and queues idempotent work", async () => {
  const backup = service();
  await backup.configure(input, "admin");
  const kit = await backup.issueRecoveryKit("correct horse battery staple", "admin");
  assert.ok(kit.bytes.length > 0);
  assert.doesNotMatch(Buffer.from(kit.bytes).toString("utf8"), /application-key/);
  await backup.acknowledgeRecoveryKit(kit.fingerprint, "admin");
  assert.equal((await backup.configuration())?.recoveryKit?.acknowledgedAt, 1000);

  const first = await backup.requestRun({ purpose: "manual", idempotencyKey: "manual-one" }, "admin");
  const second = await backup.requestRun({ purpose: "manual", idempotencyKey: "manual-one" }, "admin");
  assert.equal(first.id, second.id);
  assert.equal(first.configurationGeneration, (await backup.configuration())?.generation);
  assert.equal(
    (await backup.auditEvents()).some((event) => event.action === "backup.run.request"),
    true,
  );
});

test("retained legacy evidence cannot alias a newly recreated configuration", async () => {
  const { backup, jobs, jobRecords, drillRecords } = fixture();
  const legacyJob = completeLegacyJob("bkp_legacy", 2);
  const legacyDrill = completeLegacyDrill("drill_legacy", legacyJob.id, 2);
  await jobRecords.put(legacyJob.id, legacyJob);
  await drillRecords.put(legacyDrill.id, legacyDrill);

  await backup.configure(input, "new-admin");
  const kit = await backup.issueRecoveryKit("correct horse battery staple", "new-admin");
  await backup.acknowledgeRecoveryKit(kit.fingerprint, "new-admin");
  const current = await backup.configuration();
  assert.ok(current && current.generation > legacyJob.configurationGeneration);
  assert.ok(current?.configurationIncarnationId);
  await jobs.workerHeartbeat("new-worker", current.generation, current.configurationIncarnationId);

  const protection = await backup.status();
  assert.equal(protection.state, "Setting up");
  assert.equal(protection.latestBackupId, undefined);
  assert.equal(protection.latestRestoreDrillAt, undefined);
});

test("legacy evidence arriving during inspection cannot enter the incarnation generation namespace", async () => {
  const legacyGeneration = 2;
  const lateJob = completeLegacyJob("bkp_late_legacy", legacyGeneration);
  const lateDrill = completeLegacyDrill("drill_late_legacy", lateJob.id, legacyGeneration);
  const prepared = fixture(async () => {
    await prepared.jobRecords.put(lateJob.id, lateJob);
    await prepared.drillRecords.put(lateDrill.id, lateDrill);
    await prepared.jobs.workerHeartbeat("legacy-worker", legacyGeneration);
    return {
      checkedAt: 1000,
      reachable: "pass",
      private: "pass",
      bucketScoped: "pass",
      leastPrivilege: "pass",
      serverSideEncryption: "pass",
      lifecycle: "pass",
      objectLock: "pass",
    };
  });

  await prepared.backup.configure(input, "new-admin");
  const kit = await prepared.backup.issueRecoveryKit("correct horse battery staple", "new-admin");
  await prepared.backup.acknowledgeRecoveryKit(kit.fingerprint, "new-admin");
  const current = await prepared.backup.configuration();
  assert.ok(current);
  assert.notEqual(current.generation, legacyGeneration);
  assert.ok(current.generation > legacyGeneration);
  assert.ok(current.configurationIncarnationId);

  const protection = await prepared.backup.status();
  assert.equal(protection.state, "Setting up");
  assert.equal(protection.latestBackupId, undefined);
  assert.equal(protection.latestRestoreDrillAt, undefined);
});

test("legacy evidence inside the incarnation generation namespace requires an offline upgrade", async () => {
  const { backup, jobRecords } = fixture();
  const legacyJob = completeLegacyJob("bkp_unsupported_legacy", 2 ** 52);
  await jobRecords.put(legacyJob.id, legacyJob);

  await assert.rejects(backup.configure(input, "new-admin"), /legacy backup generation exceeds/);
  assert.equal(await backup.configuration(), null);
});

test("backup service binds restore-drill requests to the current deployment and configuration generation", async () => {
  const { backup, jobRecords } = fixture();
  const configuration = await backup.configure(input, "admin");
  const recoveryPoint = {
    id: "bkp_verified",
    organizationId: "default-org",
    deploymentId: "other-host",
    configurationGeneration: configuration.generation,
    configurationIncarnationId: configuration.configurationIncarnationId,
    purpose: "manual",
    retentionClass: "manual",
    state: "complete",
    requestedAt: 900,
    completedAt: 950,
    requestedBy: "admin",
    idempotencyKey: "verified",
    sourceRevision: "a".repeat(40),
    attemptCount: 1,
    objectKey: "qm/qm-backup/v1/example-host/manual/point.qmbackup",
    objectVersionId: "version-1",
    sizeBytes: 100,
    archiveSha256: "b".repeat(64),
    verifiedAt: 950,
    checksumMatches: true,
  } satisfies BackupJob;
  await jobRecords.put(recoveryPoint.id, recoveryPoint);
  await assert.rejects(
    backup.requestRestoreDrill(recoveryPoint.id, "drill-wrong-deployment", "admin"),
    /does not exist/,
  );

  await jobRecords.put(recoveryPoint.id, { ...recoveryPoint, deploymentId: input.deploymentId });
  const drill = await backup.requestRestoreDrill(recoveryPoint.id, "drill-current-generation", "admin");
  assert.equal(drill.configurationGeneration, configuration.generation);

  const changed = await backup.configure({ ...input, scheduleIntervalMinutes: 90 }, "admin");
  assert.notEqual(changed.generation, configuration.generation);
  await assert.rejects(backup.requestRestoreDrill(recoveryPoint.id, "drill-old-generation", "admin"), /does not exist/);
  const predeploy = await backup.requestRun({ purpose: "predeploy", idempotencyKey: "predeploy-new-policy" }, "admin");
  assert.equal(predeploy.configurationGeneration, changed.generation);
});
