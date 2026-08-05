import { createHash, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { BackupJob, BackupJobState, BackupPurpose, BackupRetentionClass, BackupWorkerHeartbeat } from "./types.ts";

export type { BackupJob, BackupWorkerHeartbeat } from "./types.ts";

export interface BackupDeploymentLease {
  id: string;
  jobId?: string;
  token?: string;
  holder?: string;
  heartbeatAt?: number;
  expiresAt?: number;
  updatedAt: number;
}

export interface BackupJobRequest {
  organizationId: string;
  deploymentId: string;
  configurationGeneration: number;
  configurationIncarnationId: string;
  purpose: BackupPurpose;
  retentionClass: BackupRetentionClass;
  requestedBy: string;
  idempotencyKey: string;
  sourceRevision: string;
  scheduledFor?: number;
}

export interface BackupJobStore {
  request(input: BackupJobRequest): Promise<BackupJob>;
  get(id: string): Promise<BackupJob | null>;
  list(organizationId?: string): Promise<BackupJob[]>;
  claim(holder: string, ttlMs: number): Promise<{ job: BackupJob; token: string } | null>;
  heartbeat(id: string, token: string, ttlMs: number): Promise<void>;
  transition(id: string, token: string, state: BackupJobState): Promise<BackupJob>;
  recordUpload(
    id: string,
    token: string,
    result: {
      objectKey: string;
      objectVersionId: string;
      sizeBytes: number;
      archiveSha256: string;
      immutableUntil?: number;
    },
  ): Promise<BackupJob>;
  complete(
    id: string,
    token: string,
    result: {
      objectKey: string;
      objectVersionId: string;
      sizeBytes: number;
      archiveSha256: string;
      immutableUntil?: number;
      verifiedAt: number;
      checksumMatches: boolean;
    },
  ): Promise<BackupJob>;
  fail(
    id: string,
    token: string,
    failure: { retryable: boolean; code: string; safeDetail?: string; retryAfter?: number },
  ): Promise<BackupJob>;
  workerHeartbeat(holder: string, generation: number, configurationIncarnationId?: string): Promise<void>;
  latestWorkerHeartbeat(): Promise<BackupWorkerHeartbeat | null>;
  retry(id: string): Promise<BackupJob>;
}

const PROCESSING = new Set<BackupJobState>(["preparing", "dumping", "encrypting", "uploading", "verifying"]);
const TRANSITIONS: Partial<Record<BackupJobState, BackupJobState[]>> = {
  preparing: ["dumping", "retryable_failure", "terminal_failure", "cancelled"],
  dumping: ["encrypting", "retryable_failure", "terminal_failure", "cancelled"],
  encrypting: ["uploading", "retryable_failure", "terminal_failure", "cancelled"],
  uploading: ["verifying", "retryable_failure", "terminal_failure", "cancelled"],
  verifying: ["complete", "retryable_failure", "terminal_failure", "cancelled"],
};

function jobId(input: BackupJobRequest): string {
  const digest = createHash("sha256")
    .update(`${input.organizationId}\0${input.idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `bkp_${digest}`;
}

function clearJobLease(job: BackupJob): BackupJob {
  const {
    leaseToken: _token,
    leaseHolder: _holder,
    leaseHeartbeatAt: _heartbeat,
    leaseExpiresAt: _expires,
    ...released
  } = job;
  return released;
}

export function createBackupJobStore(
  jobs: DurableMap<BackupJob>,
  leases: DurableMap<BackupDeploymentLease>,
  workerHeartbeats: DurableMap<BackupWorkerHeartbeat>,
  now: () => number = Date.now,
): BackupJobStore {
  if (!jobs.update || !leases.update) throw new Error("backup jobs require atomic durable-map updates");

  const requireLease = (job: BackupJob, token: string): void => {
    if (job.leaseToken !== token || !job.leaseExpiresAt || job.leaseExpiresAt <= now()) {
      throw new Error("backup job lease is not active");
    }
  };

  const releaseDeployment = async (job: BackupJob, token: string): Promise<void> => {
    const id = `${job.organizationId}:${job.deploymentId}`;
    await leases.update!(id, (lease) => {
      if (lease.token !== token) return lease;
      return { id, updatedAt: now() };
    });
  };

  return {
    async request(input) {
      if (!input.idempotencyKey || input.idempotencyKey.length > 200)
        throw new Error("backup idempotency key is invalid");
      const id = jobId(input);
      const candidate: BackupJob = {
        id,
        organizationId: input.organizationId,
        deploymentId: input.deploymentId,
        configurationGeneration: input.configurationGeneration,
        configurationIncarnationId: input.configurationIncarnationId,
        purpose: input.purpose,
        retentionClass: input.retentionClass,
        state: "queued",
        requestedAt: now(),
        ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
        sourceRevision: input.sourceRevision,
        attemptCount: 0,
      };
      const stored = await jobs.putIfAbsent(id, candidate);
      if (
        stored.organizationId !== input.organizationId ||
        stored.deploymentId !== input.deploymentId ||
        stored.configurationGeneration !== input.configurationGeneration ||
        stored.configurationIncarnationId !== input.configurationIncarnationId ||
        stored.purpose !== input.purpose ||
        stored.retentionClass !== input.retentionClass ||
        stored.sourceRevision !== input.sourceRevision
      ) {
        throw new Error("backup idempotency key conflicts with a different request");
      }
      return stored;
    },
    get(id) {
      return jobs.get(id);
    },
    async list(organizationId) {
      return (await jobs.all())
        .filter((job) => !organizationId || job.organizationId === organizationId)
        .sort((first, second) => second.requestedAt - first.requestedAt);
    },
    async claim(holder, ttlMs) {
      const claimedAt = now();
      const candidates = (await jobs.all())
        .filter(
          (job) =>
            job.state === "queued" ||
            (job.state === "retryable_failure" && (job.retryAfter ?? 0) <= claimedAt) ||
            (PROCESSING.has(job.state) && (job.leaseExpiresAt ?? 0) <= claimedAt),
        )
        .sort(
          (first, second) => (first.scheduledFor ?? first.requestedAt) - (second.scheduledFor ?? second.requestedAt),
        );
      for (const candidate of candidates) {
        const leaseId = `${candidate.organizationId}:${candidate.deploymentId}`;
        const token = randomUUID();
        await leases.putIfAbsent(leaseId, { id: leaseId, updatedAt: claimedAt });
        const deploymentLease = await leases.update!(leaseId, (lease) => {
          if (lease.token && lease.expiresAt && lease.expiresAt > claimedAt) return lease;
          return {
            id: leaseId,
            jobId: candidate.id,
            token,
            holder,
            heartbeatAt: claimedAt,
            expiresAt: claimedAt + ttlMs,
            updatedAt: claimedAt,
          };
        });
        if (deploymentLease?.token !== token) continue;
        const claimed = await jobs.update!(candidate.id, (job) => {
          const eligible =
            job.state === "queued" ||
            (job.state === "retryable_failure" && (job.retryAfter ?? 0) <= claimedAt) ||
            (PROCESSING.has(job.state) && (job.leaseExpiresAt ?? 0) <= claimedAt);
          if (!eligible) return job;
          return {
            ...job,
            state: "preparing",
            startedAt: job.startedAt ?? claimedAt,
            attemptCount: job.attemptCount + 1,
            leaseToken: token,
            leaseHolder: holder,
            leaseHeartbeatAt: claimedAt,
            leaseExpiresAt: claimedAt + ttlMs,
          };
        });
        if (claimed?.leaseToken === token) return { job: claimed, token };
        await releaseDeployment(candidate, token);
      }
      return null;
    },
    async heartbeat(id, token, ttlMs) {
      const heartbeatAt = now();
      const job = await jobs.update!(id, (current) => {
        requireLease(current, token);
        return { ...current, leaseHeartbeatAt: heartbeatAt, leaseExpiresAt: heartbeatAt + ttlMs };
      });
      if (!job) throw new Error("backup job does not exist");
      const leaseId = `${job.organizationId}:${job.deploymentId}`;
      await leases.update!(leaseId, (lease) => {
        if (lease.token !== token) throw new Error("backup deployment lease is not active");
        return { ...lease, heartbeatAt, expiresAt: heartbeatAt + ttlMs, updatedAt: heartbeatAt };
      });
    },
    async transition(id, token, state) {
      const updated = await jobs.update!(id, (job) => {
        requireLease(job, token);
        if (!TRANSITIONS[job.state]?.includes(state))
          throw new Error(`invalid backup transition ${job.state} -> ${state}`);
        return { ...job, state };
      });
      if (!updated) throw new Error("backup job does not exist");
      return updated;
    },
    async complete(id, token, result) {
      const completedAt = now();
      const updated = await jobs.update!(id, (job) => {
        requireLease(job, token);
        if (job.state !== "verifying") throw new Error(`invalid backup completion from ${job.state}`);
        if (
          !result.objectVersionId.trim() ||
          job.objectKey !== result.objectKey ||
          job.objectVersionId !== result.objectVersionId ||
          job.archiveSha256 !== result.archiveSha256 ||
          job.sizeBytes !== result.sizeBytes
        ) {
          throw new Error("backup completion does not match the pinned uploaded version");
        }
        return clearJobLease({
          ...job,
          state: "complete",
          completedAt,
          objectKey: result.objectKey,
          objectVersionId: result.objectVersionId,
          sizeBytes: result.sizeBytes,
          archiveSha256: result.archiveSha256,
          ...(result.immutableUntil ? { immutableUntil: result.immutableUntil } : {}),
          verifiedAt: result.verifiedAt,
          checksumMatches: result.checksumMatches,
        });
      });
      if (!updated) throw new Error("backup job does not exist");
      await releaseDeployment(updated, token);
      return updated;
    },
    async recordUpload(id, token, result) {
      const updated = await jobs.update!(id, (job) => {
        requireLease(job, token);
        if (job.state !== "uploading") throw new Error(`invalid backup upload record from ${job.state}`);
        if (!result.objectVersionId.trim()) throw new Error("backup object version identifier is required");
        if (
          job.objectKey &&
          (job.objectKey !== result.objectKey ||
            job.objectVersionId !== result.objectVersionId ||
            job.archiveSha256 !== result.archiveSha256 ||
            job.sizeBytes !== result.sizeBytes)
        ) {
          throw new Error("backup retry artifact does not match the recorded upload");
        }
        return {
          ...job,
          objectKey: result.objectKey,
          objectVersionId: result.objectVersionId,
          sizeBytes: result.sizeBytes,
          archiveSha256: result.archiveSha256,
          ...(result.immutableUntil ? { immutableUntil: result.immutableUntil } : {}),
        };
      });
      if (!updated) throw new Error("backup job does not exist");
      return updated;
    },
    async fail(id, token, failure) {
      const failedAt = now();
      const updated = await jobs.update!(id, (job) => {
        requireLease(job, token);
        return clearJobLease({
          ...job,
          state: failure.retryable ? "retryable_failure" : "terminal_failure",
          ...(failure.retryable ? { retryAfter: failure.retryAfter ?? failedAt } : { completedAt: failedAt }),
          errorCode: failure.code,
          ...(failure.safeDetail ? { safeDetail: failure.safeDetail } : {}),
        });
      });
      if (!updated) throw new Error("backup job does not exist");
      await releaseDeployment(updated, token);
      return updated;
    },
    async workerHeartbeat(holder, generation, configurationIncarnationId) {
      await workerHeartbeats.put("backup-worker", {
        id: "backup-worker",
        holder,
        generation,
        ...(configurationIncarnationId ? { configurationIncarnationId } : {}),
        at: now(),
      });
    },
    latestWorkerHeartbeat() {
      return workerHeartbeats.get("backup-worker");
    },
    async retry(id) {
      const updated = await jobs.update!(id, (job) => {
        if (job.state !== "retryable_failure" && job.state !== "terminal_failure") {
          throw new Error("only a failed backup job can be retried");
        }
        const {
          errorCode: _errorCode,
          safeDetail: _safeDetail,
          retryAfter: _retryAfter,
          completedAt: _completedAt,
          ...retrying
        } = job;
        return { ...retrying, state: "queued" };
      });
      if (!updated) throw new Error("backup job does not exist");
      return updated;
    },
  };
}
