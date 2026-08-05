import assert from "node:assert/strict";
import test from "node:test";
import { createRestoreDrillStore } from "../src/backup/drill-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { RestoreDrill } from "../src/backup/types.ts";

const configurationIncarnationId = "00000000-0000-4000-8000-000000000001";

test("restore drills are idempotent, lease-exclusive, and record every proof stage", async () => {
  let now = 1000;
  const store = createRestoreDrillStore(createMemoryMap<RestoreDrill>(), () => now);
  const requested = await store.request({
    organizationId: "default-org",
    sourceBackupId: "bkp_one",
    configurationGeneration: 1,
    configurationIncarnationId,
    targetPostgresServerVersionNum: 180004,
    requestedBy: "admin",
    idempotencyKey: "drill-one",
    verifierVersion: "0.1.0",
  });
  assert.equal(
    (
      await store.request({
        organizationId: "default-org",
        sourceBackupId: "bkp_one",
        configurationGeneration: 1,
        configurationIncarnationId,
        targetPostgresServerVersionNum: 180004,
        requestedBy: "admin",
        idempotencyKey: "drill-one",
        verifierVersion: "0.1.0",
      })
    ).id,
    requested.id,
  );
  const claim = await store.claim("worker-a", 100);
  assert.ok(claim);
  assert.equal(await store.claim("worker-b", 100), null);
  now = 1050;
  await store.heartbeat(claim.drill.id, claim.token, 100);
  await store.complete(claim.drill.id, claim.token, {
    downloadVerified: true,
    checksumVerified: true,
    decrypted: true,
    restored: true,
    invariants: {
      postgresServerVersionNum: 180004,
      postgresVersion: true,
      schema: true,
      rowBounds: true,
      timestamps: true,
      organization: true,
      applicationHealth: true,
    },
    cleanup: true,
    durationMs: 50,
  });
  assert.equal((await store.get(requested.id))?.state, "complete");
  await assert.rejects(
    store.request({
      organizationId: "default-org",
      sourceBackupId: "bkp_one",
      configurationGeneration: 2,
      configurationIncarnationId,
      targetPostgresServerVersionNum: 180004,
      requestedBy: "admin",
      idempotencyKey: "drill-one",
      verifierVersion: "0.1.0",
    }),
    /idempotency conflict/,
  );
});
