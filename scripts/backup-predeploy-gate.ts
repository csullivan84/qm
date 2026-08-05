import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type Fetch = typeof fetch;

interface ProtectionCondition {
  code: string;
  state: "pass" | "fail" | "unavailable";
}

interface ProtectionStatus {
  state: string;
  managementAvailable?: boolean;
  conditions?: ProtectionCondition[];
}

interface BackupRun {
  id: string;
  state: string;
  sourceRevision?: string;
  verifiedAt?: number;
  checksumMatches?: boolean;
  archiveSha256?: string;
  objectVersionId?: string;
  errorCode?: string;
}

export class BackupGateError extends Error {}

function baseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new BackupGateError("backup gate API must use HTTPS or loopback HTTP");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    length += value.length;
    if (length > 1024 * 1024) {
      await reader.cancel();
      throw new BackupGateError("backup gate response exceeded its byte limit");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new BackupGateError("backup gate response was not valid JSON");
  }
}

async function request(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { accept: "application/json", ...headers, ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BackupGateError("backup gate API is unreachable");
  }
  const body = await boundedJson(response);
  if (!response.ok) {
    const safeCode = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new BackupGateError(`backup gate API refused the request: ${safeCode}`);
  }
  return body;
}

function status(value: Record<string, unknown>): ProtectionStatus {
  const conditions = Array.isArray(value.conditions)
    ? value.conditions.filter((entry): entry is ProtectionCondition =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as ProtectionCondition).code === "string" &&
          ["pass", "fail", "unavailable"].includes((entry as ProtectionCondition).state),
        ),
      )
    : [];
  return {
    state: typeof value.state === "string" ? value.state : "Unknown",
    managementAvailable: value.managementAvailable === true,
    conditions,
  };
}

function run(value: Record<string, unknown>): BackupRun {
  if (typeof value.id !== "string" || typeof value.state !== "string") {
    throw new BackupGateError("backup gate returned an invalid run");
  }
  return value as unknown as BackupRun;
}

const REQUIRED_FINAL_CONDITIONS = new Set([
  "configuration",
  "backup_freshness",
  "backup_checksum",
  "backup_version_pin",
  "restore_drill",
  "recovery_kit",
  "worker_heartbeat",
  "terminal_failure",
  "retryable_failure",
  "policy_reachable",
  "policy_private",
  "policy_bucketScoped",
  "policy_leastPrivilege",
  "policy_serverSideEncryption",
  "policy_lifecycle",
  "policy_objectLock",
]);

export async function runPredeployBackupGate(input: {
  apiBase: string;
  deploymentId: string;
  sourceRevision: string;
  targetRevision: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: Fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  onProgress?: (state: string) => void;
}): Promise<{ run: BackupRun; protectionState: string; idempotencyKey: string }> {
  const api = baseUrl(input.apiBase);
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = input.headers ?? {};
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/.test(input.deploymentId)) {
    throw new BackupGateError("backup gate deployment identifier is invalid");
  }
  if (!/^[a-f0-9]{40,64}$/.test(input.targetRevision)) {
    throw new BackupGateError("backup gate target revision must be an immutable Git hash");
  }
  if (!/^[a-f0-9]{40,64}$/.test(input.sourceRevision)) {
    throw new BackupGateError("backup gate source revision must be an immutable Git hash");
  }
  const initial = status(await request(fetchImpl, `${api}/status`, headers));
  if (!initial.managementAvailable) throw new BackupGateError("Recovery management is not durable or available");
  if (["Unconfigured", "Suspended", "Restoring"].includes(initial.state)) {
    throw new BackupGateError(`Recovery state ${initial.state} cannot protect a deployment`);
  }
  const immutableIdentity = `${input.deploymentId}\0${input.sourceRevision}\0${input.targetRevision}`;
  const idempotencyKey = `predeploy:${createHash("sha256").update(immutableIdentity).digest("hex")}`;
  const requested = run(
    await request(fetchImpl, `${api}/runs`, headers, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ purpose: "predeploy" }),
    }),
  );
  const deadline = now() + (input.timeoutMs ?? 15 * 60_000);
  const pollMs = input.pollMs ?? 2000;
  let current = requested;
  while (current.state !== "complete") {
    if (["terminal_failure", "cancelled"].includes(current.state)) {
      throw new BackupGateError(`predeploy backup failed: ${current.errorCode ?? current.state}`);
    }
    if (now() >= deadline) throw new BackupGateError("predeploy backup did not complete before the gate deadline");
    input.onProgress?.(current.state);
    await wait(pollMs);
    current = run(await request(fetchImpl, `${api}/runs/${encodeURIComponent(current.id)}`, headers));
  }
  if (
    current.sourceRevision !== input.sourceRevision ||
    current.checksumMatches !== true ||
    !Number.isSafeInteger(current.verifiedAt) ||
    typeof current.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(current.archiveSha256) ||
    typeof current.objectVersionId !== "string" ||
    !current.objectVersionId.trim() ||
    current.objectVersionId.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(current.objectVersionId)
  ) {
    throw new BackupGateError("predeploy backup completed without complete verification evidence");
  }
  const final = status(await request(fetchImpl, `${api}/status`, headers));
  const finalConditions = new Map((final.conditions ?? []).map((condition) => [condition.code, condition.state]));
  const unmet = [...REQUIRED_FINAL_CONDITIONS].filter((code) => finalConditions.get(code) !== "pass");
  const nonPassing = (final.conditions ?? []).find((condition) => condition.state !== "pass");
  if (!final.managementAvailable || final.state !== "Protected" || unmet.length || nonPassing) {
    throw new BackupGateError(
      `Recovery remained unprotected after predeploy verification: ${unmet[0] ?? nonPassing?.code ?? final.state}`,
    );
  }
  return { run: current, protectionState: final.state, idempotencyKey };
}

async function privateHeader(path: string, name: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 16_384) {
    throw new BackupGateError(`${name} file must be a private regular file`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value || /[\r\n]/.test(value)) throw new BackupGateError(`${name} file is invalid`);
  return value;
}

async function main(): Promise<void> {
  const apiBase = process.env.BACKUP_GATE_API_BASE;
  const deploymentId = process.env.BACKUP_GATE_DEPLOYMENT_ID;
  const sourceRevision = process.env.BACKUP_GATE_SOURCE_REVISION;
  const targetRevision = process.env.BACKUP_GATE_TARGET_REVISION;
  if (!apiBase || !deploymentId || !sourceRevision || !targetRevision) {
    throw new BackupGateError(
      "BACKUP_GATE_API_BASE, BACKUP_GATE_DEPLOYMENT_ID, BACKUP_GATE_SOURCE_REVISION, and BACKUP_GATE_TARGET_REVISION are required",
    );
  }
  const headers: Record<string, string> = {};
  if (process.env.BACKUP_GATE_COOKIE_FILE) {
    headers.cookie = await privateHeader(process.env.BACKUP_GATE_COOKIE_FILE, "cookie");
  }
  if (process.env.BACKUP_GATE_AUTHORIZATION_FILE) {
    headers.authorization = await privateHeader(process.env.BACKUP_GATE_AUTHORIZATION_FILE, "authorization");
  }
  if (!headers.cookie && !headers.authorization) {
    throw new BackupGateError("a private cookie or authorization header file is required");
  }
  const result = await runPredeployBackupGate({
    apiBase,
    deploymentId,
    sourceRevision,
    targetRevision,
    headers,
    onProgress: (state) => console.log(`predeploy backup state: ${state}`),
  });
  console.log(
    JSON.stringify({
      runId: result.run.id,
      verifiedAt: result.run.verifiedAt,
      protectionState: result.protectionState,
      checksumMatches: true,
      objectVersionId: result.run.objectVersionId,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof BackupGateError ? error.message : "predeploy backup gate failed");
    process.exitCode = 1;
  });
}
