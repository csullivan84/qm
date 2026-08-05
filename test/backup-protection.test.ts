import assert from "node:assert/strict";
import test from "node:test";
import { calculateBackupProtection } from "../src/backup/protection.ts";
import type { BackupConfigurationStatus, BackupJob, BackupWorkerHeartbeat, RestoreDrill } from "../src/backup/types.ts";

const now = Date.UTC(2026, 7, 4, 12, 0, 0);
const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";
const config: BackupConfigurationStatus = {
  configured: true,
  enabled: true,
  suspended: false,
  generation: 1,
  configurationIncarnationId,
  deploymentId: "example-host",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  bucket: "qm-backups-test",
  prefix: "qm/production/",
  hasCredential: true,
  operationalRecipientFingerprint: "age-sha256:op",
  offlineRecipientFingerprint: "age-sha256:offline",
  scheduleIntervalMinutes: 60,
  retention: { hourlyDays: 7, dailyDays: 35, monthlyDays: 400, predeployDays: 30, manualDays: 90 },
  objectLock: { required: true, mode: "GOVERNANCE", minimumDays: 30 },
  recoveryKit: {
    fingerprint: "age-sha256:offline",
    configurationGeneration: 1,
    configurationIncarnationId,
    issuedAt: now - 1000,
    acknowledgedAt: now - 500,
  },
  validation: {
    checkedAt: now - 1000,
    reachable: "pass",
    private: "pass",
    bucketScoped: "pass",
    leastPrivilege: "pass",
    serverSideEncryption: "pass",
    lifecycle: "pass",
    objectLock: "pass",
  },
  createdAt: now - 5000,
  updatedAt: now - 1000,
  updatedBy: "admin",
};
const complete = {
  id: "bkp_ok",
  organizationId: "default-org",
  deploymentId: "example-host",
  configurationGeneration: 1,
  configurationIncarnationId,
  purpose: "manual",
  retentionClass: "manual",
  state: "complete",
  requestedAt: now - 2000,
  requestedBy: "admin",
  idempotencyKey: "manual",
  sourceRevision: "a".repeat(40),
  attemptCount: 1,
  objectKey: "point",
  objectVersionId: "version-1",
  sizeBytes: 100,
  archiveSha256: "b".repeat(64),
  verifiedAt: now - 1000,
  checksumMatches: true,
  completedAt: now - 1000,
} satisfies BackupJob;
const drill = {
  id: "drill_ok",
  sourceBackupId: "bkp_ok",
  organizationId: "default-org",
  configurationGeneration: 1,
  configurationIncarnationId,
  state: "complete",
  requestedAt: now - 900,
  completedAt: now - 800,
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
  verifierVersion: "0.1.0",
} satisfies RestoreDrill;
const heartbeat = {
  id: "backup-worker",
  holder: "worker-a",
  generation: 1,
  configurationIncarnationId,
  at: now - 500,
} satisfies BackupWorkerHeartbeat;

test("Protected is impossible until every restore, kit, policy, freshness, and worker gate passes", () => {
  assert.equal(
    calculateBackupProtection({ config, jobs: [complete], drills: [drill], heartbeat, now }).state,
    "Protected",
  );

  const noKit = {
    ...config,
    recoveryKit: { fingerprint: "age-sha256:offline", configurationGeneration: 1, issuedAt: now - 1000 },
  };
  const kitResult = calculateBackupProtection({ config: noKit, jobs: [complete], drills: [drill], heartbeat, now });
  assert.equal(kitResult.state, "Degraded");
  assert.ok(kitResult.conditions.some((condition) => condition.code === "recovery_kit" && condition.state === "fail"));

  const unreadableLock = {
    ...config,
    validation: { ...config.validation!, objectLock: "unavailable" as const },
  };
  assert.equal(
    calculateBackupProtection({ config: unreadableLock, jobs: [complete], drills: [drill], heartbeat, now }).state,
    "Degraded",
  );

  const broadKey = {
    ...config,
    validation: {
      ...config.validation!,
      leastPrivilege: "unavailable" as const,
      unnecessaryCapabilities: ["deleteFiles", "writeBuckets"],
    },
  };
  const broadKeyResult = calculateBackupProtection({
    config: broadKey,
    jobs: [complete],
    drills: [drill],
    heartbeat,
    now,
  });
  assert.equal(broadKeyResult.state, "Degraded");
  assert.deepEqual(
    broadKeyResult.conditions.find((condition) => condition.code === "policy_leastPrivilege"),
    {
      code: "policy_leastPrivilege",
      state: "unavailable",
      summary: "Credential includes unnecessary capabilities: deleteFiles, writeBuckets",
    },
  );

  const changedGeneration = { ...config, generation: 2 };
  const changedResult = calculateBackupProtection({
    config: changedGeneration,
    jobs: [complete],
    drills: [drill],
    heartbeat: { ...heartbeat, generation: 2 },
    now,
  });
  assert.equal(changedResult.state, "Setting up");
  assert.ok(
    changedResult.conditions.some((condition) => condition.code === "recovery_kit" && condition.state === "fail"),
  );
  assert.ok(
    changedResult.conditions.some((condition) => condition.code === "restore_drill" && condition.state === "fail"),
  );

  const wrongPostgres = { ...drill, invariants: { ...drill.invariants, postgresVersion: false } };
  const wrongPostgresResult = calculateBackupProtection({
    config,
    jobs: [complete],
    drills: [wrongPostgres],
    heartbeat,
    now,
  });
  assert.equal(wrongPostgresResult.state, "Degraded");
  assert.ok(
    wrongPostgresResult.conditions.some(
      (condition) => condition.code === "restore_drill" && condition.state === "fail",
    ),
  );

  for (const invalidDrill of [
    { ...drill, targetPostgresServerVersionNum: 180003 },
    { ...drill, invariants: { ...drill.invariants, postgresServerVersionNum: 180003 } },
    {
      ...drill,
      invariants: (({ postgresServerVersionNum: _version, ...legacy }) => legacy)(drill.invariants),
    } as RestoreDrill,
  ]) {
    const invalidResult = calculateBackupProtection({
      config,
      jobs: [complete],
      drills: [invalidDrill],
      heartbeat,
      now,
    });
    assert.equal(invalidResult.state, "Degraded");
    assert.ok(
      invalidResult.conditions.some((condition) => condition.code === "restore_drill" && condition.state === "fail"),
    );
  }
});

test("configuration policy changes invalidate fresh successful backup and drill evidence", () => {
  const changedConfig = {
    ...config,
    generation: 2,
    recoveryKit: { ...config.recoveryKit!, configurationGeneration: 2 },
  };
  const relabeledDrill = { ...drill, configurationGeneration: 2 };
  const result = calculateBackupProtection({
    config: changedConfig,
    jobs: [complete],
    drills: [relabeledDrill],
    heartbeat: { ...heartbeat, generation: 2 },
    now,
  });
  assert.equal(result.state, "Setting up");
  assert.equal(result.latestBackupId, undefined);
  assert.ok(result.conditions.some((condition) => condition.code === "backup_freshness" && condition.state === "fail"));
  assert.ok(result.conditions.some((condition) => condition.code === "restore_drill" && condition.state === "fail"));

  const currentBackup = { ...complete, id: "bkp_current", configurationGeneration: 2 };
  const unrelatedDrill = calculateBackupProtection({
    config: changedConfig,
    jobs: [complete, currentBackup],
    drills: [relabeledDrill],
    heartbeat: { ...heartbeat, generation: 2 },
    now,
  });
  assert.equal(unrelatedDrill.state, "Degraded");
  assert.ok(
    unrelatedDrill.conditions.some((condition) => condition.code === "restore_drill" && condition.state === "fail"),
  );
});

test("legacy backup and drill records without a generation fail closed", () => {
  const { configurationGeneration: _jobGeneration, ...legacyJob } = complete;
  const { configurationGeneration: _drillGeneration, ...legacyDrill } = drill;
  const result = calculateBackupProtection({
    config,
    jobs: [legacyJob as BackupJob],
    drills: [legacyDrill as RestoreDrill],
    heartbeat,
    now,
  });
  assert.equal(result.state, "Setting up");
  assert.equal(result.latestBackupId, undefined);
  assert.equal(result.latestRestoreDrillAt, undefined);
});

test("retained legacy evidence cannot protect a recreated configuration with the same generation", () => {
  const legacyJob = { ...complete, configurationIncarnationId: undefined };
  const legacyDrill = { ...drill, configurationIncarnationId: undefined };
  const legacyHeartbeat = { ...heartbeat, configurationIncarnationId: undefined };
  const result = calculateBackupProtection({
    config,
    jobs: [legacyJob],
    drills: [legacyDrill],
    heartbeat: legacyHeartbeat,
    now,
  });
  assert.equal(result.state, "Setting up");
  assert.equal(result.latestBackupId, undefined);
  assert.equal(result.latestRestoreDrillAt, undefined);
  assert.ok(result.conditions.some((condition) => condition.code === "backup_freshness" && condition.state === "fail"));
  assert.ok(result.conditions.some((condition) => condition.code === "worker_heartbeat" && condition.state === "fail"));
});

test("protection distinguishes unconfigured, setting up, suspended, degraded, and failed", () => {
  assert.equal(
    calculateBackupProtection({ config: null, jobs: [], drills: [], heartbeat: null, now }).state,
    "Unconfigured",
  );
  assert.equal(calculateBackupProtection({ config, jobs: [], drills: [], heartbeat: null, now }).state, "Setting up");
  assert.equal(
    calculateBackupProtection({ config: { ...config, suspended: true }, jobs: [], drills: [], heartbeat: null, now })
      .state,
    "Suspended",
  );
  assert.equal(
    calculateBackupProtection({
      config,
      jobs: [{ ...complete, checksumMatches: false }],
      drills: [drill],
      heartbeat,
      now,
    }).state,
    "Failed",
  );
  assert.equal(calculateBackupProtection({ config, jobs: [complete], drills: [], heartbeat, now }).state, "Degraded");
  const unpinned = calculateBackupProtection({
    config,
    jobs: [{ ...complete, objectVersionId: undefined }],
    drills: [drill],
    heartbeat,
    now,
  });
  assert.equal(unpinned.state, "Failed");
  assert.ok(
    unpinned.conditions.some((condition) => condition.code === "backup_version_pin" && condition.state === "fail"),
  );
  assert.equal(
    calculateBackupProtection({
      config: { ...config, validation: { ...config.validation!, private: "fail" } },
      jobs: [complete],
      drills: [drill],
      heartbeat,
      now,
    }).state,
    "Failed",
  );
});

test("pre-upgrade validation without least-privilege evidence cannot report Protected", () => {
  const { leastPrivilege: _legacyMissing, ...legacyValidation } = config.validation!;
  const legacyConfig = {
    ...config,
    validation: legacyValidation as BackupConfigurationStatus["validation"],
  };
  const result = calculateBackupProtection({
    config: legacyConfig,
    jobs: [complete],
    drills: [drill],
    heartbeat,
    now,
  });
  assert.equal(result.state, "Degraded");
  assert.deepEqual(
    result.conditions.find((condition) => condition.code === "policy_leastPrivilege"),
    {
      code: "policy_leastPrivilege",
      state: "unavailable",
      summary: "Destination must be revalidated for least-privilege evidence",
    },
  );
});
