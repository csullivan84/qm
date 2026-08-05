import type {
  BackupConfigurationStatus,
  BackupJob,
  BackupProtectionCondition,
  BackupProtectionStatus,
  BackupWorkerHeartbeat,
  RestoreDrill,
} from "./types.ts";

const DAY_MS = 86_400_000;

export function calculateBackupProtection(input: {
  config: BackupConfigurationStatus | null;
  jobs: BackupJob[];
  drills: RestoreDrill[];
  heartbeat: BackupWorkerHeartbeat | null;
  now?: number;
  restoring?: boolean;
}): BackupProtectionStatus {
  const now = input.now ?? Date.now();
  if (!input.config) return { state: "Unconfigured", evaluatedAt: now, conditions: [] };
  if (input.restoring) return { state: "Restoring", evaluatedAt: now, conditions: [] };
  if (!input.config.enabled || input.config.suspended) {
    return { state: "Suspended", evaluatedAt: now, conditions: [] };
  }

  const configurationIncarnationId = input.config.configurationIncarnationId;
  const currentJobs = input.jobs.filter(
    (job) =>
      Boolean(configurationIncarnationId) &&
      job.configurationGeneration === input.config!.generation &&
      job.configurationIncarnationId === configurationIncarnationId,
  );
  const currentJobIds = new Set(currentJobs.map((job) => job.id));
  const complete = currentJobs
    .filter((job) => job.state === "complete" && job.verifiedAt)
    .sort((first, second) => (second.verifiedAt ?? 0) - (first.verifiedAt ?? 0));
  const latest = complete[0];
  const latestDrill = input.drills
    .filter(
      (drill) =>
        drill.state === "complete" &&
        drill.completedAt &&
        drill.configurationGeneration === input.config!.generation &&
        Boolean(configurationIncarnationId) &&
        drill.configurationIncarnationId === configurationIncarnationId &&
        currentJobIds.has(drill.sourceBackupId),
    )
    .sort((first, second) => (second.completedAt ?? 0) - (first.completedAt ?? 0))[0];
  const rpoMs = input.config.scheduleIntervalMinutes * 2 * 60_000;
  const conditions: BackupProtectionCondition[] = [];
  const condition = (code: string, state: BackupProtectionCondition["state"], summary: string): void => {
    conditions.push({ code, state, summary });
  };

  condition(
    "configuration",
    input.config.validation ? "pass" : "fail",
    "Destination configuration has current validation evidence",
  );
  condition(
    "configuration_incarnation",
    configurationIncarnationId ? "pass" : "fail",
    "Destination configuration has a non-reusable incarnation identifier",
  );
  const fresh = Boolean(latest?.verifiedAt && now - latest.verifiedAt <= rpoMs);
  condition("backup_freshness", fresh ? "pass" : "fail", "Latest verified backup is within the recovery objective");
  const checksum = latest?.checksumMatches === true;
  condition("backup_checksum", checksum ? "pass" : "fail", "Latest uploaded archive checksum matches");
  const versionPinned = Boolean(latest?.objectVersionId);
  condition(
    "backup_version_pin",
    versionPinned ? "pass" : "fail",
    "Latest recovery point is pinned to one immutable object version",
  );
  const drillFresh = Boolean(latestDrill?.completedAt && now - latestDrill.completedAt <= 31 * DAY_MS);
  const invariants = latestDrill?.invariants;
  const drillPassed = Boolean(
    drillFresh &&
    latestDrill?.targetPostgresServerVersionNum === 180004 &&
    latestDrill?.downloadVerified &&
    latestDrill.checksumVerified &&
    latestDrill.decrypted &&
    latestDrill.restored &&
    latestDrill.cleanup &&
    invariants &&
    invariants.postgresVersion === true &&
    invariants.postgresServerVersionNum === 180004 &&
    invariants.schema === true &&
    invariants.rowBounds === true &&
    invariants.organization === true &&
    invariants.timestamps === true &&
    invariants.applicationHealth === true,
  );
  condition("restore_drill", drillPassed ? "pass" : "fail", "A full isolated restore drill passed within 31 days");
  const kit = input.config.recoveryKit;
  const kitAcknowledged = Boolean(
    kit?.acknowledgedAt &&
    kit.fingerprint === input.config.offlineRecipientFingerprint &&
    kit.configurationGeneration === input.config.generation &&
    Boolean(configurationIncarnationId) &&
    kit.configurationIncarnationId === configurationIncarnationId,
  );
  condition("recovery_kit", kitAcknowledged ? "pass" : "fail", "The current off-host recovery kit is acknowledged");

  for (const [code, value] of Object.entries(input.config.validation ?? {})) {
    if (code === "checkedAt" || code === "safeCode" || code === "unnecessaryCapabilities") continue;
    if (value === "pass" || value === "fail" || value === "unavailable") {
      const unnecessary = input.config.validation?.unnecessaryCapabilities ?? [];
      const summary =
        code === "leastPrivilege" && unnecessary.length
          ? `Credential includes unnecessary capabilities: ${unnecessary.slice(0, 20).join(", ")}`
          : `Destination policy check: ${code}`;
      condition(`policy_${code}`, value, summary);
    }
  }
  if (input.config.validation && !Object.hasOwn(input.config.validation, "leastPrivilege")) {
    condition("policy_leastPrivilege", "unavailable", "Destination must be revalidated for least-privilege evidence");
  }
  const heartbeatFresh = Boolean(
    input.heartbeat &&
    input.heartbeat.generation === input.config.generation &&
    Boolean(configurationIncarnationId) &&
    input.heartbeat.configurationIncarnationId === configurationIncarnationId &&
    now - input.heartbeat.at <= 180_000,
  );
  condition("worker_heartbeat", heartbeatFresh ? "pass" : "fail", "Backup worker heartbeat is current");
  const terminal = currentJobs
    .filter((job) => job.state === "terminal_failure")
    .sort((first, second) => (second.completedAt ?? second.requestedAt) - (first.completedAt ?? first.requestedAt))[0];
  const terminalUnresolved = Boolean(
    terminal && (!latest?.completedAt || (terminal.completedAt ?? terminal.requestedAt) > latest.completedAt),
  );
  condition("terminal_failure", terminalUnresolved ? "fail" : "pass", "No unresolved terminal backup failure exists");
  const retryable = currentJobs
    .filter((job) => job.state === "retryable_failure")
    .sort((first, second) => second.requestedAt - first.requestedAt)[0];
  const retryableUnresolved = Boolean(
    retryable && (!latest?.completedAt || (retryable.completedAt ?? retryable.requestedAt) > latest.completedAt),
  );
  condition(
    "retryable_failure",
    retryableUnresolved ? "unavailable" : "pass",
    "No newer retryable backup failure is awaiting recovery",
  );

  const result: BackupProtectionStatus = {
    state: "Setting up",
    evaluatedAt: now,
    conditions,
    ...(latest ? { latestBackupId: latest.id } : {}),
    ...(latest?.verifiedAt ? { latestVerifiedAt: latest.verifiedAt } : {}),
    ...(latestDrill?.completedAt ? { latestRestoreDrillAt: latestDrill.completedAt } : {}),
    ...(input.heartbeat ? { workerHeartbeatAt: input.heartbeat.at } : {}),
  };
  if (!latest) return result;
  const criticalFailureCodes = new Set([
    "configuration",
    "configuration_incarnation",
    "backup_freshness",
    "backup_checksum",
    "backup_version_pin",
    "worker_heartbeat",
    "terminal_failure",
    "policy_reachable",
    "policy_private",
    "policy_bucketScoped",
    "policy_leastPrivilege",
    "policy_serverSideEncryption",
    "policy_lifecycle",
  ]);
  const criticalFailure = conditions.some((entry) => entry.state === "fail" && criticalFailureCodes.has(entry.code));
  const objectLockFailure = input.config.objectLock.required
    ? conditions.some((entry) => entry.code === "policy_objectLock" && entry.state === "fail")
    : false;
  if (criticalFailure || objectLockFailure) return { ...result, state: "Failed" };
  if (conditions.every((entry) => entry.state === "pass")) return { ...result, state: "Protected" };
  return { ...result, state: "Degraded" };
}
