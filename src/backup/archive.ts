import { createHash } from "node:crypto";
import * as tar from "tar-stream";
import { z } from "zod";
import type { BackupPurpose, BackupRetentionClass } from "./types.ts";

const ARCHIVE_ENTRIES = [
  "manifest.json",
  "database.dump.age",
  "deployment.tar.age",
  "secrets.tar.age",
  "checksums.json",
  "recovery.txt",
] as const;
const CHECKSUM_ENTRIES = [
  "manifest.json",
  "database.dump.age",
  "deployment.tar.age",
  "secrets.tar.age",
  "recovery.txt",
] as const;
export const MAX_BACKUP_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_BACKUP_COMPONENT_BYTES = MAX_BACKUP_ARCHIVE_BYTES - MAX_METADATA_BYTES * 2;

const componentSchema = z
  .object({ name: z.string(), sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal("qm-backup/v1"),
    backupToolVersion: z.string().min(1).max(100),
    deploymentId: z.string().min(1).max(128),
    organizationId: z.string().min(1).max(256),
    jobId: z.string().min(1).max(128),
    purpose: z.enum(["scheduled", "manual", "predeploy"]),
    retentionClass: z.enum(["hourly", "daily", "monthly", "predeploy", "manual"]),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    sourceCommit: z.string().min(1).max(128),
    sourceImages: z.array(z.string().min(1).max(1000)).max(32),
    applicationVersion: z.string().min(1).max(100),
    postgresServerVersion: z.string().min(1).max(100),
    postgresClientVersion: z.string().min(1).max(100),
    protectionScope: z.array(z.string().min(1).max(200)).max(100),
    recipientFingerprints: z.array(z.string().min(1).max(200)).min(2).max(8),
    components: z.array(componentSchema).length(3),
    expectedDatabaseInvariants: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    objectLock: z
      .object({ mode: z.literal("GOVERNANCE"), retainUntil: z.string().datetime() })
      .strict()
      .nullable(),
    declaredExclusions: z.array(z.string().max(500)).max(100),
    restoreCompatibility: z
      .object({ archiveFormat: z.literal(1), minimumToolVersion: z.string(), maximumToolMajor: z.number().int() })
      .strict(),
  })
  .strict();

export type BackupManifest = z.infer<typeof manifestSchema>;

export interface BackupManifestInput {
  deploymentId: string;
  organizationId: string;
  jobId: string;
  purpose: BackupPurpose;
  retentionClass: BackupRetentionClass;
  startedAt: number;
  completedAt: number;
  sourceCommit: string;
  sourceImages: string[];
  applicationVersion: string;
  postgresServerVersion: string;
  postgresClientVersion: string;
  protectionScope: string[];
  recipientFingerprints: string[];
  expectedDatabaseInvariants: Record<string, string | number | boolean>;
  objectLock: { mode: "GOVERNANCE"; retainUntil: string } | null;
  declaredExclusions: string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function safePath(name: string): void {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`archive path is unsafe: ${JSON.stringify(name)}`);
  }
}

async function packEntries(entries: Array<{ name: string; body: Uint8Array }>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        { name: entry.name, type: "file", mode: 0o600, size: entry.body.length },
        bufferView(entry.body),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await ended;
  return Buffer.concat(chunks);
}

async function extractEntries(
  bytes: Uint8Array,
  opts: { maxBytes: number; maxEntries: number; allowed?: ReadonlySet<string> },
): Promise<Map<string, Buffer>> {
  if (bytes.length > opts.maxBytes) throw new Error("archive exceeds its maximum byte size");
  const extract = tar.extract();
  const entries = new Map<string, Buffer>();
  let total = 0;
  let failure: Error | null = null;
  const complete = new Promise<Map<string, Buffer>>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      stream.on("error", reject);
      if (failure) {
        stream.on("end", next);
        stream.resume();
        return;
      }
      try {
        safePath(header.name);
        if (header.type !== "file") throw new Error(`archive entry ${header.name} is not a regular file`);
        if (opts.allowed && !opts.allowed.has(header.name))
          throw new Error(`archive entry ${header.name} is unexpected`);
        if (entries.has(header.name)) throw new Error(`archive entry ${header.name} is duplicated`);
        if (entries.size >= opts.maxEntries) throw new Error("archive contains too many entries");
        if ((header.size ?? 0) > opts.maxBytes || total + (header.size ?? 0) > opts.maxBytes) {
          throw new Error("archive expanded size exceeds its limit");
        }
      } catch (error) {
        failure = error as Error;
        stream.on("end", next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let entrySize = 0;
      stream.on("data", (chunk) => {
        entrySize += chunk.length;
        if (entrySize > opts.maxBytes || total + entrySize > opts.maxBytes) {
          failure = new Error("archive expanded size exceeds its limit");
          return;
        }
        if (!failure) chunks.push(Buffer.from(chunk));
      });
      stream.on("end", () => {
        if (!failure) {
          total += entrySize;
          entries.set(header.name, Buffer.concat(chunks));
        }
        next();
      });
      stream.resume();
    });
    extract.on("finish", () => (failure ? reject(failure) : resolve(entries)));
    extract.on("error", reject);
  });
  extract.end(bufferView(bytes));
  return complete;
}

export async function createBackupArchive(input: {
  manifest: BackupManifestInput;
  database: Uint8Array;
  deployment: Uint8Array;
  secrets: Uint8Array;
  recoveryText: string;
  backupToolVersion?: string;
}): Promise<{ bytes: Buffer; sha256: string; manifest: BackupManifest }> {
  const recoveryBytes = Buffer.from(input.recoveryText, "utf8");
  const componentBytes = input.database.byteLength + input.deployment.byteLength + input.secrets.byteLength;
  if (componentBytes + recoveryBytes.length > MAX_BACKUP_COMPONENT_BYTES) {
    throw new Error("backup archive exceeds its maximum byte size");
  }
  const encrypted = [
    { name: "database.dump.age", body: bufferView(input.database) },
    { name: "deployment.tar.age", body: bufferView(input.deployment) },
    { name: "secrets.tar.age", body: bufferView(input.secrets) },
  ];
  const manifest = manifestSchema.parse({
    formatVersion: "qm-backup/v1",
    backupToolVersion: input.backupToolVersion ?? "0.1.0",
    ...input.manifest,
    components: encrypted.map((entry) => ({
      name: entry.name,
      sizeBytes: entry.body.length,
      sha256: sha256(entry.body),
    })),
    restoreCompatibility: { archiveFormat: 1, minimumToolVersion: "0.1.0", maximumToolMajor: 1 },
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_METADATA_BYTES) throw new Error("manifest.json exceeds its metadata limit");
  const checksumBodies = new Map<string, Buffer>([
    ["manifest.json", manifestBytes],
    ...encrypted.map((entry) => [entry.name, entry.body] as [string, Buffer]),
    ["recovery.txt", recoveryBytes],
  ]);
  const checksums = Object.fromEntries([...checksumBodies].map(([name, body]) => [name, sha256(body)]));
  const bytes = await packEntries([
    { name: "manifest.json", body: manifestBytes },
    ...encrypted,
    { name: "checksums.json", body: Buffer.from(JSON.stringify(checksums)) },
    { name: "recovery.txt", body: recoveryBytes },
  ]);
  if (bytes.length > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("backup archive exceeds its maximum byte size");
  return { bytes, sha256: sha256(bytes), manifest };
}

export async function inspectBackupArchive(bytes: Uint8Array): Promise<{
  manifest: BackupManifest;
  entries: Map<string, Buffer>;
  archiveSha256: string;
}> {
  const entries = await extractEntries(bytes, {
    maxBytes: MAX_BACKUP_ARCHIVE_BYTES,
    maxEntries: ARCHIVE_ENTRIES.length,
    allowed: new Set(ARCHIVE_ENTRIES),
  });
  if (entries.size !== ARCHIVE_ENTRIES.length || ARCHIVE_ENTRIES.some((name) => !entries.has(name))) {
    throw new Error("backup archive is missing a required entry");
  }
  for (const name of ["manifest.json", "checksums.json", "recovery.txt"] as const) {
    if (entries.get(name)!.length > MAX_METADATA_BYTES) throw new Error(`${name} exceeds its metadata limit`);
  }
  const manifest = manifestSchema.parse(JSON.parse(entries.get("manifest.json")!.toString("utf8")));
  const checksums = z
    .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
    .parse(JSON.parse(entries.get("checksums.json")!.toString("utf8")));
  const checksumNames = Object.keys(checksums).sort();
  if (JSON.stringify(checksumNames) !== JSON.stringify([...CHECKSUM_ENTRIES].sort())) {
    throw new Error("backup checksum inventory does not match the required entries");
  }
  for (const name of CHECKSUM_ENTRIES) {
    if (sha256(entries.get(name)!) !== checksums[name]) throw new Error(`backup checksum mismatch for ${name}`);
  }
  const components = new Map(manifest.components.map((component) => [component.name, component]));
  for (const name of ["database.dump.age", "deployment.tar.age", "secrets.tar.age"] as const) {
    const component = components.get(name);
    const body = entries.get(name)!;
    if (!component || component.sizeBytes !== body.length || component.sha256 !== sha256(body)) {
      throw new Error(`backup manifest component checksum mismatch for ${name}`);
    }
  }
  return { manifest, entries, archiveSha256: sha256(bytes) };
}

export async function verifySafeTar(
  bytes: Uint8Array,
  opts: { maxBytes?: number; maxEntries?: number } = {},
): Promise<string[]> {
  const entries = await extractSafeTarEntries(bytes, opts);
  return [...entries.keys()].sort();
}

export async function extractSafeTarEntries(
  bytes: Uint8Array,
  opts: { maxBytes?: number; maxEntries?: number } = {},
): Promise<Map<string, Buffer>> {
  return extractEntries(bytes, {
    maxBytes: opts.maxBytes ?? 10 * 1024 * 1024 * 1024,
    maxEntries: opts.maxEntries ?? 10_000,
  });
}
