import type { BackupRetentionClass } from "./types.ts";

const B2_HOST = /^s3\.([a-z0-9]+(?:-[a-z0-9]+)*)\.backblazeb2\.com$/;
const BUCKET = /^(?=.{6,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;

function normalizedPrefix(value: string): string {
  if (value.includes("\0") || value.includes("\\")) throw new Error("B2 prefix contains an unsafe character");
  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error("B2 prefix contains an unsafe path segment");
  }
  return segments.length ? `${segments.join("/")}/` : "";
}

export function normalizeB2Destination(input: { endpoint: string; bucket: string; prefix: string }): {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
} {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new Error("B2 endpoint is invalid");
  }
  const match = B2_HOST.exec(url.hostname.toLowerCase());
  if (
    url.protocol !== "https:" ||
    !match ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("B2 endpoint must be an exact regional Backblaze HTTPS S3 endpoint");
  }
  const bucket = input.bucket.trim().toLowerCase();
  if (!BUCKET.test(bucket) || bucket.includes("..") || /^\d+(?:\.\d+){3}$/.test(bucket)) {
    throw new Error("B2 bucket name is invalid");
  }
  return {
    endpoint: `https://${url.hostname.toLowerCase()}`,
    region: match[1]!,
    bucket,
    prefix: normalizedPrefix(input.prefix),
  };
}

function identifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} identifier is invalid`);
  return normalized;
}

export function backupObjectKey(input: {
  prefix: string;
  deploymentId: string;
  retentionClass: BackupRetentionClass;
  startedAt: number;
  jobId: string;
}): string {
  const date = new Date(input.startedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("backup timestamp is invalid");
  const timestamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const deploymentId = identifier(input.deploymentId, "deployment");
  const jobId = identifier(input.jobId, "job");
  return `${normalizedPrefix(input.prefix)}qm-backup/v1/${deploymentId}/${input.retentionClass}/${timestamp}-${jobId}.qmbackup`;
}
