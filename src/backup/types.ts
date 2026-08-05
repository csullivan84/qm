export type BackupRetentionClass = "hourly" | "daily" | "monthly" | "predeploy" | "manual";
export type BackupPurpose = "scheduled" | "manual" | "predeploy";
export type BackupJobState =
  | "queued"
  | "preparing"
  | "dumping"
  | "encrypting"
  | "uploading"
  | "verifying"
  | "complete"
  | "retryable_failure"
  | "terminal_failure"
  | "cancelled";
export type PolicyCheck = "pass" | "fail" | "unavailable";

export interface BackupRetentionPolicy {
  hourlyDays: number;
  dailyDays: number;
  monthlyDays: number;
  predeployDays: number;
  manualDays: number;
}

export interface BackupObjectLockPolicy {
  required: boolean;
  mode: "GOVERNANCE";
  minimumDays: number;
}

export interface BackupDestinationValidation {
  checkedAt: number;
  reachable: PolicyCheck;
  private: PolicyCheck;
  bucketScoped: PolicyCheck;
  leastPrivilege: PolicyCheck;
  serverSideEncryption: PolicyCheck;
  lifecycle: PolicyCheck;
  objectLock: PolicyCheck;
  safeCode?: string;
  unnecessaryCapabilities?: string[];
}

export interface BackupConfigurationStatus {
  configured: true;
  enabled: boolean;
  suspended: boolean;
  generation: number;
  configurationIncarnationId?: string;
  deploymentId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  hasCredential: boolean;
  operationalRecipientFingerprint: string;
  offlineRecipientFingerprint?: string;
  scheduleIntervalMinutes: number;
  retention: BackupRetentionPolicy;
  objectLock: BackupObjectLockPolicy;
  recoveryKit?: {
    fingerprint: string;
    configurationGeneration: number;
    configurationIncarnationId?: string;
    issuedAt: number;
    issuedBy?: string;
    acknowledgedAt?: number;
    acknowledgedBy?: string;
  };
  validation?: BackupDestinationValidation;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface BackupJob {
  id: string;
  organizationId: string;
  deploymentId: string;
  configurationGeneration: number;
  configurationIncarnationId?: string;
  purpose: BackupPurpose;
  retentionClass: BackupRetentionClass;
  state: BackupJobState;
  requestedAt: number;
  scheduledFor?: number;
  startedAt?: number;
  completedAt?: number;
  requestedBy: string;
  idempotencyKey: string;
  sourceRevision: string;
  attemptCount: number;
  retryAfter?: number;
  leaseToken?: string;
  leaseHolder?: string;
  leaseHeartbeatAt?: number;
  leaseExpiresAt?: number;
  objectKey?: string;
  objectVersionId?: string;
  sizeBytes?: number;
  archiveSha256?: string;
  immutableUntil?: number;
  verifiedAt?: number;
  checksumMatches?: boolean;
  restoreDrillAt?: number;
  errorCode?: string;
  safeDetail?: string;
}

export interface RestoreDrill {
  id: string;
  sourceBackupId: string;
  organizationId: string;
  configurationGeneration: number;
  configurationIncarnationId?: string;
  state: "queued" | "running" | "complete" | "failed";
  requestedAt: number;
  requestedBy?: string;
  idempotencyKey?: string;
  startedAt?: number;
  completedAt?: number;
  targetPostgresServerVersionNum: number;
  downloadVerified?: boolean;
  checksumVerified?: boolean;
  decrypted?: boolean;
  restored?: boolean;
  invariants?: {
    postgresVersion: boolean;
    postgresServerVersionNum: number;
    schema: boolean;
    rowBounds: boolean;
    organization: boolean;
    timestamps: boolean;
    applicationHealth: boolean;
  };
  cleanup?: boolean;
  durationMs?: number;
  errorCode?: string;
  verifierVersion: string;
  leaseToken?: string;
  leaseHolder?: string;
  leaseExpiresAt?: number;
}

export interface BackupWorkerHeartbeat {
  id: string;
  holder: string;
  generation: number;
  configurationIncarnationId?: string;
  at: number;
}

export interface BackupAuditEvent {
  id: string;
  organizationId: string;
  at: number;
  actor: string;
  action: string;
  resource: string;
  detail: Record<string, string | number | boolean | null>;
}

export type BackupProtectionState =
  "Unconfigured" | "Setting up" | "Protected" | "Degraded" | "Failed" | "Suspended" | "Restoring";

export interface BackupProtectionCondition {
  code: string;
  state: "pass" | "fail" | "unavailable";
  summary: string;
}

export interface BackupProtectionStatus {
  state: BackupProtectionState;
  evaluatedAt: number;
  conditions: BackupProtectionCondition[];
  latestBackupId?: string;
  latestVerifiedAt?: number;
  latestRestoreDrillAt?: number;
  workerHeartbeatAt?: number;
}
