import assert from "node:assert/strict";
import test from "node:test";
import { runPredeployBackupGate } from "../scripts/backup-predeploy-gate.ts";

const requiredConditions = [
  "configuration",
  "backup_freshness",
  "backup_checksum",
  "backup_version_pin",
  "restore_drill",
  "recovery_kit",
  "worker_heartbeat",
  "terminal_failure",
  "retryable_failure",
  "policy_reachable",
  "policy_private",
  "policy_bucketScoped",
  "policy_leastPrivilege",
  "policy_serverSideEncryption",
  "policy_lifecycle",
  "policy_objectLock",
].map((code) => ({ code, state: "pass" }));

test("predeploy gate repairs stale freshness, reuses one key, and requires final verification evidence", async () => {
  let now = 1000;
  let polls = 0;
  const calls: Array<{ url: string; idempotencyKey: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, idempotencyKey: headers.get("idempotency-key") });
    if (url.endsWith("/status") && calls.filter((call) => call.url.endsWith("/status")).length === 1) {
      return Response.json({
        state: "Failed",
        managementAvailable: true,
        conditions: requiredConditions.map((condition) =>
          condition.code === "backup_freshness" ? { ...condition, state: "fail" } : condition,
        ),
      });
    }
    if (url.endsWith("/runs")) return Response.json({ id: "bkp_predeploy", state: "queued" }, { status: 202 });
    if (url.endsWith("/runs/bkp_predeploy")) {
      polls++;
      return Response.json(
        polls === 1
          ? { id: "bkp_predeploy", state: "verifying" }
          : {
              id: "bkp_predeploy",
              state: "complete",
              sourceRevision: "a".repeat(40),
              verifiedAt: 2000,
              checksumMatches: true,
              archiveSha256: "a".repeat(64),
              objectVersionId: "version-1",
            },
      );
    }
    return Response.json({
      state: "Protected",
      managementAvailable: true,
      conditions: requiredConditions,
    });
  };
  const result = await runPredeployBackupGate({
    apiBase: "https://qm.example.test/admin/api/backups",
    deploymentId: "qm",
    sourceRevision: "a".repeat(40),
    targetRevision: "b".repeat(40),
    headers: { cookie: "session=private" },
    fetchImpl,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  assert.equal(result.run.id, "bkp_predeploy");
  assert.equal(result.protectionState, "Protected");
  assert.match(result.idempotencyKey, /^predeploy:[a-f0-9]{64}$/);
  assert.equal(calls.find((call) => call.url.endsWith("/runs"))?.idempotencyKey, result.idempotencyKey);
});

test("predeploy gate refuses policy failure after a nominally complete upload", async () => {
  let statusReads = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      statusReads++;
      return Response.json({
        state: statusReads === 1 ? "Degraded" : "Failed",
        managementAvailable: true,
        conditions: requiredConditions.map((condition) =>
          statusReads > 1 && condition.code === "policy_private" ? { ...condition, state: "fail" } : condition,
        ),
      });
    }
    return Response.json({
      id: "bkp_predeploy",
      state: "complete",
      sourceRevision: "a".repeat(40),
      verifiedAt: 2000,
      checksumMatches: true,
      archiveSha256: "a".repeat(64),
      objectVersionId: "version-1",
    });
  };
  await assert.rejects(
    runPredeployBackupGate({
      apiBase: "https://qm.example.test/admin/api/backups",
      deploymentId: "qm",
      sourceRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      headers: { cookie: "session=private" },
      fetchImpl,
    }),
    /policy_private/,
  );
});

test("predeploy gate refuses a degraded result when the restore drill is not proven", async () => {
  let statusReads = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      statusReads++;
      return Response.json({
        state: statusReads === 1 ? "Setting up" : "Degraded",
        managementAvailable: true,
        conditions: requiredConditions.map((condition) =>
          statusReads > 1 && condition.code === "restore_drill" ? { ...condition, state: "fail" } : condition,
        ),
      });
    }
    return Response.json({
      id: "bkp_predeploy",
      state: "complete",
      sourceRevision: "a".repeat(40),
      verifiedAt: 2000,
      checksumMatches: true,
      archiveSha256: "a".repeat(64),
      objectVersionId: "version-1",
    });
  };
  await assert.rejects(
    runPredeployBackupGate({
      apiBase: "https://qm.example.test/admin/api/backups",
      deploymentId: "qm",
      sourceRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      headers: { cookie: "session=private" },
      fetchImpl,
    }),
    /restore_drill/,
  );
});

test("predeploy gate refuses verification evidence for a different revision", async () => {
  let statusReads = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      statusReads++;
      return Response.json({
        state: statusReads === 1 ? "Setting up" : "Protected",
        managementAvailable: true,
        conditions: requiredConditions,
      });
    }
    return Response.json({
      id: "bkp_predeploy",
      state: "complete",
      sourceRevision: "c".repeat(40),
      verifiedAt: 2000,
      checksumMatches: true,
      archiveSha256: "a".repeat(64),
      objectVersionId: "version-1",
    });
  };
  await assert.rejects(
    runPredeployBackupGate({
      apiBase: "https://qm.example.test/admin/api/backups",
      deploymentId: "qm",
      sourceRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      headers: { cookie: "session=private" },
      fetchImpl,
    }),
    /verification evidence/,
  );
});
