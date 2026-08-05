import assert from "node:assert/strict";
import test from "node:test";
import { createBackupAuditStore } from "../src/backup/audit-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { BackupAuditEvent } from "../src/backup/types.ts";

test("backup audit accepts bounded safe codes and rejects secret-bearing field names", async () => {
  const audit = createBackupAuditStore(createMemoryMap<BackupAuditEvent>(), () => 1000);
  await audit.record({
    organizationId: "default-org",
    actor: "admin",
    action: "backup.run.request",
    resource: "bkp_one",
    detail: { purpose: "manual", accepted: true },
  });
  assert.equal((await audit.list("default-org"))[0]?.at, 1000);
  await assert.rejects(
    audit.record({
      organizationId: "default-org",
      actor: "admin",
      action: "backup.config.update",
      resource: "backup-config",
      detail: { applicationKey: "must-not-store" },
    }),
    /sensitive/,
  );
});
