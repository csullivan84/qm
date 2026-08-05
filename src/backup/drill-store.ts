import { createHash, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { RestoreDrill } from "./types.ts";

interface RestoreDrillRequest {
  organizationId: string;
  sourceBackupId: string;
  configurationGeneration: number;
  configurationIncarnationId: string;
  targetPostgresServerVersionNum: number;
  requestedBy: string;
  idempotencyKey: string;
  verifierVersion: string;
}

function clearLease(drill: RestoreDrill): RestoreDrill {
  const { leaseToken: _token, leaseHolder: _holder, leaseExpiresAt: _expires, ...cleared } = drill;
  return cleared;
}

export function createRestoreDrillStore(map: DurableMap<RestoreDrill>, now: () => number = Date.now) {
  if (!map.update) throw new Error("restore drills require atomic durable-map updates");
  const requireLease = (drill: RestoreDrill, token: string): void => {
    if (drill.leaseToken !== token || !drill.leaseExpiresAt || drill.leaseExpiresAt <= now()) {
      throw new Error("restore drill lease is not active");
    }
  };
  return {
    async request(input: RestoreDrillRequest): Promise<RestoreDrill> {
      const id = `drill_${createHash("sha256")
        .update(`${input.organizationId}\0${input.idempotencyKey}`)
        .digest("hex")
        .slice(0, 32)}`;
      const candidate: RestoreDrill = {
        id,
        sourceBackupId: input.sourceBackupId,
        organizationId: input.organizationId,
        configurationGeneration: input.configurationGeneration,
        configurationIncarnationId: input.configurationIncarnationId,
        state: "queued",
        requestedAt: now(),
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
        targetPostgresServerVersionNum: input.targetPostgresServerVersionNum,
        verifierVersion: input.verifierVersion,
      };
      const stored = await map.putIfAbsent(id, candidate);
      if (
        stored.sourceBackupId !== input.sourceBackupId ||
        stored.configurationGeneration !== input.configurationGeneration ||
        stored.configurationIncarnationId !== input.configurationIncarnationId
      ) {
        throw new Error("restore drill idempotency conflict");
      }
      return stored;
    },
    get(id: string) {
      return map.get(id);
    },
    async list(organizationId?: string) {
      return (await map.all())
        .filter((drill) => !organizationId || drill.organizationId === organizationId)
        .sort((first, second) => second.requestedAt - first.requestedAt);
    },
    async claim(holder: string, ttlMs: number): Promise<{ drill: RestoreDrill; token: string } | null> {
      const claimedAt = now();
      const candidates = (await map.all())
        .filter(
          (drill) =>
            drill.state === "queued" || (drill.state === "running" && (drill.leaseExpiresAt ?? 0) <= claimedAt),
        )
        .sort((first, second) => first.requestedAt - second.requestedAt);
      for (const candidate of candidates) {
        const token = randomUUID();
        const claimed = await map.update!(candidate.id, (drill) => {
          if (drill.state !== "queued" && !(drill.state === "running" && (drill.leaseExpiresAt ?? 0) <= claimedAt)) {
            return drill;
          }
          return {
            ...drill,
            state: "running",
            startedAt: drill.startedAt ?? claimedAt,
            leaseToken: token,
            leaseHolder: holder,
            leaseExpiresAt: claimedAt + ttlMs,
          };
        });
        if (claimed?.leaseToken === token) return { drill: claimed, token };
      }
      return null;
    },
    async heartbeat(id: string, token: string, ttlMs: number): Promise<void> {
      const updated = await map.update!(id, (drill) => {
        requireLease(drill, token);
        return { ...drill, leaseExpiresAt: now() + ttlMs };
      });
      if (!updated) throw new Error("restore drill does not exist");
    },
    async complete(
      id: string,
      token: string,
      result: Pick<
        RestoreDrill,
        "downloadVerified" | "checksumVerified" | "decrypted" | "restored" | "invariants" | "cleanup" | "durationMs"
      >,
    ): Promise<RestoreDrill> {
      const updated = await map.update!(id, (drill) => {
        requireLease(drill, token);
        return clearLease({ ...drill, ...result, state: "complete", completedAt: now() });
      });
      if (!updated) throw new Error("restore drill does not exist");
      return updated;
    },
    async fail(id: string, token: string, errorCode: string, cleanup: boolean): Promise<RestoreDrill> {
      const updated = await map.update!(id, (drill) => {
        requireLease(drill, token);
        return clearLease({ ...drill, state: "failed", errorCode, cleanup, completedAt: now() });
      });
      if (!updated) throw new Error("restore drill does not exist");
      return updated;
    },
  };
}
