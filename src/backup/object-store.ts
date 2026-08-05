import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MAX_BACKUP_ARCHIVE_BYTES } from "./archive.ts";

const MAX_RECOVERY_LIST_PAGES = 100;
const MAX_RECOVERY_LIST_ENTRIES = 100_000;

interface B2ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  credential: { keyId: string; applicationKey: string };
}

interface VerifiedObject {
  versionId: string;
  sizeBytes: number;
  sha256: string;
  immutableUntil?: number;
}

type Send = (command: unknown) => Promise<any>;

function safeKey(config: B2ObjectStoreConfig, key: string): string {
  if (
    !key.startsWith(config.prefix) ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.startsWith("/") ||
    key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("backup object key is outside the configured prefix");
  }
  return key;
}

function safeVersionId(versionId: string): string {
  const value = versionId.trim();
  if (!value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("backup object version identifier is invalid");
  }
  return value;
}

export function createB2ObjectStore(config: B2ObjectStoreConfig, injectedSend?: Send) {
  const client = injectedSend
    ? null
    : new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: { accessKeyId: config.credential.keyId, secretAccessKey: config.credential.applicationKey },
        forcePathStyle: true,
        followRegionRedirects: false,
        maxAttempts: 2,
      });
  const send: Send = injectedSend ?? ((command) => client!.send(command as never));

  const objectVersions = async (key: string) => {
    const response = await send(
      new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: safeKey(config, key), MaxKeys: 1000 }),
    );
    if (response.IsTruncated) throw new Error("backup object version listing is incomplete");
    const versions = (response.Versions ?? []).filter((entry: any) => entry.Key === key);
    const deleteMarkers = (response.DeleteMarkers ?? []).filter((entry: any) => entry.Key === key);
    return { versions, deleteMarkers };
  };

  return {
    async upload(key: string, bytes: Uint8Array, sha256: string, immutableUntil?: number): Promise<VerifiedObject> {
      safeKey(config, key);
      const response = await send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: Buffer.from(bytes),
          ContentLength: bytes.length,
          ContentType: "application/vnd.qm.backup-v1+tar",
          ServerSideEncryption: "AES256",
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          Metadata: { "qm-sha256": sha256, "qm-format": "qm-backup-v1" },
          // B2 returns 501 for conditional PutObject. The pipeline enumerates versions before upload,
          // verifies there is exactly one version afterward, and pins every later read to VersionId.
          ...(immutableUntil
            ? { ObjectLockMode: "GOVERNANCE" as const, ObjectLockRetainUntilDate: new Date(immutableUntil) }
            : {}),
        }),
      );
      const versionId = safeVersionId(String(response.VersionId ?? ""));
      return {
        versionId,
        sizeBytes: bytes.length,
        sha256,
        ...(immutableUntil ? { immutableUntil } : {}),
      };
    },
    async verify(
      key: string,
      versionId: string,
      sizeBytes: number,
      sha256: string,
      immutableUntil?: number,
    ): Promise<VerifiedObject> {
      safeKey(config, key);
      const pinnedVersion = safeVersionId(versionId);
      const listed = await objectVersions(key);
      if (
        listed.deleteMarkers.length ||
        listed.versions.length !== 1 ||
        safeVersionId(String(listed.versions[0]?.VersionId ?? "")) !== pinnedVersion
      ) {
        throw new Error("backup object key has ambiguous versions");
      }
      const response = await send(new HeadObjectCommand({ Bucket: config.bucket, Key: key, VersionId: pinnedVersion }));
      if (response.VersionId && safeVersionId(String(response.VersionId)) !== pinnedVersion) {
        throw new Error("backup object version metadata does not match");
      }
      if (Number(response.ContentLength) !== sizeBytes) throw new Error("backup object size metadata does not match");
      if (response.Metadata?.["qm-sha256"] !== sha256 || response.Metadata?.["qm-format"] !== "qm-backup-v1") {
        throw new Error("backup object checksum metadata does not match");
      }
      const retained = response.ObjectLockRetainUntilDate
        ? new Date(response.ObjectLockRetainUntilDate).getTime()
        : undefined;
      if (immutableUntil && (response.ObjectLockMode !== "GOVERNANCE" || !retained || retained < immutableUntil)) {
        throw new Error("backup object governance retention does not match");
      }
      return {
        versionId: pinnedVersion,
        sizeBytes,
        sha256,
        ...(retained ? { immutableUntil: retained } : {}),
      };
    },
    async probe(key: string): Promise<VerifiedObject | null> {
      safeKey(config, key);
      const listed = await objectVersions(key);
      if (!listed.versions.length && !listed.deleteMarkers.length) return null;
      if (listed.versions.length !== 1 || listed.deleteMarkers.length) {
        throw new Error("backup object key has ambiguous versions");
      }
      const versionId = safeVersionId(String(listed.versions[0]?.VersionId ?? ""));
      const response = await send(new HeadObjectCommand({ Bucket: config.bucket, Key: key, VersionId: versionId }));
      const sha256 = response.Metadata?.["qm-sha256"];
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error("backup object checksum metadata is invalid");
      }
      const retained = response.ObjectLockRetainUntilDate
        ? new Date(response.ObjectLockRetainUntilDate).getTime()
        : undefined;
      return {
        versionId,
        sizeBytes: Number(response.ContentLength ?? 0),
        sha256,
        ...(retained ? { immutableUntil: retained } : {}),
      };
    },
    async download(key: string, versionId: string, maxBytes: number): Promise<Buffer> {
      safeKey(config, key);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BACKUP_ARCHIVE_BYTES + 1) {
        throw new Error("backup object download byte limit is invalid");
      }
      const response = await send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key, VersionId: safeVersionId(versionId) }),
      );
      if (!response.Body || typeof response.Body[Symbol.asyncIterator] !== "function") {
        throw new Error("backup object response was not a readable stream");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) {
          response.Body.destroy?.();
          throw new Error("backup object download exceeds its byte limit");
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    },
    async list(
      limit = 1000,
    ): Promise<Array<{ key: string; versionId: string; sizeBytes: number; lastModified?: number }>> {
      const candidates: any[] = [];
      const deleteMarkerKeys = new Set<string>();
      const seenContinuations = new Set<string>();
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      let pageCount = 0;
      let entryCount = 0;
      for (;;) {
        if (++pageCount > MAX_RECOVERY_LIST_PAGES) {
          throw new Error("backup recovery-point listing exceeds its safety limit");
        }
        const response = await send(
          new ListObjectVersionsCommand({
            Bucket: config.bucket,
            Prefix: config.prefix,
            MaxKeys: 1000,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        );
        entryCount += (response.Versions ?? []).length + (response.DeleteMarkers ?? []).length;
        if (entryCount > MAX_RECOVERY_LIST_ENTRIES) {
          throw new Error("backup recovery-point listing exceeds its safety limit");
        }
        candidates.push(
          ...(response.Versions ?? []).filter(
            (entry: any) =>
              typeof entry.Key === "string" &&
              entry.Key.startsWith(config.prefix) &&
              typeof entry.VersionId === "string" &&
              entry.VersionId.trim(),
          ),
        );
        for (const entry of response.DeleteMarkers ?? []) {
          if (typeof entry.Key === "string" && entry.Key.startsWith(config.prefix)) {
            deleteMarkerKeys.add(entry.Key);
          }
        }
        if (!response.IsTruncated) break;
        if (typeof response.NextKeyMarker !== "string" || !response.NextKeyMarker.trim()) {
          throw new Error("backup recovery-point listing continuation is invalid");
        }
        const nextKeyMarker = safeKey(config, response.NextKeyMarker);
        const nextVersionIdMarker =
          response.NextVersionIdMarker === undefined ? undefined : safeVersionId(String(response.NextVersionIdMarker));
        const continuation = `${nextKeyMarker}\0${nextVersionIdMarker ?? ""}`;
        if (seenContinuations.has(continuation)) {
          throw new Error("backup recovery-point listing continuation is invalid");
        }
        seenContinuations.add(continuation);
        keyMarker = nextKeyMarker;
        versionIdMarker = nextVersionIdMarker;
      }
      const versionCounts = new Map<string, number>();
      for (const entry of candidates) {
        versionCounts.set(entry.Key, (versionCounts.get(entry.Key) ?? 0) + 1);
      }
      return candidates
        .filter((entry: any) => versionCounts.get(entry.Key) === 1 && !deleteMarkerKeys.has(entry.Key))
        .slice(0, limit)
        .map((entry: any) => ({
          key: entry.Key,
          versionId: safeVersionId(entry.VersionId),
          sizeBytes: Number(entry.Size ?? 0),
          ...(entry.LastModified ? { lastModified: new Date(entry.LastModified).getTime() } : {}),
        }));
    },
    close() {
      client?.destroy();
    },
  };
}
