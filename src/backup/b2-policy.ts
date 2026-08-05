import type {
  BackupDestinationValidation,
  BackupObjectLockPolicy,
  BackupRetentionClass,
  BackupRetentionPolicy,
  PolicyCheck,
} from "./types.ts";

interface B2PolicyConfig {
  deploymentId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  credential: { keyId: string; applicationKey: string };
  retention: BackupRetentionPolicy;
  objectLock: BackupObjectLockPolicy;
}

const retentionFields = {
  hourly: "hourlyDays",
  daily: "dailyDays",
  monthly: "monthlyDays",
  predeploy: "predeployDays",
  manual: "manualDays",
} as const satisfies Record<BackupRetentionClass, keyof BackupRetentionPolicy>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    size += value.length;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new Error("B2 policy response exceeded its byte limit");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  ).toString("utf8");
  try {
    return object(JSON.parse(body));
  } catch {
    throw new Error("B2 policy response was not valid JSON");
  }
}

function failed(checkedAt: number, safeCode: string): BackupDestinationValidation {
  return {
    checkedAt,
    reachable: "fail",
    private: "unavailable",
    bucketScoped: "unavailable",
    leastPrivilege: "unavailable",
    serverSideEncryption: "unavailable",
    lifecycle: "unavailable",
    objectLock: "unavailable",
    safeCode,
  };
}

function periodDays(period: unknown): number {
  const value = object(period);
  const duration = typeof value.duration === "number" ? value.duration : 0;
  if (value.unit === "years") return duration * 365;
  return value.unit === "days" ? duration : 0;
}

function positiveDays(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function lifecycleVisibleDays(rule: Record<string, unknown>): number | null {
  const hiding = positiveDays(rule.daysFromUploadingToHiding);
  return hiding;
}

function lifecycleCoversRetention(config: B2PolicyConfig, rules: Record<string, unknown>[]): boolean {
  const prefix = config.prefix.endsWith("/") ? config.prefix : `${config.prefix}/`;
  return (Object.entries(retentionFields) as Array<[BackupRetentionClass, keyof BackupRetentionPolicy]>).every(
    ([retentionClass, field]) => {
      const objectPrefix = `${prefix}qm-backup/v1/${config.deploymentId}/${retentionClass}/`;
      const applicable = rules.filter((rule) => {
        const rulePrefix = typeof rule.fileNamePrefix === "string" ? rule.fileNamePrefix : "";
        return objectPrefix.startsWith(rulePrefix);
      });
      return (
        applicable.length > 0 &&
        applicable.every((rule) => {
          const days = lifecycleVisibleDays(rule);
          return days !== null && days >= config.retention[field];
        })
      );
    },
  );
}

export async function inspectB2Destination(
  config: B2PolicyConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<BackupDestinationValidation> {
  const checkedAt = now();
  let authorized: Record<string, unknown>;
  try {
    const response = await fetchImpl("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
      headers: {
        authorization: `Basic ${Buffer.from(`${config.credential.keyId}:${config.credential.applicationKey}`).toString("base64")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return failed(checkedAt, `authorize_http_${response.status}`);
    authorized = await boundedJson(response);
  } catch {
    return failed(checkedAt, "authorize_unavailable");
  }

  const storageApi = object(object(authorized.apiInfo).storageApi);
  const allowed = object(storageApi.allowed);
  const buckets = Array.isArray(allowed.buckets) ? allowed.buckets.map(object) : [];
  const capabilities = new Set(
    Array.isArray(allowed.capabilities) ? allowed.capabilities.filter((v) => typeof v === "string") : [],
  );
  const namePrefix = typeof allowed.namePrefix === "string" ? allowed.namePrefix : "";
  const prohibitedCapabilities = ["bypassGovernance", "deleteBuckets", "deleteKeys", "writeKeys"];
  const hardProhibited = prohibitedCapabilities.filter((capability) => capabilities.has(capability));
  const expectedCapabilities = new Set([
    "listBuckets",
    "listFiles",
    "readBuckets",
    "readBucketEncryption",
    "readBucketLifecycleRules",
    "readBucketRetentions",
    "readFileRetentions",
    "readFiles",
    "writeFileRetentions",
    "writeFiles",
  ]);
  const unnecessaryCapabilities = [...capabilities]
    .filter((capability) => !expectedCapabilities.has(capability) && !prohibitedCapabilities.includes(capability))
    .sort();
  const required = ["listFiles", "readFiles", "writeFiles"].every((capability) => capabilities.has(capability));
  const bucketScoped =
    buckets.length === 1 &&
    buckets[0]!.name === config.bucket &&
    (!namePrefix || config.prefix.startsWith(namePrefix)) &&
    required &&
    hardProhibited.length === 0;
  const s3ApiUrl = typeof storageApi.s3ApiUrl === "string" ? storageApi.s3ApiUrl.replace(/\/+$/, "") : "";
  const apiUrlValue = typeof storageApi.apiUrl === "string" ? storageApi.apiUrl : "";
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiUrlValue);
  } catch {
    return failed(checkedAt, "authorize_api_url_invalid");
  }
  if (
    apiUrl.protocol !== "https:" ||
    !/^api\d+\.backblazeb2\.com$/.test(apiUrl.hostname) ||
    apiUrl.pathname !== "/" ||
    s3ApiUrl !== config.endpoint
  ) {
    return failed(checkedAt, "authorize_endpoint_mismatch");
  }
  if (!bucketScoped) {
    return {
      checkedAt,
      reachable: "pass",
      private: "unavailable",
      bucketScoped: "fail",
      leastPrivilege: hardProhibited.length ? "fail" : "unavailable",
      serverSideEncryption: "unavailable",
      lifecycle: "unavailable",
      objectLock: capabilities.has("bypassGovernance") ? "fail" : "unavailable",
      safeCode: "credential_scope_invalid",
    };
  }

  const token = typeof authorized.authorizationToken === "string" ? authorized.authorizationToken : "";
  const accountId = typeof authorized.accountId === "string" ? authorized.accountId : "";
  if (!token || !accountId) return failed(checkedAt, "authorize_response_incomplete");
  const listUrl = new URL("/b2api/v4/b2_list_buckets", apiUrl);
  listUrl.searchParams.set("accountId", accountId);
  listUrl.searchParams.set("bucketName", config.bucket);
  let listed: Record<string, unknown>;
  try {
    const response = await fetchImpl(listUrl, {
      headers: { authorization: token },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return failed(checkedAt, `bucket_policy_http_${response.status}`);
    listed = await boundedJson(response);
  } catch {
    return failed(checkedAt, "bucket_policy_unavailable");
  }
  const listedBuckets = Array.isArray(listed.buckets) ? listed.buckets.map(object) : [];
  const bucket = listedBuckets.find((candidate) => candidate.bucketName === config.bucket);
  if (!bucket) return failed(checkedAt, "bucket_not_found");

  const encryption = object(bucket.defaultServerSideEncryption);
  const encryptionValue = object(encryption.value);
  let serverSideEncryption: PolicyCheck = "fail";
  if (encryption.isClientAuthorizedToRead !== true) serverSideEncryption = "unavailable";
  else if (encryptionValue.algorithm === "AES256" || encryptionValue.mode === "SSE-B2") {
    serverSideEncryption = "pass";
  }
  const lifecycleRules = Array.isArray(bucket.lifecycleRules) ? bucket.lifecycleRules.map(object) : [];
  const lock = object(bucket.fileLockConfiguration);
  const lockValue = object(lock.value);
  const defaultRetention = object(lockValue.defaultRetention);
  const lockReadable = lock.isClientAuthorizedToRead === true && capabilities.has("readBucketRetentions");
  const lockPass =
    lockValue.isFileLockEnabled === true &&
    String(defaultRetention.mode).toLowerCase() === "governance" &&
    periodDays(defaultRetention.period) >= config.objectLock.minimumDays &&
    !capabilities.has("bypassGovernance");
  let objectLock: PolicyCheck = "fail";
  if (!config.objectLock.required) objectLock = "pass";
  else if (!lockReadable) objectLock = "unavailable";
  else if (lockPass) objectLock = "pass";
  const lifecycle: PolicyCheck = lifecycleCoversRetention(config, lifecycleRules) ? "pass" : "fail";
  const detail: Pick<BackupDestinationValidation, "safeCode" | "unnecessaryCapabilities"> = {};
  if (unnecessaryCapabilities.length) {
    detail.safeCode = "credential_has_unnecessary_capabilities";
    detail.unnecessaryCapabilities = unnecessaryCapabilities;
  } else if (lifecycle === "fail") {
    detail.safeCode = "lifecycle_retention_insufficient";
  }
  return {
    checkedAt,
    reachable: "pass",
    private: bucket.bucketType === "allPrivate" ? "pass" : "fail",
    bucketScoped: "pass",
    leastPrivilege: unnecessaryCapabilities.length ? "unavailable" : "pass",
    serverSideEncryption,
    lifecycle,
    objectLock,
    ...detail,
  };
}
