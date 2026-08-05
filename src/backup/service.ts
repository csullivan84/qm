import { generateRecoveryIdentity } from "./age.ts";
import type { createBackupAuditStore } from "./audit-store.ts";
import type { BackupConfigStore, BackupConfigurationInput, EffectiveBackupConfiguration } from "./config-store.ts";
import type { createRestoreDrillStore } from "./drill-store.ts";
import { normalizeB2Destination } from "./endpoint.ts";
import type { BackupJobStore } from "./job-store.ts";
import { calculateBackupProtection } from "./protection.ts";
import { createRecoveryKit } from "./recovery-kit.ts";
import type { BackupConfigurationStatus, BackupDestinationValidation, BackupPurpose } from "./types.ts";

type RestoreDrillStore = ReturnType<typeof createRestoreDrillStore>;
type BackupAuditStore = ReturnType<typeof createBackupAuditStore>;
const INCARNATION_GENERATION_FLOOR = 2 ** 52;

export interface BackupService {
  status(): Promise<ReturnType<typeof calculateBackupProtection>>;
  configuration(): Promise<BackupConfigurationStatus | null>;
  configure(input: BackupConfigurationInput, actor: string): Promise<BackupConfigurationStatus>;
  testDestination(input: BackupConfigurationInput | undefined, actor: string): Promise<BackupDestinationValidation>;
  issueRecoveryKit(passphrase: string, actor: string): Promise<{ bytes: Uint8Array; fingerprint: string }>;
  acknowledgeRecoveryKit(fingerprint: string, actor: string): Promise<BackupConfigurationStatus>;
  requestRun(
    input: { purpose: BackupPurpose; idempotencyKey: string },
    actor: string,
  ): ReturnType<BackupJobStore["request"]>;
  retryRun(id: string, actor: string): ReturnType<BackupJobStore["retry"]>;
  runs(): ReturnType<BackupJobStore["list"]>;
  run(id: string): ReturnType<BackupJobStore["get"]>;
  recoveryPoints(): ReturnType<BackupJobStore["list"]>;
  requestRestoreDrill(
    backupId: string,
    idempotencyKey: string,
    actor: string,
  ): ReturnType<RestoreDrillStore["request"]>;
  restoreDrills(): ReturnType<RestoreDrillStore["list"]>;
  suspend(actor: string): Promise<BackupConfigurationStatus>;
  resume(actor: string): Promise<BackupConfigurationStatus>;
  remove(actor: string): Promise<void>;
  prepareRecovery(
    backupId: string,
    actor: string,
  ): Promise<{
    backupId: string;
    sourceDeploymentId: string;
    targetRequirement: string;
    expiresAt: number;
    approvalRequired: true;
  }>;
  auditEvents(): ReturnType<BackupAuditStore["list"]>;
}

function acceptedValidation(report: BackupDestinationValidation): boolean {
  return (
    report.reachable === "pass" &&
    report.private === "pass" &&
    report.bucketScoped === "pass" &&
    report.leastPrivilege !== "fail" &&
    report.serverSideEncryption === "pass" &&
    report.lifecycle === "pass" &&
    report.objectLock !== "fail"
  );
}

export function createBackupService(input: {
  organizationId: string;
  config: BackupConfigStore;
  jobs: BackupJobStore;
  drills: RestoreDrillStore;
  audit: BackupAuditStore;
  sourceCommit: string;
  recoveryImage: string;
  requirePinnedRecoveryImage?: boolean;
  inspectDestination(config: EffectiveBackupConfiguration): Promise<BackupDestinationValidation>;
  now?: () => number;
}): BackupService {
  const now = input.now ?? Date.now;
  const audit = (
    actor: string,
    action: string,
    resource: string,
    detail: Record<string, string | number | boolean | null>,
  ) => input.audit.record({ organizationId: input.organizationId, actor, action, resource, detail });

  const candidate = async (
    configuration: BackupConfigurationInput,
  ): Promise<{
    configuration: EffectiveBackupConfiguration;
    expectedGeneration: number | null;
    expectedIncarnationId: string | null;
    expectedVersion: string | null;
  }> => {
    const [snapshot, jobs, drills, heartbeat] = await Promise.all([
      input.config.snapshot(),
      input.jobs.list(input.organizationId),
      input.drills.list(input.organizationId),
      input.jobs.latestWorkerHeartbeat(),
    ]);
    const current = snapshot.configuration;
    const destination = normalizeB2Destination(configuration);
    const keyId = configuration.keyId.trim() || current?.credential.keyId || "";
    const applicationKey = configuration.applicationKey.trim() || current?.credential.applicationKey || "";
    const operationalRecipient = configuration.operationalRecipient.trim() || current?.operationalRecipient || "";
    const retainedGenerations = [
      snapshot.generation ?? 0,
      ...jobs.map((job) => job.configurationGeneration),
      ...drills.map((drill) => drill.configurationGeneration),
      heartbeat?.generation ?? 0,
    ];
    const unsupportedLegacyGeneration =
      (current && !current.configurationIncarnationId && current.generation >= INCARNATION_GENERATION_FLOOR) ||
      jobs.some(
        (job) => !job.configurationIncarnationId && job.configurationGeneration >= INCARNATION_GENERATION_FLOOR,
      ) ||
      drills.some(
        (drill) => !drill.configurationIncarnationId && drill.configurationGeneration >= INCARNATION_GENERATION_FLOOR,
      ) ||
      Boolean(
        heartbeat && !heartbeat.configurationIncarnationId && heartbeat.generation >= INCARNATION_GENERATION_FLOOR,
      );
    if (unsupportedLegacyGeneration) {
      throw new Error("legacy backup generation exceeds the supported upgrade range");
    }
    let generationHighWater = 0;
    for (const generation of retainedGenerations) {
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("backup configuration generation evidence is invalid");
      }
      generationHighWater = Math.max(generationHighWater, generation);
    }
    const minimumGeneration = Math.max(generationHighWater + 1, INCARNATION_GENERATION_FLOOR);
    if (!Number.isSafeInteger(minimumGeneration)) {
      throw new Error("backup configuration generation evidence is invalid");
    }
    if (
      !keyId ||
      !applicationKey ||
      Boolean(configuration.keyId.trim()) !== Boolean(configuration.applicationKey.trim())
    ) {
      throw new Error("B2 keyId and applicationKey must both be supplied for a new credential");
    }
    const reservation = await input.config.reserveGeneration(minimumGeneration);
    const configurationIncarnationId = current?.configurationIncarnationId ?? reservation.configurationIncarnationId;
    return {
      expectedGeneration: snapshot.generation,
      expectedIncarnationId: current?.configurationIncarnationId ?? null,
      expectedVersion: snapshot.version,
      configuration: {
        configured: true,
        enabled: configuration.enabled,
        suspended: current?.suspended ?? false,
        generation: reservation.generation,
        configurationIncarnationId,
        deploymentId: configuration.deploymentId.trim().toLowerCase(),
        ...destination,
        hasCredential: true,
        operationalRecipientFingerprint: current?.operationalRecipientFingerprint ?? "pending-validation",
        ...(current?.offlineRecipientFingerprint
          ? { offlineRecipientFingerprint: current.offlineRecipientFingerprint }
          : {}),
        scheduleIntervalMinutes: configuration.scheduleIntervalMinutes,
        retention: configuration.retention,
        objectLock: configuration.objectLock,
        ...(current?.recoveryKit ? { recoveryKit: current.recoveryKit } : {}),
        createdAt: current?.createdAt ?? now(),
        updatedAt: now(),
        updatedBy: "pending-validation",
        credential: { keyId, applicationKey },
        operationalRecipient,
        ...(current?.offlineRecipient ? { offlineRecipient: current.offlineRecipient } : {}),
      },
    };
  };

  return {
    async status() {
      const [config, jobs, drills, heartbeat] = await Promise.all([
        input.config.status(),
        input.jobs.list(input.organizationId),
        input.drills.list(input.organizationId),
        input.jobs.latestWorkerHeartbeat(),
      ]);
      return calculateBackupProtection({ config, jobs, drills, heartbeat, now: now() });
    },
    configuration() {
      return input.config.status();
    },
    async configure(configuration, actor) {
      const prepared = await candidate(configuration);
      const report = await input.inspectDestination(prepared.configuration);
      if (!acceptedValidation(report))
        throw new Error(`B2 destination validation failed: ${report.safeCode ?? "policy"}`);
      const saved = await input.config.set(
        configuration,
        actor,
        prepared.expectedGeneration,
        prepared.expectedIncarnationId,
        prepared.configuration.configurationIncarnationId,
        prepared.configuration.generation,
        prepared.expectedVersion,
      );
      const status = await input.config.setValidation(
        report,
        actor,
        saved.generation,
        saved.configurationIncarnationId!,
      );
      await audit(actor, "backup.config.update", "backup-config", {
        generation: saved.generation,
        enabled: saved.enabled,
        objectLock: report.objectLock,
      });
      return status;
    },
    async testDestination(configuration, actor) {
      const inspectedConfiguration = configuration
        ? (await candidate(configuration)).configuration
        : await input.config.effective();
      if (!inspectedConfiguration) throw new Error("backup configuration is not configured");
      const report = await input.inspectDestination(inspectedConfiguration);
      await audit(actor, "backup.destination.test", "backup-config", {
        reachable: report.reachable,
        private: report.private,
        bucketScoped: report.bucketScoped,
        leastPrivilege: report.leastPrivilege,
      });
      return report;
    },
    async issueRecoveryKit(passphrase, actor) {
      if (input.requirePinnedRecoveryImage && !/@sha256:[0-9a-f]{64}$/.test(input.recoveryImage)) {
        throw new Error("production recovery kits require an immutable recovery image digest");
      }
      const current = await input.config.effective();
      if (!current) throw new Error("backup configuration is not configured");
      if (!current.configurationIncarnationId) {
        throw new Error("backup configuration must be reconfigured before recovery-kit issuance");
      }
      const offline = await generateRecoveryIdentity();
      const recipientStatus = await input.config.setOfflineRecipient(
        offline.recipient,
        offline.fingerprint,
        actor,
        current.generation,
        current.configurationIncarnationId,
      );
      const created = await createRecoveryKit({
        passphrase,
        offlineIdentity: offline.identity,
        offlineRecipient: offline.recipient,
        organizationId: input.organizationId,
        deploymentId: current.deploymentId,
        destination: {
          endpoint: current.endpoint,
          region: current.region,
          bucket: current.bucket,
          prefix: current.prefix,
          keyId: current.credential.keyId,
          applicationKey: current.credential.applicationKey,
        },
        sourceCommit: input.sourceCommit,
        recoveryImage: input.recoveryImage,
        issuedAt: now(),
      });
      await input.config.markKitIssued(
        created.fingerprint,
        actor,
        recipientStatus.generation,
        recipientStatus.configurationIncarnationId!,
        now(),
      );
      await audit(actor, "backup.recovery-kit.issue", "backup-config", { fingerprint: created.fingerprint });
      return created;
    },
    async acknowledgeRecoveryKit(fingerprint, actor) {
      const status = await input.config.acknowledgeKit(fingerprint, actor, now());
      await audit(actor, "backup.recovery-kit.acknowledge", "backup-config", { fingerprint });
      return status;
    },
    async requestRun(request, actor) {
      const config = await input.config.status();
      if (!config || !config.enabled || config.suspended) throw new Error("backup configuration is not active");
      if (!config.configurationIncarnationId) {
        throw new Error("backup configuration must be reconfigured before requesting a backup");
      }
      let retentionClass: "predeploy" | "hourly" | "manual" = "manual";
      if (request.purpose === "predeploy") retentionClass = "predeploy";
      else if (request.purpose === "scheduled") retentionClass = "hourly";
      const job = await input.jobs.request({
        organizationId: input.organizationId,
        deploymentId: config.deploymentId,
        configurationGeneration: config.generation,
        configurationIncarnationId: config.configurationIncarnationId,
        purpose: request.purpose,
        retentionClass,
        requestedBy: actor,
        idempotencyKey: request.idempotencyKey,
        sourceRevision: input.sourceCommit,
      });
      await audit(actor, "backup.run.request", job.id, { purpose: request.purpose, retentionClass });
      return job;
    },
    async retryRun(id, actor) {
      const current = await input.jobs.get(id);
      if (!current || current.organizationId !== input.organizationId) throw new Error("backup job does not exist");
      const job = await input.jobs.retry(id);
      await audit(actor, "backup.run.retry", id, { attemptCount: job.attemptCount });
      return job;
    },
    runs() {
      return input.jobs.list(input.organizationId);
    },
    async run(id) {
      const job = await input.jobs.get(id);
      return job?.organizationId === input.organizationId ? job : null;
    },
    async recoveryPoints() {
      return (await input.jobs.list(input.organizationId)).filter(
        (job) => job.state === "complete" && Boolean(job.objectVersionId),
      );
    },
    async requestRestoreDrill(backupId, idempotencyKey, actor) {
      const [backup, configuration] = await Promise.all([input.jobs.get(backupId), input.config.status()]);
      if (
        !backup ||
        !configuration ||
        backup.organizationId !== input.organizationId ||
        backup.deploymentId !== configuration.deploymentId ||
        backup.configurationGeneration !== configuration.generation ||
        !configuration.configurationIncarnationId ||
        backup.configurationIncarnationId !== configuration.configurationIncarnationId ||
        backup.state !== "complete" ||
        !backup.objectVersionId
      ) {
        throw new Error("verified recovery point does not exist");
      }
      const drill = await input.drills.request({
        organizationId: input.organizationId,
        sourceBackupId: backupId,
        configurationGeneration: backup.configurationGeneration,
        configurationIncarnationId: configuration.configurationIncarnationId,
        targetPostgresServerVersionNum: 180004,
        requestedBy: actor,
        idempotencyKey,
        verifierVersion: input.sourceCommit,
      });
      await audit(actor, "backup.restore-drill.request", drill.id, { backupId });
      return drill;
    },
    restoreDrills() {
      return input.drills.list(input.organizationId);
    },
    async suspend(actor) {
      const status = await input.config.suspend(actor);
      await audit(actor, "backup.schedule.suspend", "backup-config", { generation: status.generation });
      return status;
    },
    async resume(actor) {
      const status = await input.config.resume(actor);
      await audit(actor, "backup.schedule.resume", "backup-config", { generation: status.generation });
      return status;
    },
    async remove(actor) {
      await input.config.delete(actor);
      await audit(actor, "backup.config.remove", "backup-config", { removed: true });
    },
    async prepareRecovery(backupId, actor) {
      const backup = await input.jobs.get(backupId);
      if (
        !backup ||
        backup.organizationId !== input.organizationId ||
        backup.state !== "complete" ||
        !backup.objectVersionId
      ) {
        throw new Error("verified recovery point does not exist");
      }
      const plan = {
        backupId,
        sourceDeploymentId: backup.deploymentId,
        targetRequirement: "new empty isolated PostgreSQL server_version_num 180004 target",
        expiresAt: now() + 15 * 60_000,
        approvalRequired: true as const,
      };
      await audit(actor, "backup.recovery.prepare", backupId, {
        sourceDeploymentId: backup.deploymentId,
        expiresAt: plan.expiresAt,
      });
      return plan;
    },
    auditEvents() {
      return input.audit.list(input.organizationId);
    },
  };
}
