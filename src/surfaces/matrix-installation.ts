import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { MatrixPluginConfig } from "../matrix/config.ts";
import { createMatrixClient } from "../matrix/client.ts";

type StoredMatrixPolicy = Omit<MatrixPluginConfig, "accessToken">;

interface ActiveMatrixInstallation {
  orgId: string;
  disabled: false;
  accessTokenEnc: string;
  policy: StoredMatrixPolicy;
  botUserId?: string;
  syncGeneration?: string;
  updatedAt: number;
  updatedBy: string;
  version: string;
  processingLeases?: Record<string, number>;
}

interface DisabledMatrixInstallation {
  orgId: string;
  disabled: true;
  updatedAt: number;
  updatedBy: string;
  version: string;
  processingLeases?: Record<string, number>;
}

export type StoredMatrixInstallation = ActiveMatrixInstallation | DisabledMatrixInstallation;

export type MatrixInstallationStatus =
  | { configured: false; managed: boolean }
  | ({
      configured: true;
      managed: true;
      botUserId?: string;
      updatedAt: number;
      updatedBy: string;
      version: string;
    } & Omit<MatrixPluginConfig, "accessToken" | "syncCursorPath">);

export interface MatrixInstallationStore {
  get(): Promise<MatrixPluginConfig | null>;
  runtime(): Promise<{ config: MatrixPluginConfig; version: string; syncGeneration: string } | null>;
  status(): Promise<MatrixInstallationStatus>;
  set(input: { config: MatrixPluginConfig; botUserId?: string; updatedBy: string }): Promise<MatrixInstallationStatus>;
  acquireProcessingLease(expectedVersion: string, token: string, expiresAt: number): Promise<boolean>;
  renewProcessingLease(token: string, expiresAt: number): Promise<boolean>;
  releaseProcessingLease(token: string): Promise<void>;
  delete(updatedBy: string): Promise<void>;
}

function activeProcessingLeases(record: StoredMatrixInstallation, at = Date.now()): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record.processingLeases ?? {}).filter(
      ([token, expiresAt]) => Boolean(token) && Number.isSafeInteger(expiresAt) && expiresAt > at,
    ),
  );
}

function withProcessingLeases<T extends StoredMatrixInstallation>(record: T, leases: Record<string, number>): T {
  const { processingLeases: _previous, ...withoutLeases } = record;
  return {
    ...withoutLeases,
    ...(Object.keys(leases).length ? { processingLeases: leases } : {}),
  } as T;
}

export function createMatrixInstallationStore(
  orgId: string,
  map: DurableMap<StoredMatrixInstallation>,
  keyMaterial: Buffer | string,
  syncCursorPath?: string,
): MatrixInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "matrix-installation");
  const publicStatus = (record: StoredMatrixInstallation | null): MatrixInstallationStatus => {
    if (!record || record.disabled) return { configured: false, managed: record !== null };
    const { syncCursorPath: _syncCursorPath, ...policy } = record.policy;
    return {
      configured: true,
      managed: true,
      ...policy,
      ...(record.botUserId ? { botUserId: record.botUserId } : {}),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      version: record.version,
    };
  };
  return {
    async get() {
      const record = await map.get(orgId);
      if (!record || record.disabled) return null;
      return { ...record.policy, accessToken: decryptSecret(record.accessTokenEnc, key) };
    },
    async runtime() {
      const record = await map.get(orgId);
      if (!record || record.disabled) return null;
      return {
        config: { ...record.policy, accessToken: decryptSecret(record.accessTokenEnc, key) },
        version: record.version,
        syncGeneration: record.syncGeneration ?? record.version,
      };
    },
    async status() {
      return publicStatus(await map.get(orgId));
    },
    async set(input) {
      if (!map.update) throw new Error("Matrix installation fencing requires atomic durable-map updates");
      const updatedAt = Date.now();
      const { accessToken, ...inputPolicy } = input.config;
      const policy = { ...inputPolicy, ...(syncCursorPath ? { syncCursorPath } : {}) };
      const accessTokenEnc = encryptSecret(accessToken, key);
      const build = (previous: StoredMatrixInstallation | null): ActiveMatrixInstallation => {
        const processingLeases = previous ? activeProcessingLeases(previous, updatedAt) : {};
        return {
          orgId,
          disabled: false,
          accessTokenEnc,
          policy,
          ...(input.botUserId ? { botUserId: input.botUserId } : {}),
          syncGeneration:
            previous && !previous.disabled ? (previous.syncGeneration ?? previous.version) : crypto.randomUUID(),
          updatedAt,
          updatedBy: input.updatedBy,
          version: `${updatedAt}:${crypto.randomUUID()}`,
          ...(Object.keys(processingLeases).length ? { processingLeases } : {}),
        };
      };
      let record = await map.update(orgId, (previous) => build(previous));
      if (!record) {
        const candidate = build(null);
        const inserted = await map.putIfAbsent(orgId, candidate);
        record =
          inserted.version === candidate.version ? candidate : await map.update(orgId, (previous) => build(previous));
      }
      if (!record || record.disabled) throw new Error("Matrix installation could not be stored atomically");
      return publicStatus(record);
    },
    async acquireProcessingLease(expectedVersion, token, expiresAt) {
      if (!map.update) throw new Error("Matrix installation fencing requires atomic durable-map updates");
      if (!token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        throw new Error("Matrix processing lease is invalid");
      }
      let acquired = false;
      await map.update(orgId, (record) => {
        const processingLeases = activeProcessingLeases(record);
        if (!record.disabled && record.version === expectedVersion) {
          processingLeases[token] = expiresAt;
          acquired = true;
        }
        return withProcessingLeases(record, processingLeases);
      });
      return acquired;
    },
    async renewProcessingLease(token, expiresAt) {
      if (!map.update) throw new Error("Matrix installation fencing requires atomic durable-map updates");
      if (!token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        throw new Error("Matrix processing lease is invalid");
      }
      let renewed = false;
      await map.update(orgId, (record) => {
        const processingLeases = activeProcessingLeases(record);
        if (processingLeases[token]) {
          processingLeases[token] = expiresAt;
          renewed = true;
        }
        return withProcessingLeases(record, processingLeases);
      });
      return renewed;
    },
    async releaseProcessingLease(token) {
      if (!map.update) throw new Error("Matrix installation fencing requires atomic durable-map updates");
      await map.update(orgId, (record) => {
        const processingLeases = activeProcessingLeases(record);
        delete processingLeases[token];
        return withProcessingLeases(record, processingLeases);
      });
    },
    async delete(updatedBy) {
      const updatedAt = Date.now();
      const version = `${updatedAt}:${crypto.randomUUID()}`;
      const build = (previous: StoredMatrixInstallation | null): DisabledMatrixInstallation => {
        const processingLeases = previous ? activeProcessingLeases(previous, updatedAt) : {};
        return {
          orgId,
          disabled: true,
          updatedAt,
          updatedBy,
          version,
          ...(Object.keys(processingLeases).length ? { processingLeases } : {}),
        };
      };
      if (!map.update) throw new Error("Matrix installation fencing requires atomic durable-map updates");
      let disabled = await map.update(orgId, (previous) => build(previous));
      if (!disabled) {
        const candidate = build(null);
        const inserted = await map.putIfAbsent(orgId, candidate);
        disabled = inserted.version === version ? candidate : await map.update(orgId, (previous) => build(previous));
      }
      if (!disabled || !disabled.disabled || disabled.version !== version) {
        throw new Error("Matrix installation could not be disabled atomically");
      }
      for (;;) {
        const current = await map.get(orgId);
        if (!current || !current.disabled || current.version !== version) {
          throw new Error("Matrix installation changed while disable was draining active events");
        }
        const leases = activeProcessingLeases(current);
        if (!Object.keys(leases).length) {
          if (current.processingLeases) {
            await map.update(orgId, (record) =>
              record.disabled && record.version === version ? withProcessingLeases(record, {}) : record,
            );
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

export async function validateMatrixInstallation(
  config: MatrixPluginConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ botUserId: string }> {
  const matrix = createMatrixClient(config, fetchImpl);
  const { userId: botUserId } = await matrix.whoAmI();
  const allowedUsers = new Set(config.allowedUserIds);
  for (const roomId of config.allowedRoomIds) {
    const [members, security] = await Promise.all([matrix.joinedMembers(roomId), matrix.roomSecurity(roomId)]);
    if (
      security.encrypted ||
      security.joinRule !== "invite" ||
      security.historyVisibility !== "joined" ||
      security.guestAccess !== "forbidden"
    ) {
      throw new Error(`${roomId} must be unencrypted, invite-only, joined-history, and guest-forbidden`);
    }
    const participants = new Set(security.participatingUserIds);
    if (!participants.has(botUserId) || !members.some((member) => member.userId === botUserId)) {
      throw new Error(`${roomId} does not contain the Matrix bot`);
    }
    const unapproved = [...participants, ...members.map((member) => member.userId)].find(
      (userId) => userId !== botUserId && !allowedUsers.has(userId),
    );
    if (unapproved) throw new Error(`${roomId} contains unapproved participant ${unapproved}`);
  }
  return { botUserId };
}
