import assert from "node:assert/strict";
import test from "node:test";
import * as tar from "tar-stream";
import {
  createBackupArchive,
  extractSafeTarEntries,
  inspectBackupArchive,
  MAX_BACKUP_ARCHIVE_BYTES,
  verifySafeTar,
} from "../src/backup/archive.ts";

const base = {
  deploymentId: "example-host",
  organizationId: "default-org",
  jobId: "bkp_abc123",
  purpose: "manual" as const,
  retentionClass: "manual" as const,
  startedAt: Date.UTC(2026, 7, 4, 12, 0, 0),
  completedAt: Date.UTC(2026, 7, 4, 12, 1, 0),
  sourceCommit: "a".repeat(40),
  sourceImages: ["localhost/qm@sha256:" + "b".repeat(64)],
  applicationVersion: "0.1.0",
  postgresServerVersion: "18.4",
  postgresClientVersion: "18.4",
  protectionScope: ["database", "deployment", "root-secrets"],
  recipientFingerprints: ["age-sha256:abc", "age-sha256:def"],
  expectedDatabaseInvariants: { organizationId: "default-org", minimumTableCount: 1 },
  objectLock: { mode: "GOVERNANCE" as const, retainUntil: "2026-09-04T12:00:00.000Z" },
  declaredExclusions: ["external provider data"],
};

test("backup archive is self-contained, exact, checksummed, and versioned", async () => {
  const created = await createBackupArchive({
    manifest: base,
    database: Buffer.from("encrypted database"),
    deployment: Buffer.from("encrypted deployment"),
    secrets: Buffer.from("encrypted secrets"),
    recoveryText: "Use qm backup verify before restore.\n",
  });
  const inspected = await inspectBackupArchive(created.bytes);

  assert.equal(created.sha256, inspected.archiveSha256);
  assert.equal(inspected.manifest.formatVersion, "qm-backup/v1");
  assert.equal(inspected.manifest.jobId, "bkp_abc123");
  assert.deepEqual([...inspected.entries.keys()].sort(), [
    "checksums.json",
    "database.dump.age",
    "deployment.tar.age",
    "manifest.json",
    "recovery.txt",
    "secrets.tar.age",
  ]);
});

test("backup archive verification rejects corruption, missing entries, and traversal", async () => {
  const created = await createBackupArchive({
    manifest: base,
    database: Buffer.from("encrypted database"),
    deployment: Buffer.from("encrypted deployment"),
    secrets: Buffer.from("encrypted secrets"),
    recoveryText: "recover\n",
  });
  const corrupted = Buffer.from(created.bytes);
  const needle = corrupted.indexOf("encrypted database");
  assert.ok(needle >= 0);
  corrupted[needle] = corrupted[needle]! ^ 1;
  await assert.rejects(inspectBackupArchive(corrupted), /checksum/);

  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  pack.entry({ name: "../manifest.json" }, "{}");
  pack.finalize();
  await new Promise<void>((resolve) => pack.on("end", resolve));
  await assert.rejects(inspectBackupArchive(Buffer.concat(chunks)), /path/);
});

test("backup archive creation rejects inputs beyond the bounded in-memory format before copying them", async () => {
  const oversized = { byteLength: MAX_BACKUP_ARCHIVE_BYTES } as Uint8Array;
  await assert.rejects(
    createBackupArchive({
      manifest: base,
      database: oversized,
      deployment: Buffer.alloc(0),
      secrets: Buffer.alloc(0),
      recoveryText: "recover\n",
    }),
    /maximum byte size/,
  );
});

test("decrypted tar verification rejects links, traversal, entry floods, and size abuse", async () => {
  const safe = tar.pack();
  const safeChunks: Buffer[] = [];
  safe.on("data", (chunk) => safeChunks.push(Buffer.from(chunk)));
  safe.entry({ name: "quadlets/qm.container" }, "unit");
  safe.finalize();
  await new Promise<void>((resolve) => safe.on("end", resolve));
  assert.deepEqual(await verifySafeTar(Buffer.concat(safeChunks)), ["quadlets/qm.container"]);
  assert.equal(
    (await extractSafeTarEntries(Buffer.concat(safeChunks))).get("quadlets/qm.container")?.toString(),
    "unit",
  );

  const unsafe = tar.pack();
  const unsafeChunks: Buffer[] = [];
  unsafe.on("data", (chunk) => unsafeChunks.push(Buffer.from(chunk)));
  unsafe.entry({ name: "../../etc/shadow" }, "nope");
  unsafe.finalize();
  await new Promise<void>((resolve) => unsafe.on("end", resolve));
  await assert.rejects(verifySafeTar(Buffer.concat(unsafeChunks)), /path/);
});
