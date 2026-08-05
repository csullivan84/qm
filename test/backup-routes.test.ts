import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createBackupAuditStore } from "../src/backup/audit-store.ts";
import { createBackupConfigStore, type StoredBackupConfiguration } from "../src/backup/config-store.ts";
import { createRestoreDrillStore } from "../src/backup/drill-store.ts";
import {
  createBackupJobStore,
  type BackupDeploymentLease,
  type BackupJob,
  type BackupWorkerHeartbeat,
} from "../src/backup/job-store.ts";
import { createBackupService } from "../src/backup/service.ts";
import type { BackupAuditEvent, RestoreDrill } from "../src/backup/types.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const configuration = {
  enabled: true,
  deploymentId: "qm",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  bucket: "qm-backups-test",
  prefix: "qm/production",
  keyId: "write-only-key-id",
  applicationKey: "write-only-application-key",
  operationalRecipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd3p0m",
  scheduleIntervalMinutes: 60,
  retention: { hourlyDays: 7, dailyDays: 35, monthlyDays: 400, predeployDays: 30, manualDays: 90 },
  objectLock: { required: true, mode: "GOVERNANCE" as const, minimumDays: 30 },
};

function backupService() {
  const now = () => 1000;
  return createBackupService({
    organizationId: "default-org",
    config: createBackupConfigStore(
      "default-org",
      createMemoryMap<StoredBackupConfiguration>(),
      Buffer.alloc(32, 4),
      now,
    ),
    jobs: createBackupJobStore(
      createMemoryMap<BackupJob>(),
      createMemoryMap<BackupDeploymentLease>(),
      createMemoryMap<BackupWorkerHeartbeat>(),
      now,
    ),
    drills: createRestoreDrillStore(createMemoryMap<RestoreDrill>(), now),
    audit: createBackupAuditStore(createMemoryMap<BackupAuditEvent>(), now),
    sourceCommit: "a".repeat(40),
    recoveryImage: `localhost/qm-backup@sha256:${"b".repeat(64)}`,
    inspectDestination: async () => ({
      checkedAt: now(),
      reachable: "pass",
      private: "pass",
      bucketScoped: "pass",
      leastPrivilege: "pass",
      serverSideEncryption: "pass",
      lifecycle: "pass",
      objectLock: "pass",
    }),
    now,
  });
}

function start(managementAvailable: boolean) {
  const built = buildApp(testConfig());
  const backup = backupService();
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    backup,
    backupManagementDurable: managementAvailable,
  });
  server.listen(0);
  return {
    backup,
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("Recovery routes refuse mutations without durable storage", async () => {
  const srv = start(false);
  try {
    const status = await fetch(`${srv.base}/v1/admin/backups/status`, { headers: ADMIN });
    assert.equal(status.status, 200);
    assert.equal((await jsonObject(status)).managementAvailable, false);

    const put = await fetch(`${srv.base}/v1/admin/backups/config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(configuration),
    });
    assert.equal(put.status, 503);
    assert.match(await put.text(), /durable_storage_required/);
    assert.equal(await srv.backup.configuration(), null);
  } finally {
    await srv.close();
  }
});

test("Recovery routes keep B2 credentials write-only and queue idempotent backups", async () => {
  const srv = start(true);
  try {
    const put = await fetch(`${srv.base}/v1/admin/backups/config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(configuration),
    });
    assert.equal(put.status, 200);
    const response = await put.text();
    assert.doesNotMatch(response, /write-only-key-id|write-only-application-key/);

    const first = await fetch(`${srv.base}/v1/admin/backups/runs`, {
      method: "POST",
      headers: { ...ADMIN, "idempotency-key": "manual-one" },
      body: JSON.stringify({ purpose: "manual" }),
    });
    const second = await fetch(`${srv.base}/v1/admin/backups/runs`, {
      method: "POST",
      headers: { ...ADMIN, "idempotency-key": "manual-one" },
      body: JSON.stringify({ purpose: "manual" }),
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal((await jsonObject(first)).id, (await jsonObject(second)).id);

    const audit = await fetch(`${srv.base}/v1/admin/backups/audit`, { headers: ADMIN });
    const auditText = await audit.text();
    assert.equal(audit.status, 200);
    assert.doesNotMatch(auditText, /write-only-key-id|write-only-application-key/);
  } finally {
    await srv.close();
  }
});
