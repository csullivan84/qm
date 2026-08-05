import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { BackupAuditEvent } from "./types.ts";

const SENSITIVE_KEY = /secret|password|token|credential|application.?key|private.?key|identity/i;

export function createBackupAuditStore(map: DurableMap<BackupAuditEvent>, now: () => number = Date.now) {
  return {
    async record(input: Omit<BackupAuditEvent, "id" | "at"> & { at?: number }): Promise<BackupAuditEvent> {
      if (Object.keys(input.detail).some((key) => SENSITIVE_KEY.test(key))) {
        throw new Error("backup audit detail contains a sensitive field name");
      }
      const detail = Object.fromEntries(
        Object.entries(input.detail).map(([key, value]) => {
          if (typeof value === "string" && value.length > 500) throw new Error("backup audit detail is too large");
          return [key, value];
        }),
      );
      const event: BackupAuditEvent = { ...input, detail, id: randomUUID(), at: input.at ?? now() };
      await map.put(event.id, event);
      return event;
    },
    async list(organizationId: string, limit = 200): Promise<BackupAuditEvent[]> {
      return (await map.all())
        .filter((event) => event.organizationId === organizationId)
        .sort((first, second) => second.at - first.at)
        .slice(0, Math.max(1, Math.min(1000, limit)));
    },
  };
}
