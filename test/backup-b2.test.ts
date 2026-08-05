import assert from "node:assert/strict";
import test from "node:test";
import { inspectB2Destination } from "../src/backup/b2-policy.ts";

const config = {
  deploymentId: "example-host",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  bucket: "qm-backups-test",
  prefix: "qm/production/",
  credential: { keyId: "key-id", applicationKey: "super-secret-application-key" },
  retention: { hourlyDays: 7, dailyDays: 35, monthlyDays: 400, predeployDays: 30, manualDays: 90 },
  objectLock: { required: true, mode: "GOVERNANCE" as const, minimumDays: 30 },
};

test("B2 policy proof verifies key scope, privacy, encryption, lifecycle, and governance retention", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    if (url.includes("b2_authorize_account")) {
      return new Response(
        JSON.stringify({
          accountId: "account",
          authorizationToken: "temporary-token",
          apiInfo: {
            storageApi: {
              apiUrl: "https://api001.backblazeb2.com",
              s3ApiUrl: config.endpoint,
              allowed: {
                buckets: [{ id: "bucket-id", name: config.bucket }],
                capabilities: [
                  "listFiles",
                  "readFiles",
                  "writeFiles",
                  "readBuckets",
                  "readBucketEncryption",
                  "readBucketRetentions",
                  "readFileRetentions",
                  "writeFileRetentions",
                ],
                namePrefix: config.prefix,
              },
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        buckets: [
          {
            bucketId: "bucket-id",
            bucketName: config.bucket,
            bucketType: "allPrivate",
            defaultServerSideEncryption: {
              isClientAuthorizedToRead: true,
              value: { algorithm: "AES256", mode: "SSE-B2" },
            },
            fileLockConfiguration: {
              isClientAuthorizedToRead: true,
              value: {
                isFileLockEnabled: true,
                defaultRetention: { mode: "governance", period: { duration: 30, unit: "days" } },
              },
            },
            lifecycleRules: [
              { fileNamePrefix: config.prefix, daysFromUploadingToHiding: 400, daysFromHidingToDeleting: 1 },
            ],
          },
        ],
      }),
    );
  };

  assert.deepEqual(await inspectB2Destination(config, fetchImpl, () => 1000), {
    checkedAt: 1000,
    reachable: "pass",
    private: "pass",
    bucketScoped: "pass",
    leastPrivilege: "pass",
    serverSideEncryption: "pass",
    lifecycle: "pass",
    objectLock: "pass",
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((call) => call.url.includes(config.credential.applicationKey)),
    false,
  );
  assert.match(calls[0]!.authorization ?? "", /^Basic /);
  assert.equal(calls[1]!.authorization, "temporary-token");
});

test("B2 policy proof reports unreadable Object Lock and never returns upstream secret-shaped errors", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("b2_authorize_account")) {
      return new Response(
        JSON.stringify({
          accountId: "account",
          authorizationToken: "temporary-token",
          apiInfo: {
            storageApi: {
              apiUrl: "https://api001.backblazeb2.com",
              s3ApiUrl: config.endpoint,
              allowed: {
                buckets: [{ id: "bucket-id", name: config.bucket }],
                capabilities: ["listFiles", "readFiles", "writeFiles", "readBuckets"],
                namePrefix: config.prefix,
              },
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        buckets: [
          {
            bucketId: "bucket-id",
            bucketName: config.bucket,
            bucketType: "allPrivate",
            defaultServerSideEncryption: { isClientAuthorizedToRead: false },
            fileLockConfiguration: { isClientAuthorizedToRead: false },
            lifecycleRules: [],
          },
        ],
      }),
    );
  };
  const report = await inspectB2Destination(config, fetchImpl, () => 1000);
  assert.equal(report.objectLock, "unavailable");
  assert.equal(report.serverSideEncryption, "unavailable");
  assert.equal(report.lifecycle, "fail");
  assert.doesNotMatch(JSON.stringify(report), /super-secret/);

  const failed = await inspectB2Destination(
    config,
    async () =>
      new Response(JSON.stringify({ code: "unauthorized", message: config.credential.applicationKey }), {
        status: 401,
      }),
    () => 2000,
  );
  assert.equal(failed.reachable, "fail");
  assert.equal(failed.safeCode, "authorize_http_401");
  assert.doesNotMatch(JSON.stringify(failed), /super-secret/);
});

test("B2 policy proof fails broad or governance-bypass credentials", async () => {
  const report = await inspectB2Destination(
    config,
    async () =>
      new Response(
        JSON.stringify({
          accountId: "account",
          authorizationToken: "temporary-token",
          apiInfo: {
            storageApi: {
              apiUrl: "https://api001.backblazeb2.com",
              s3ApiUrl: config.endpoint,
              allowed: { buckets: [], capabilities: ["bypassGovernance", "writeFiles"], namePrefix: null },
            },
          },
        }),
      ),
    () => 3000,
  );
  assert.equal(report.bucketScoped, "fail");
  assert.equal(report.objectLock, "fail");
  assert.equal(report.leastPrivilege, "fail");
});

test("B2 policy proof accepts a bucket-bound overprivileged key with a persistent warning", async () => {
  const capabilities = [
    "listBuckets",
    "readBucketLifecycleRules",
    "writeBucketReplications",
    "readBuckets",
    "readFiles",
    "writeBucketEncryption",
    "readBucketLogging",
    "shareFiles",
    "writeBucketNotifications",
    "readBucketEncryption",
    "readBucketNotifications",
    "writeBuckets",
    "writeBucketLogging",
    "writeFiles",
    "deleteFiles",
    "readBucketReplications",
    "listFiles",
    "writeBucketLifecycleRules",
  ];
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("b2_authorize_account")) {
      return Response.json({
        accountId: "account",
        authorizationToken: "temporary-token",
        apiInfo: {
          storageApi: {
            apiUrl: "https://api001.backblazeb2.com",
            s3ApiUrl: config.endpoint,
            allowed: {
              buckets: [{ id: "bucket-id", name: config.bucket }],
              capabilities,
              namePrefix: "",
            },
          },
        },
      });
    }
    return Response.json({
      buckets: [
        {
          bucketId: "bucket-id",
          bucketName: config.bucket,
          bucketType: "allPrivate",
          defaultServerSideEncryption: {
            isClientAuthorizedToRead: true,
            value: { algorithm: "AES256", mode: "SSE-B2" },
          },
          fileLockConfiguration: { isClientAuthorizedToRead: false },
          lifecycleRules: [{ fileNamePrefix: "", daysFromUploadingToHiding: 400 }],
        },
      ],
    });
  };

  const report = await inspectB2Destination(
    { ...config, objectLock: { ...config.objectLock, required: false } },
    fetchImpl,
    () => 4000,
  );
  assert.equal(report.bucketScoped, "pass");
  assert.equal(report.leastPrivilege, "unavailable");
  assert.equal(report.safeCode, "credential_has_unnecessary_capabilities");
  assert.deepEqual(report.unnecessaryCapabilities, [
    "deleteFiles",
    "readBucketLogging",
    "readBucketNotifications",
    "readBucketReplications",
    "shareFiles",
    "writeBucketEncryption",
    "writeBucketLifecycleRules",
    "writeBucketLogging",
    "writeBucketNotifications",
    "writeBucketReplications",
    "writeBuckets",
  ]);
});

test("B2 policy proof requires lifecycle rules to cover every configured retention class", async () => {
  const inspect = (lifecycleRules: Record<string, unknown>[]) =>
    inspectB2Destination(
      { ...config, objectLock: { ...config.objectLock, required: false } },
      async (input) => {
        if (String(input).includes("b2_authorize_account")) {
          return Response.json({
            accountId: "account",
            authorizationToken: "temporary-token",
            apiInfo: {
              storageApi: {
                apiUrl: "https://api001.backblazeb2.com",
                s3ApiUrl: config.endpoint,
                allowed: {
                  buckets: [{ id: "bucket-id", name: config.bucket }],
                  capabilities: ["listFiles", "readFiles", "writeFiles", "readBuckets", "readBucketEncryption"],
                  namePrefix: config.prefix,
                },
              },
            },
          });
        }
        return Response.json({
          buckets: [
            {
              bucketId: "bucket-id",
              bucketName: config.bucket,
              bucketType: "allPrivate",
              defaultServerSideEncryption: {
                isClientAuthorizedToRead: true,
                value: { algorithm: "AES256", mode: "SSE-B2" },
              },
              fileLockConfiguration: { isClientAuthorizedToRead: false },
              lifecycleRules,
            },
          ],
        });
      },
      () => 5000,
    );

  const insufficient = await inspect([
    { fileNamePrefix: config.prefix, daysFromUploadingToHiding: 30, daysFromHidingToDeleting: 1 },
  ]);
  assert.equal(insufficient.lifecycle, "fail");
  assert.equal(insufficient.safeCode, "lifecycle_retention_insufficient");

  const hiddenBeforeRetention = await inspect(
    Object.entries(config.retention).map(([field, days]) => ({
      fileNamePrefix: `${config.prefix}qm-backup/v1/${config.deploymentId}/${field.replace(/Days$/, "")}/`,
      daysFromUploadingToHiding: days - 1,
      daysFromHidingToDeleting: 1,
    })),
  );
  assert.equal(hiddenBeforeRetention.lifecycle, "fail");

  const hiddenImmediatelyWithoutDeletion = await inspect([
    { fileNamePrefix: config.prefix, daysFromUploadingToHiding: 1 },
  ]);
  assert.equal(hiddenImmediatelyWithoutDeletion.lifecycle, "fail");

  const sufficient = await inspect(
    Object.entries(config.retention).map(([field, days]) => ({
      fileNamePrefix: `${config.prefix}qm-backup/v1/${config.deploymentId}/${field.replace(/Days$/, "")}/`,
      daysFromUploadingToHiding: days,
      daysFromHidingToDeleting: 1,
    })),
  );
  assert.equal(sufficient.lifecycle, "pass");
});

test("B2 policy proof never lets object lock substitute for discoverable lifecycle retention", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("b2_authorize_account")) {
      return Response.json({
        accountId: "account",
        authorizationToken: "temporary-token",
        apiInfo: {
          storageApi: {
            apiUrl: "https://api001.backblazeb2.com",
            s3ApiUrl: config.endpoint,
            allowed: {
              buckets: [{ id: "bucket-id", name: config.bucket }],
              capabilities: [
                "listFiles",
                "readFiles",
                "writeFiles",
                "readBuckets",
                "readBucketEncryption",
                "readBucketRetentions",
                "writeFileRetentions",
              ],
              namePrefix: config.prefix,
            },
          },
        },
      });
    }
    return Response.json({
      buckets: [
        {
          bucketId: "bucket-id",
          bucketName: config.bucket,
          bucketType: "allPrivate",
          defaultServerSideEncryption: {
            isClientAuthorizedToRead: true,
            value: { algorithm: "AES256", mode: "SSE-B2" },
          },
          fileLockConfiguration: {
            isClientAuthorizedToRead: true,
            value: {
              isFileLockEnabled: true,
              defaultRetention: { mode: "governance", period: { duration: 30, unit: "days" } },
            },
          },
          lifecycleRules: [
            { fileNamePrefix: config.prefix, daysFromUploadingToHiding: 1, daysFromHidingToDeleting: 1 },
          ],
        },
      ],
    });
  };

  const report = await inspectB2Destination(config, fetchImpl, () => 6000);
  assert.equal(report.objectLock, "pass");
  assert.equal(report.lifecycle, "fail");
  assert.equal(report.safeCode, "lifecycle_retention_insufficient");
});
