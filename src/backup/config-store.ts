import { randomUUID } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { recipientFingerprint } from "./age.ts";
import { normalizeB2Destination } from "./endpoint.ts";
import type {
  BackupConfigurationStatus,
  BackupDestinationValidation,
  BackupObjectLockPolicy,
  BackupRetentionPolicy,
} from "./types.ts";

export interface BackupConfigurationInput {
  enabled: boolean;
  deploymentId: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  keyId: string;
  applicationKey: string;
  operationalRecipient: string;
  scheduleIntervalMinutes: number;
  retention: BackupRetentionPolicy;
  objectLock: BackupObjectLockPolicy;
}

interface StoredBackupConfigurationBase {
  id: string;
  organizationId: string;
  generation: number;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

interface ActiveStoredBackupConfiguration extends StoredBackupConfigurationBase {
  enabled: boolean;
  suspended: boolean;
  configurationIncarnationId?: string;
  deploymentId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  keyIdEnc: string;
  applicationKeyEnc: string;
  operationalRecipient: string;
  operationalRecipientFingerprint: string;
  offlineRecipient?: string;
  offlineRecipientFingerprint?: string;
  scheduleIntervalMinutes: number;
  retention: BackupRetentionPolicy;
  objectLock: BackupObjectLockPolicy;
  recoveryKit?: BackupConfigurationStatus["recoveryKit"];
  validation?: BackupDestinationValidation;
  createdAt: number;
}

interface DeletedStoredBackupConfiguration extends StoredBackupConfigurationBase {
  deletedAt: number;
}

interface StoredBackupGenerationCounter {
  recordType: "generation-counter";
  id: string;
  organizationId: string;
  generation: number;
  updatedAt: number;
  version: string;
}

export type StoredBackupConfiguration =
  ActiveStoredBackupConfiguration | DeletedStoredBackupConfiguration | StoredBackupGenerationCounter;

export interface EffectiveBackupConfiguration extends BackupConfigurationStatus {
  credential: { keyId: string; applicationKey: string };
  operationalRecipient: string;
  offlineRecipient?: string;
}

export interface BackupConfigSnapshot {
  configuration: EffectiveBackupConfiguration | null;
  generation: number | null;
  version: string | null;
}

export interface BackupConfigReservation {
  generation: number;
  configurationIncarnationId: string;
}

export interface BackupConfigStore {
  status(): Promise<BackupConfigurationStatus | null>;
  effective(): Promise<EffectiveBackupConfiguration | null>;
  snapshot(): Promise<BackupConfigSnapshot>;
  reserveGeneration(minimumGeneration: number): Promise<BackupConfigReservation>;
  set(
    input: BackupConfigurationInput,
    actor: string,
    expectedGeneration: number | null,
    expectedIncarnationId: string | null,
    proposedIncarnationId?: string,
    proposedGeneration?: number,
    expectedVersion?: string | null,
  ): Promise<BackupConfigurationStatus>;
  setValidation(
    validation: BackupDestinationValidation,
    actor: string,
    expectedGeneration: number,
    expectedIncarnationId: string,
  ): Promise<BackupConfigurationStatus>;
  setOfflineRecipient(
    recipient: string,
    fingerprint: string,
    actor: string,
    expectedGeneration: number,
    expectedIncarnationId: string,
  ): Promise<BackupConfigurationStatus>;
  markKitIssued(
    fingerprint: string,
    actor: string,
    expectedGeneration: number,
    expectedIncarnationId: string,
    at?: number,
  ): Promise<BackupConfigurationStatus>;
  acknowledgeKit(fingerprint: string, actor: string, at?: number): Promise<BackupConfigurationStatus>;
  suspend(actor: string): Promise<BackupConfigurationStatus>;
  resume(actor: string): Promise<BackupConfigurationStatus>;
  delete(actor: string): Promise<void>;
}

function validInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateRetention(retention: BackupRetentionPolicy): BackupRetentionPolicy {
  return {
    hourlyDays: validInteger(retention.hourlyDays, 1, 3650, "retention.hourlyDays"),
    dailyDays: validInteger(retention.dailyDays, 1, 3650, "retention.dailyDays"),
    monthlyDays: validInteger(retention.monthlyDays, 1, 36500, "retention.monthlyDays"),
    predeployDays: validInteger(retention.predeployDays, 1, 3650, "retention.predeployDays"),
    manualDays: validInteger(retention.manualDays, 1, 3650, "retention.manualDays"),
  };
}

function isGenerationCounter(record: StoredBackupConfiguration): record is StoredBackupGenerationCounter {
  return "recordType" in record && record.recordType === "generation-counter";
}

function isDeleted(record: StoredBackupConfiguration): record is DeletedStoredBackupConfiguration {
  if (isGenerationCounter(record)) return false;
  return "deletedAt" in record;
}

function nextGeneration(generation: number | null): number {
  const current = generation ?? 0;
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    throw new Error("backup configuration generation is invalid");
  }
  return current + 1;
}

function generationAtLeast(generation: number | null, minimum: number | undefined): number {
  const next = nextGeneration(generation);
  if (minimum === undefined) return next;
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error("backup configuration minimum generation is invalid");
  }
  return Math.max(next, minimum);
}

function validIncarnationId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
}

function publicStatus(record: ActiveStoredBackupConfiguration): BackupConfigurationStatus {
  return {
    configured: true,
    enabled: record.enabled,
    suspended: record.suspended,
    generation: record.generation,
    ...(validIncarnationId(record.configurationIncarnationId)
      ? { configurationIncarnationId: record.configurationIncarnationId }
      : {}),
    deploymentId: record.deploymentId,
    endpoint: record.endpoint,
    region: record.region,
    bucket: record.bucket,
    prefix: record.prefix,
    hasCredential: Boolean(record.keyIdEnc && record.applicationKeyEnc),
    operationalRecipientFingerprint: record.operationalRecipientFingerprint,
    ...(record.offlineRecipientFingerprint ? { offlineRecipientFingerprint: record.offlineRecipientFingerprint } : {}),
    scheduleIntervalMinutes: record.scheduleIntervalMinutes,
    retention: record.retention,
    objectLock: record.objectLock,
    ...(record.recoveryKit ? { recoveryKit: record.recoveryKit } : {}),
    ...(record.validation ? { validation: record.validation } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export function createBackupConfigStore(
  organizationId: string,
  map: DurableMap<StoredBackupConfiguration>,
  keyMaterial: Buffer | string,
  now: () => number = Date.now,
): BackupConfigStore {
  const key = deriveConnectorKey(keyMaterial, "backup-configuration");
  const generationCounterId = `generation-counter:${organizationId}`;
  const reserveGeneration = async (minimumGeneration: number): Promise<BackupConfigReservation> => {
    if (!map.update) throw new Error("backup configuration requires atomic durable-map updates");
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 1) {
      throw new Error("backup configuration minimum generation is invalid");
    }
    const at = now();
    const updateCounter = (record: StoredBackupConfiguration): StoredBackupGenerationCounter => {
      if (!isGenerationCounter(record)) throw new Error("backup generation counter is invalid");
      return {
        ...record,
        generation: generationAtLeast(record.generation, minimumGeneration),
        updatedAt: at,
        version: `${at}:${randomUUID()}`,
      };
    };
    const updated = await map.update(generationCounterId, updateCounter);
    if (updated) {
      if (!isGenerationCounter(updated)) throw new Error("backup generation counter is invalid");
      return { generation: updated.generation, configurationIncarnationId: randomUUID() };
    }
    const candidate: StoredBackupGenerationCounter = {
      recordType: "generation-counter",
      id: generationCounterId,
      organizationId,
      generation: minimumGeneration,
      updatedAt: at,
      version: `${at}:${randomUUID()}`,
    };
    const inserted = await map.putIfAbsent(generationCounterId, candidate);
    if (isGenerationCounter(inserted) && inserted.version === candidate.version) {
      return { generation: inserted.generation, configurationIncarnationId: randomUUID() };
    }
    const raced = await map.update(generationCounterId, updateCounter);
    if (!raced || !isGenerationCounter(raced)) throw new Error("backup generation could not be reserved");
    return { generation: raced.generation, configurationIncarnationId: randomUUID() };
  };
  const atomicUpdate = async (
    fn: (record: ActiveStoredBackupConfiguration) => ActiveStoredBackupConfiguration,
  ): Promise<ActiveStoredBackupConfiguration> => {
    if (!map.update) throw new Error("backup configuration requires atomic durable-map updates");
    const updated = await map.update(organizationId, (record) => {
      if (isGenerationCounter(record) || isDeleted(record)) {
        throw new Error("backup configuration is not configured");
      }
      return fn(record);
    });
    if (!updated || isGenerationCounter(updated) || isDeleted(updated)) {
      throw new Error("backup configuration is not configured");
    }
    return updated;
  };

  const stamp = (
    record: ActiveStoredBackupConfiguration,
    actor: string,
    at = now(),
  ): ActiveStoredBackupConfiguration => ({
    ...record,
    updatedAt: at,
    updatedBy: actor,
    version: `${at}:${randomUUID()}`,
  });

  const effectiveRecord = (record: ActiveStoredBackupConfiguration): EffectiveBackupConfiguration => ({
    ...publicStatus(record),
    credential: {
      keyId: decryptSecret(record.keyIdEnc, key),
      applicationKey: decryptSecret(record.applicationKeyEnc, key),
    },
    operationalRecipient: record.operationalRecipient,
    ...(record.offlineRecipient ? { offlineRecipient: record.offlineRecipient } : {}),
  });

  return {
    async status() {
      const record = await map.get(organizationId);
      return record && !isGenerationCounter(record) && !isDeleted(record) ? publicStatus(record) : null;
    },
    async effective() {
      const record = await map.get(organizationId);
      return record && !isGenerationCounter(record) && !isDeleted(record) ? effectiveRecord(record) : null;
    },
    async snapshot() {
      const record = await map.get(organizationId);
      if (record && isGenerationCounter(record)) throw new Error("backup configuration record is invalid");
      if (record && (!record.version || typeof record.version !== "string")) {
        throw new Error("backup configuration version is invalid");
      }
      return {
        configuration: record && !isGenerationCounter(record) && !isDeleted(record) ? effectiveRecord(record) : null,
        generation: record?.generation ?? null,
        version: record?.version ?? null,
      };
    },
    reserveGeneration,
    async set(
      input,
      actor,
      expectedGeneration,
      expectedIncarnationId,
      proposedIncarnationId,
      proposedGeneration,
      expectedVersion,
    ) {
      const destination = normalizeB2Destination(input);
      const deploymentId = input.deploymentId.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/.test(deploymentId)) {
        throw new Error("deploymentId is invalid");
      }
      const scheduleIntervalMinutes = validInteger(
        input.scheduleIntervalMinutes,
        15,
        10_080,
        "scheduleIntervalMinutes",
      );
      const retention = validateRetention(input.retention);
      const objectLock = {
        required: input.objectLock.required,
        mode: "GOVERNANCE" as const,
        minimumDays: validInteger(input.objectLock.minimumDays, 1, 3650, "objectLock.minimumDays"),
      };
      const keyId = input.keyId.trim();
      const applicationKey = input.applicationKey.trim();
      if (Boolean(keyId) !== Boolean(applicationKey)) throw new Error("keyId and applicationKey must both be provided");
      const at = now();
      const reservation =
        proposedGeneration === undefined
          ? await reserveGeneration(nextGeneration(expectedGeneration))
          : {
              generation: proposedGeneration,
              configurationIncarnationId: validIncarnationId(proposedIncarnationId)
                ? proposedIncarnationId
                : randomUUID(),
            };
      if (!Number.isSafeInteger(reservation.generation) || reservation.generation < 1) {
        throw new Error("backup configuration proposed generation is invalid");
      }
      const build = (current: StoredBackupConfiguration | null): ActiveStoredBackupConfiguration => {
        if (current && isGenerationCounter(current)) throw new Error("backup configuration record is invalid");
        const currentIncarnationId =
          current && !isGenerationCounter(current) && !isDeleted(current)
            ? (current.configurationIncarnationId ?? null)
            : null;
        if (
          (current?.generation ?? null) !== expectedGeneration ||
          currentIncarnationId !== expectedIncarnationId ||
          (expectedVersion !== undefined && (current?.version ?? null) !== expectedVersion)
        ) {
          throw new Error("backup configuration changed while the candidate was being validated");
        }
        const active = current && !isGenerationCounter(current) && !isDeleted(current) ? current : null;
        if (reservation.generation <= (current?.generation ?? 0)) {
          throw new Error("backup configuration proposed generation is stale");
        }
        if (!active && (!keyId || !applicationKey)) throw new Error("B2 credentials are required for initial setup");
        const operationalRecipient = input.operationalRecipient.trim() || active?.operationalRecipient || "";
        if (!operationalRecipient.startsWith("age1") || operationalRecipient.length > 1000) {
          throw new Error("operationalRecipient must be an age recipient");
        }
        let configurationIncarnationId = validIncarnationId(proposedIncarnationId)
          ? proposedIncarnationId
          : reservation.configurationIncarnationId;
        if (validIncarnationId(active?.configurationIncarnationId)) {
          configurationIncarnationId = active.configurationIncarnationId;
        }
        return {
          id: organizationId,
          organizationId,
          enabled: input.enabled,
          suspended: active?.suspended ?? false,
          generation: reservation.generation,
          configurationIncarnationId,
          deploymentId,
          ...destination,
          keyIdEnc: keyId ? encryptSecret(keyId, key) : active!.keyIdEnc,
          applicationKeyEnc: applicationKey ? encryptSecret(applicationKey, key) : active!.applicationKeyEnc,
          operationalRecipient,
          operationalRecipientFingerprint: recipientFingerprint(operationalRecipient),
          ...(active?.offlineRecipient ? { offlineRecipient: active.offlineRecipient } : {}),
          ...(active?.offlineRecipientFingerprint
            ? { offlineRecipientFingerprint: active.offlineRecipientFingerprint }
            : {}),
          scheduleIntervalMinutes,
          retention,
          objectLock,
          createdAt: active?.createdAt ?? at,
          updatedAt: at,
          updatedBy: actor,
          version: `${at}:${randomUUID()}`,
        };
      };
      if (map.update) {
        const updated = await map.update(organizationId, (current) => build(current));
        if (updated && !isGenerationCounter(updated) && !isDeleted(updated)) return publicStatus(updated);
      }
      if (expectedGeneration !== null) {
        throw new Error("backup configuration changed while the candidate was being validated");
      }
      const candidate = build(null);
      const inserted = await map.putIfAbsent(organizationId, candidate);
      if (inserted.version === candidate.version && !isGenerationCounter(inserted) && !isDeleted(inserted)) {
        return publicStatus(inserted);
      }
      throw new Error("backup configuration changed while the candidate was being validated");
    },
    async setValidation(validation, actor, expectedGeneration, expectedIncarnationId) {
      return publicStatus(
        await atomicUpdate((record) => {
          if (record.generation !== expectedGeneration || record.configurationIncarnationId !== expectedIncarnationId) {
            throw new Error("backup configuration changed during destination validation");
          }
          return stamp({ ...record, validation: structuredClone(validation) }, actor);
        }),
      );
    },
    async setOfflineRecipient(recipient, fingerprint, actor, expectedGeneration, expectedIncarnationId) {
      const normalized = recipient.trim();
      if (!normalized.startsWith("age1") || recipientFingerprint(normalized) !== fingerprint) {
        throw new Error("offline recovery recipient fingerprint does not match");
      }
      const reservation = await reserveGeneration(nextGeneration(expectedGeneration));
      return publicStatus(
        await atomicUpdate((record) => {
          if (record.generation !== expectedGeneration || record.configurationIncarnationId !== expectedIncarnationId) {
            throw new Error("backup configuration changed during recovery-kit issuance");
          }
          if (!validIncarnationId(record.configurationIncarnationId)) {
            throw new Error("backup configuration must be reconfigured before recovery-kit issuance");
          }
          const updated = stamp(
            {
              ...record,
              generation: reservation.generation,
              offlineRecipient: normalized,
              offlineRecipientFingerprint: fingerprint,
            },
            actor,
          );
          delete updated.recoveryKit;
          return updated;
        }),
      );
    },
    async markKitIssued(fingerprint, actor, expectedGeneration, expectedIncarnationId, at = now()) {
      return publicStatus(
        await atomicUpdate((record) => {
          if (record.generation !== expectedGeneration || record.configurationIncarnationId !== expectedIncarnationId) {
            throw new Error("backup configuration changed during recovery-kit issuance");
          }
          if (record.offlineRecipientFingerprint !== fingerprint) {
            throw new Error("recovery-kit fingerprint does not match the configured offline recipient");
          }
          if (!validIncarnationId(record.configurationIncarnationId)) {
            throw new Error("backup configuration must be reconfigured before recovery-kit issuance");
          }
          return stamp(
            {
              ...record,
              recoveryKit: {
                fingerprint,
                configurationGeneration: record.generation,
                configurationIncarnationId: record.configurationIncarnationId,
                issuedAt: at,
                issuedBy: actor,
              },
            },
            actor,
            at,
          );
        }),
      );
    },
    async acknowledgeKit(fingerprint, actor, at = now()) {
      return publicStatus(
        await atomicUpdate((record) => {
          if (
            !record.recoveryKit ||
            record.recoveryKit.fingerprint !== fingerprint ||
            record.recoveryKit.configurationGeneration !== record.generation ||
            !validIncarnationId(record.configurationIncarnationId) ||
            record.recoveryKit.configurationIncarnationId !== record.configurationIncarnationId
          ) {
            throw new Error("recovery-kit fingerprint does not match the issued kit");
          }
          return stamp(
            {
              ...record,
              recoveryKit: { ...record.recoveryKit, acknowledgedAt: at, acknowledgedBy: actor },
            },
            actor,
            at,
          );
        }),
      );
    },
    async suspend(actor) {
      return publicStatus(await atomicUpdate((record) => stamp({ ...record, suspended: true }, actor)));
    },
    async resume(actor) {
      return publicStatus(await atomicUpdate((record) => stamp({ ...record, suspended: false }, actor)));
    },
    async delete(actor) {
      if (!map.update) throw new Error("backup configuration requires atomic durable-map updates");
      const current = await map.get(organizationId);
      if (current && isGenerationCounter(current)) throw new Error("backup configuration record is invalid");
      const expectedVersion = current?.version ?? null;
      const reservation = await reserveGeneration(nextGeneration(current?.generation ?? null));
      const at = now();
      const tombstone: DeletedStoredBackupConfiguration = {
        id: organizationId,
        organizationId,
        generation: reservation.generation,
        deletedAt: at,
        updatedAt: at,
        updatedBy: actor,
        version: `${at}:${randomUUID()}`,
      };
      if (current) {
        const updated = await map.update(organizationId, (record) => {
          if (isGenerationCounter(record) || record.version !== expectedVersion) {
            throw new Error("backup configuration changed during deletion");
          }
          return tombstone;
        });
        if (updated) return;
        throw new Error("backup configuration changed during deletion");
      }
      const inserted = await map.putIfAbsent(organizationId, tombstone);
      if (inserted.version === tombstone.version) return;
      throw new Error("backup configuration changed during deletion");
    },
  };
}
