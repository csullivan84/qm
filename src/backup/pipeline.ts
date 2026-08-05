import { readFile, rm, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createBackupArchive,
  inspectBackupArchive,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_COMPONENT_BYTES,
  type BackupManifest,
} from "./archive.ts";
import type { BackupConfigStore, EffectiveBackupConfiguration } from "./config-store.ts";
import { backupObjectKey } from "./endpoint.ts";
import type { BackupJobStore } from "./job-store.ts";
import type { BackupDestinationValidation, BackupJob } from "./types.ts";

interface BackupObjectMetadata {
  versionId: string;
  sizeBytes: number;
  sha256: string;
  immutableUntil?: number;
}

export interface BackupPipelineObjectStore {
  probe(key: string): Promise<BackupObjectMetadata | null>;
  upload(key: string, bytes: Uint8Array, sha256: string, immutableUntil?: number): Promise<BackupObjectMetadata>;
  verify(
    key: string,
    versionId: string,
    sizeBytes: number,
    sha256: string,
    immutableUntil?: number,
  ): Promise<BackupObjectMetadata>;
  download(key: string, versionId: string, maxBytes: number): Promise<Buffer>;
}

export interface BackupDatabaseSnapshotMetadata {
  postgresServerVersion: string;
  postgresClientVersion: string;
  expectedDatabaseInvariants: Record<string, string | number | boolean>;
}

export interface BackupPipelineArtifacts {
  database(outputPath: string, recipients: string[]): Promise<BackupDatabaseSnapshotMetadata>;
  deployment(outputPath: string, recipients: string[]): Promise<void>;
  secrets(outputPath: string, recipients: string[]): Promise<void>;
}

class BackupPipelineFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

function retentionDays(config: EffectiveBackupConfiguration, job: BackupJob): number {
  if (job.retentionClass === "hourly") return config.retention.hourlyDays;
  if (job.retentionClass === "daily") return config.retention.dailyDays;
  if (job.retentionClass === "monthly") return config.retention.monthlyDays;
  if (job.retentionClass === "predeploy") return config.retention.predeployDays;
  return config.retention.manualDays;
}

function hardPolicyFailure(report: BackupDestinationValidation): string | null {
  if (report.reachable !== "pass") return "destination_unreachable";
  if (report.private !== "pass") return "bucket_not_private";
  if (report.bucketScoped !== "pass") return "credential_scope_invalid";
  if (report.leastPrivilege === "fail") return "credential_privilege_invalid";
  if (report.serverSideEncryption !== "pass") return "server_side_encryption_invalid";
  if (report.lifecycle !== "pass") return "lifecycle_policy_invalid";
  if (report.objectLock === "fail") return "object_lock_invalid";
  return null;
}

function retryable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    name === "TimeoutError" ||
    status === 408 ||
    status === 429 ||
    Boolean(status && status >= 500)
  );
}

export async function runBackupPipeline(input: {
  claim: { job: BackupJob; token: string };
  config: BackupConfigStore;
  jobs: BackupJobStore;
  scratchRoot: string;
  policyInspect(config: EffectiveBackupConfiguration): Promise<BackupDestinationValidation>;
  artifacts: BackupPipelineArtifacts;
  objectStore: BackupPipelineObjectStore;
  sourceImages: string[];
  applicationVersion: string;
  fullVerify?: (bytes: Buffer, manifest: BackupManifest, config: EffectiveBackupConfiguration) => Promise<void>;
  now?: () => number;
}): Promise<BackupJob> {
  const now = input.now ?? Date.now;
  const { job, token } = input.claim;
  let scratch: string | undefined;
  try {
    const config = await input.config.effective();
    if (!config || !config.enabled || config.suspended)
      throw new BackupPipelineFailure("configuration_inactive", false);
    if (config.deploymentId !== job.deploymentId) throw new BackupPipelineFailure("deployment_mismatch", false);
    if (
      !config.configurationIncarnationId ||
      config.generation !== job.configurationGeneration ||
      config.configurationIncarnationId !== job.configurationIncarnationId
    ) {
      throw new BackupPipelineFailure("configuration_generation_mismatch", false);
    }
    if (!config.offlineRecipient || !config.offlineRecipientFingerprint) {
      throw new BackupPipelineFailure("offline_recipient_missing", false);
    }
    const policy = await input.policyInspect(config);
    await input.config.setValidation(policy, "backup-worker", config.generation, config.configurationIncarnationId);
    const policyFailure = hardPolicyFailure(policy);
    if (policyFailure) throw new BackupPipelineFailure(policyFailure, policyFailure === "destination_unreachable");

    const objectKey = backupObjectKey({
      prefix: config.prefix,
      deploymentId: config.deploymentId,
      retentionClass: job.retentionClass,
      startedAt: job.requestedAt,
      jobId: job.id,
    });
    const retainedUntil = config.objectLock.required
      ? job.requestedAt + retentionDays(config, job) * 86_400_000
      : undefined;
    const existing = await input.objectStore.probe(objectKey);
    if (existing) {
      if (existing.sizeBytes > MAX_BACKUP_ARCHIVE_BYTES) {
        throw new BackupPipelineFailure("archive_size_limit", false);
      }
      if (
        !job.objectVersionId ||
        !job.archiveSha256 ||
        !job.sizeBytes ||
        existing.versionId !== job.objectVersionId ||
        existing.sha256 !== job.archiveSha256 ||
        existing.sizeBytes !== job.sizeBytes
      ) {
        throw new BackupPipelineFailure("object_key_collision", false);
      }
      await input.jobs.transition(job.id, token, "dumping");
      await input.jobs.transition(job.id, token, "encrypting");
      await input.jobs.transition(job.id, token, "uploading");
      await input.jobs.recordUpload(job.id, token, {
        objectKey,
        objectVersionId: existing.versionId,
        sizeBytes: existing.sizeBytes,
        archiveSha256: existing.sha256,
        ...(existing.immutableUntil ? { immutableUntil: existing.immutableUntil } : {}),
      });
      await input.jobs.transition(job.id, token, "verifying");
      const downloaded = await input.objectStore.download(objectKey, existing.versionId, existing.sizeBytes + 1);
      const inspected = await inspectBackupArchive(downloaded);
      if (input.fullVerify) await input.fullVerify(downloaded, inspected.manifest, config);
      return input.jobs.complete(job.id, token, {
        objectKey,
        objectVersionId: existing.versionId,
        sizeBytes: existing.sizeBytes,
        archiveSha256: existing.sha256,
        ...(existing.immutableUntil ? { immutableUntil: existing.immutableUntil } : {}),
        verifiedAt: now(),
        checksumMatches: inspected.archiveSha256 === existing.sha256,
      });
    }

    scratch = await mkdtemp(join(input.scratchRoot, `${job.id}-`));
    const recipients = [config.operationalRecipient, config.offlineRecipient];
    await input.jobs.transition(job.id, token, "dumping");
    const databasePath = join(scratch, "database.dump.age");
    const metadata = await input.artifacts.database(databasePath, recipients);
    await input.jobs.transition(job.id, token, "encrypting");
    const deploymentPath = join(scratch, "deployment.tar.age");
    const secretsPath = join(scratch, "secrets.tar.age");
    await Promise.all([
      input.artifacts.deployment(deploymentPath, recipients),
      input.artifacts.secrets(secretsPath, recipients),
    ]);
    const completedAt = now();
    const componentMetadata = await Promise.all([stat(databasePath), stat(deploymentPath), stat(secretsPath)]);
    if (
      componentMetadata.some((entry) => !entry.isFile()) ||
      componentMetadata.reduce((total, entry) => total + entry.size, 0) > MAX_BACKUP_COMPONENT_BYTES
    ) {
      throw new BackupPipelineFailure("archive_size_limit", false);
    }
    const created = await createBackupArchive({
      manifest: {
        deploymentId: config.deploymentId,
        organizationId: job.organizationId,
        jobId: job.id,
        purpose: job.purpose,
        retentionClass: job.retentionClass,
        startedAt: job.startedAt ?? job.requestedAt,
        completedAt,
        sourceCommit: job.sourceRevision,
        sourceImages: input.sourceImages,
        applicationVersion: input.applicationVersion,
        postgresServerVersion: metadata.postgresServerVersion,
        postgresClientVersion: metadata.postgresClientVersion,
        protectionScope: ["database", "deployment", "root-secrets"],
        recipientFingerprints: [config.operationalRecipientFingerprint, config.offlineRecipientFingerprint],
        expectedDatabaseInvariants: metadata.expectedDatabaseInvariants,
        objectLock: retainedUntil ? { mode: "GOVERNANCE", retainUntil: new Date(retainedUntil).toISOString() } : null,
        declaredExclusions: ["external identity, Matrix, Slack, email, model-provider, and B2 account data"],
      },
      database: await readFile(databasePath),
      deployment: await readFile(deploymentPath),
      secrets: await readFile(secretsPath),
      recoveryText: [
        "QM recovery point qm-backup/v1",
        `Deployment: ${config.deploymentId}`,
        `Job: ${job.id}`,
        "Run qm backup verify before any restore.",
        "Restore only into a new empty PostgreSQL target before an approved cutover.",
        "",
      ].join("\n"),
      backupToolVersion: input.applicationVersion,
    });
    await input.jobs.transition(job.id, token, "uploading");
    const uploaded = await input.objectStore.upload(objectKey, created.bytes, created.sha256, retainedUntil);
    await input.jobs.recordUpload(job.id, token, {
      objectKey,
      objectVersionId: uploaded.versionId,
      sizeBytes: uploaded.sizeBytes,
      archiveSha256: uploaded.sha256,
      ...(uploaded.immutableUntil ? { immutableUntil: uploaded.immutableUntil } : {}),
    });
    await input.jobs.transition(job.id, token, "verifying");
    const verified = await input.objectStore.verify(
      objectKey,
      uploaded.versionId,
      created.bytes.length,
      created.sha256,
      retainedUntil,
    );
    const downloadRequired =
      job.purpose !== "scheduled" ||
      !(await input.jobs.list(job.organizationId)).some(
        (candidate) =>
          candidate.id !== job.id &&
          candidate.configurationGeneration === job.configurationGeneration &&
          candidate.configurationIncarnationId === job.configurationIncarnationId &&
          candidate.state === "complete",
      );
    if (downloadRequired) {
      const downloaded = await input.objectStore.download(objectKey, uploaded.versionId, created.bytes.length + 1);
      const inspected = await inspectBackupArchive(downloaded);
      if (inspected.archiveSha256 !== created.sha256)
        throw new BackupPipelineFailure("download_checksum_mismatch", false);
      if (input.fullVerify) await input.fullVerify(downloaded, inspected.manifest, config);
    }
    return input.jobs.complete(job.id, token, {
      objectKey,
      objectVersionId: verified.versionId,
      sizeBytes: verified.sizeBytes,
      archiveSha256: verified.sha256,
      ...(verified.immutableUntil ? { immutableUntil: verified.immutableUntil } : {}),
      verifiedAt: now(),
      checksumMatches: true,
    });
  } catch (error) {
    const failure =
      error instanceof BackupPipelineFailure
        ? error
        : new BackupPipelineFailure(
            retryable(error) ? "pipeline_temporarily_unavailable" : "pipeline_failed",
            retryable(error),
          );
    return input.jobs.fail(job.id, token, {
      retryable: failure.retryable,
      code: failure.code,
      ...(failure.retryable ? { retryAfter: now() + 60_000 } : {}),
    });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
