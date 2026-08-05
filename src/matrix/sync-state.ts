import { createHash, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface MatrixSyncStateRecord {
  id: string;
  cursor?: string;
  leaseToken?: string;
  leaseHolder?: string;
  leaseExpiresAt?: number;
  updatedAt: number;
}

export class MatrixSyncLeaseError extends Error {}

export interface MatrixSyncStateStore {
  identityKey(homeserverUrl: string, botUserId: string, generation?: string): string;
  claim(id: string, holder: string, ttlMs: number): Promise<{ token: string } | null>;
  cursor(id: string, token: string): Promise<string | null>;
  advance(id: string, token: string, cursor: string, ttlMs: number): Promise<void>;
  heartbeat(id: string, token: string, ttlMs: number): Promise<void>;
  release(id: string, token: string): Promise<void>;
}

export function matrixSyncIdentityKey(homeserverUrl: string, botUserId: string, generation?: string): string {
  const url = new URL(homeserverUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const digest = createHash("sha256")
    .update(`${url.toString()}\0${botUserId.trim()}\0${generation?.trim() ?? ""}`)
    .digest("hex");
  return `matrix:${digest}`;
}

export function createMatrixSyncStateStore(
  map: DurableMap<MatrixSyncStateRecord>,
  now: () => number = Date.now,
): MatrixSyncStateStore {
  const update = async (
    id: string,
    fn: (record: MatrixSyncStateRecord) => MatrixSyncStateRecord,
  ): Promise<MatrixSyncStateRecord> => {
    if (!map.update) throw new Error("Matrix sync state requires atomic durable-map updates");
    const record = await map.update(id, fn);
    if (!record) throw new MatrixSyncLeaseError("Matrix sync lease state is missing");
    return record;
  };

  const requireLease = (record: MatrixSyncStateRecord, token: string): void => {
    if (record.leaseToken !== token || !record.leaseExpiresAt || record.leaseExpiresAt <= now()) {
      throw new MatrixSyncLeaseError("Matrix sync lease is not active");
    }
  };

  return {
    identityKey: matrixSyncIdentityKey,
    async claim(id, holder, ttlMs) {
      const claimedAt = now();
      const token = randomUUID();
      await map.putIfAbsent(id, { id, updatedAt: claimedAt });
      const record = await update(id, (current) => {
        if (current.leaseToken && current.leaseExpiresAt && current.leaseExpiresAt > claimedAt) return current;
        return {
          ...current,
          leaseToken: token,
          leaseHolder: holder,
          leaseExpiresAt: claimedAt + ttlMs,
          updatedAt: claimedAt,
        };
      });
      return record.leaseToken === token ? { token } : null;
    },
    async cursor(id, token) {
      const record = await map.get(id);
      if (!record) throw new MatrixSyncLeaseError("Matrix sync lease state is missing");
      requireLease(record, token);
      return record.cursor ?? null;
    },
    async advance(id, token, cursor, ttlMs) {
      const advancedAt = now();
      await update(id, (record) => {
        requireLease(record, token);
        return { ...record, cursor, leaseExpiresAt: advancedAt + ttlMs, updatedAt: advancedAt };
      });
    },
    async heartbeat(id, token, ttlMs) {
      const heartbeatAt = now();
      await update(id, (record) => {
        requireLease(record, token);
        return { ...record, leaseExpiresAt: heartbeatAt + ttlMs, updatedAt: heartbeatAt };
      });
    },
    async release(id, token) {
      await update(id, (record) => {
        if (record.leaseToken !== token) return record;
        const { leaseToken: _token, leaseHolder: _holder, leaseExpiresAt: _expiresAt, ...released } = record;
        return { ...released, updatedAt: now() };
      });
    },
  };
}
