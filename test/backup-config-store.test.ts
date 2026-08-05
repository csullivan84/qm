import assert from "node:assert/strict";
import test from "node:test";
import { createBackupConfigStore, type StoredBackupConfiguration } from "../src/backup/config-store.ts";
import { recipientFingerprint } from "../src/backup/age.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const input = {
  enabled: true,
  deploymentId: "example-host",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  bucket: "qm-backups-test",
  prefix: "qm/production",
  keyId: "key-id-secret-shaped",
  applicationKey: "application-key-secret-shaped",
  operationalRecipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd3p0m",
  scheduleIntervalMinutes: 60,
  retention: { hourlyDays: 7, dailyDays: 35, monthlyDays: 400, predeployDays: 30, manualDays: 90 },
  objectLock: { required: true, mode: "GOVERNANCE" as const, minimumDays: 30 },
};
const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";
const replacementIncarnationId = "00000000-0000-4000-8000-000000000002";

test("backup configuration encrypts credentials and exposes only secret-presence metadata", async () => {
  const backing = createMemoryMap<StoredBackupConfiguration>();
  const store = createBackupConfigStore("default-org", backing, Buffer.alloc(32, 3));
  const status = await store.set(input, "admin-alice", null, null, configurationIncarnationId);

  assert.equal(status.configured, true);
  assert.equal(status.hasCredential, true);
  assert.equal(status.generation, 1);
  assert.doesNotMatch(JSON.stringify(status), /secret-shaped/);
  assert.doesNotMatch(JSON.stringify(await backing.get("default-org")), /secret-shaped/);
  assert.equal((await store.effective())?.credential.applicationKey, input.applicationKey);

  const updated = await store.set(
    { ...input, keyId: "", applicationKey: "", scheduleIntervalMinutes: 120 },
    "admin-bob",
    status.generation,
    status.configurationIncarnationId!,
  );
  assert.equal(updated.generation, 2);
  assert.equal((await store.effective())?.credential.applicationKey, input.applicationKey);
});

test("backup configuration rejects partial credentials and records recovery-kit acknowledgement exactly", async () => {
  const store = createBackupConfigStore(
    "default-org",
    createMemoryMap<StoredBackupConfiguration>(),
    Buffer.alloc(32, 4),
  );
  await assert.rejects(
    store.set({ ...input, applicationKey: "" }, "admin", null, null, configurationIncarnationId),
    /both/,
  );
  await store.set(input, "admin", null, null, configurationIncarnationId);
  const fingerprint = recipientFingerprint("age1offline");
  await store.setOfflineRecipient("age1offline", fingerprint, "admin", 1, configurationIncarnationId);
  await store.markKitIssued(fingerprint, "admin", 2, configurationIncarnationId, 1000);
  await assert.rejects(store.acknowledgeKit("age-sha256:wrong", "admin", 2000), /fingerprint/);
  await store.acknowledgeKit(fingerprint, "admin", 2000);
  const status = await store.status();
  assert.ok(status);
  assert.equal(status.recoveryKit?.issuedAt, 1000);
  assert.equal(status.recoveryKit?.acknowledgedAt, 2000);
  assert.equal(status.recoveryKit?.configurationGeneration, status.generation);
});

test("backup configuration invalidates kit acknowledgement on destination, credential, identity, or policy changes", async () => {
  const changes = [
    { ...input, deploymentId: "replacement-host", keyId: "", applicationKey: "" },
    { ...input, bucket: "qm-backups-replacement", keyId: "", applicationKey: "" },
    { ...input, keyId: "replacement-key", applicationKey: "replacement-application-key" },
    {
      ...input,
      keyId: "",
      applicationKey: "",
      retention: { ...input.retention, manualDays: input.retention.manualDays + 1 },
    },
  ];
  for (const [index, change] of changes.entries()) {
    const store = createBackupConfigStore(
      "default-org",
      createMemoryMap<StoredBackupConfiguration>(),
      Buffer.alloc(32, index + 10),
    );
    await store.set(input, "admin", null, null, configurationIncarnationId);
    const fingerprint = recipientFingerprint("age1offline");
    await store.setOfflineRecipient("age1offline", fingerprint, "admin", 1, configurationIncarnationId);
    await store.markKitIssued(fingerprint, "admin", 2, configurationIncarnationId, 1000);
    await store.acknowledgeKit(fingerprint, "admin", 2000);
    const before = await store.status();
    assert.ok(before?.recoveryKit?.acknowledgedAt);
    const after = await store.set(change, "admin", before!.generation, configurationIncarnationId);
    assert.equal(after.recoveryKit, undefined);
    assert.equal(after.generation, (before?.generation ?? 0) + 1);
  }
});

test("backup configuration preserves write-only credentials and the operational recipient on blank updates", async () => {
  const store = createBackupConfigStore(
    "default-org",
    createMemoryMap<StoredBackupConfiguration>(),
    Buffer.alloc(32, 5),
    () => 1000,
  );
  await store.set(input, "admin", null, null, configurationIncarnationId);
  await store.set(
    {
      ...input,
      keyId: "",
      applicationKey: "",
      operationalRecipient: "",
      scheduleIntervalMinutes: 120,
    },
    "admin",
    1,
    configurationIncarnationId,
  );
  const effective = await store.effective();
  assert.equal(effective?.credential.keyId, input.keyId);
  assert.equal(effective?.credential.applicationKey, input.applicationKey);
  assert.equal(effective?.operationalRecipient, input.operationalRecipient);
  assert.equal(effective?.scheduleIntervalMinutes, 120);
});

test("backup configuration rejects stale destination and recovery-kit evidence generations", async () => {
  const store = createBackupConfigStore(
    "default-org",
    createMemoryMap<StoredBackupConfiguration>(),
    Buffer.alloc(32, 30),
    () => 1000,
  );
  const initial = await store.set(input, "admin-a", null, null, configurationIncarnationId);
  assert.ok(initial.configurationIncarnationId);
  const changed = await store.set(
    { ...input, scheduleIntervalMinutes: 120 },
    "admin-b",
    initial.generation,
    configurationIncarnationId,
  );
  const validation = {
    checkedAt: 1000,
    reachable: "pass" as const,
    private: "pass" as const,
    bucketScoped: "pass" as const,
    leastPrivilege: "pass" as const,
    serverSideEncryption: "pass" as const,
    lifecycle: "pass" as const,
    objectLock: "pass" as const,
  };

  await assert.rejects(
    store.setValidation(validation, "backup-worker", initial.generation, configurationIncarnationId),
    /changed during destination validation/,
  );
  assert.equal((await store.status())?.validation, undefined);

  const fingerprint = recipientFingerprint("age1offline");
  await assert.rejects(
    store.setOfflineRecipient("age1offline", fingerprint, "admin-a", initial.generation, configurationIncarnationId),
    /changed during recovery-kit issuance/,
  );
  const recipient = await store.setOfflineRecipient(
    "age1offline",
    fingerprint,
    "admin-b",
    changed.generation,
    configurationIncarnationId,
  );
  await store.set(
    { ...input, scheduleIntervalMinutes: 180 },
    "admin-c",
    recipient.generation,
    configurationIncarnationId,
  );
  await assert.rejects(
    store.markKitIssued(fingerprint, "admin-b", recipient.generation, configurationIncarnationId, 1000),
    /changed during recovery-kit issuance/,
  );
  assert.equal((await store.status())?.recoveryKit, undefined);
});

test("backup configuration deletion leaves a monotonic fence across recreation", async () => {
  const backing = createMemoryMap<StoredBackupConfiguration>();
  const store = createBackupConfigStore("default-org", backing, Buffer.alloc(32, 31), () => 1000);
  const initial = await store.set(input, "admin-a", null, null, configurationIncarnationId);
  await store.delete("admin-b");

  assert.equal(await store.status(), null);
  assert.equal(await store.effective(), null);
  const deleted = await store.snapshot();
  assert.equal(deleted.configuration, null);
  assert.equal(deleted.generation, initial.generation + 1);
  assert.deepEqual(Object.keys((await backing.get("default-org"))!).sort(), [
    "deletedAt",
    "generation",
    "id",
    "organizationId",
    "updatedAt",
    "updatedBy",
    "version",
  ]);

  await assert.rejects(
    store.set(
      { ...input, scheduleIntervalMinutes: 120 },
      "stale-admin",
      initial.generation,
      configurationIncarnationId,
    ),
    /changed while the candidate was being validated/,
  );
  const recreated = await store.set(
    { ...input, deploymentId: "replacement-host", keyId: "new-key", applicationKey: "new-application-key" },
    "admin-c",
    deleted.generation,
    null,
    replacementIncarnationId,
  );
  assert.ok(recreated.generation > deleted.generation!);
  assert.ok(recreated.configurationIncarnationId);
  assert.notEqual(recreated.configurationIncarnationId, initial.configurationIncarnationId);

  const validation = {
    checkedAt: 1000,
    reachable: "pass" as const,
    private: "pass" as const,
    bucketScoped: "pass" as const,
    leastPrivilege: "pass" as const,
    serverSideEncryption: "pass" as const,
    lifecycle: "pass" as const,
    objectLock: "pass" as const,
  };
  await assert.rejects(
    store.setValidation(validation, "stale-worker", initial.generation, configurationIncarnationId),
    /changed during destination validation/,
  );
  assert.equal((await store.status())?.validation, undefined);
});

test("deleting an unconfigured destination fences an already prepared initial candidate", async () => {
  const store = createBackupConfigStore(
    "default-org",
    createMemoryMap<StoredBackupConfiguration>(),
    Buffer.alloc(32, 32),
    () => 1000,
  );
  assert.deepEqual(await store.snapshot(), { configuration: null, generation: null, version: null });
  await store.delete("admin-a");
  const deleted = await store.snapshot();
  assert.equal(deleted.configuration, null);
  assert.equal(deleted.generation, 1);
  assert.ok(deleted.version);

  await assert.rejects(
    store.set(input, "stale-admin", null, null, configurationIncarnationId),
    /changed while the candidate was being validated/,
  );
  const configured = await store.set(input, "admin-b", deleted.generation, null, configurationIncarnationId);
  assert.ok(configured.generation > deleted.generation!);
});

test("incarnation fencing survives a predecessor-style physical delete with generation reuse", async () => {
  const backing = createMemoryMap<StoredBackupConfiguration>();
  const store = createBackupConfigStore("default-org", backing, Buffer.alloc(32, 33), () => 1000);
  const initial = await store.set(input, "admin-a", null, null, configurationIncarnationId);
  await backing.delete("default-org");
  const recreated = await store.set(
    { ...input, deploymentId: "replacement-host", keyId: "new-key", applicationKey: "new-application-key" },
    "admin-b",
    null,
    null,
    replacementIncarnationId,
  );
  assert.ok(recreated.generation > initial.generation);

  await assert.rejects(
    store.set(
      { ...input, scheduleIntervalMinutes: 120 },
      "stale-admin",
      initial.generation,
      configurationIncarnationId,
    ),
    /changed while the candidate was being validated/,
  );
  const validation = {
    checkedAt: 1000,
    reachable: "pass" as const,
    private: "pass" as const,
    bucketScoped: "pass" as const,
    leastPrivilege: "pass" as const,
    serverSideEncryption: "pass" as const,
    lifecycle: "pass" as const,
    objectLock: "pass" as const,
  };
  await assert.rejects(
    store.setValidation(validation, "stale-worker", initial.generation, configurationIncarnationId),
    /changed during destination validation/,
  );
  const fingerprint = recipientFingerprint("age1offline");
  await assert.rejects(
    store.setOfflineRecipient(
      "age1offline",
      fingerprint,
      "stale-admin",
      initial.generation,
      configurationIncarnationId,
    ),
    /changed during recovery-kit issuance/,
  );
  assert.equal((await store.effective())?.deploymentId, "replacement-host");
  assert.equal((await store.status())?.validation, undefined);
});
