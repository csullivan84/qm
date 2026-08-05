import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BACKUP_ARCHIVE_BYTES } from "../src/backup/archive.ts";
import { createB2ObjectStore } from "../src/backup/object-store.ts";

test("B2 object store writes checksum-labelled objects and verifies one exact immutable version", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const sha256 = "a".repeat(64);
  const retainUntil = Date.UTC(2026, 8, 4);
  const send = async (command: any): Promise<any> => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "PutObjectCommand") return { VersionId: "version-1", ETag: "etag" };
    if (command.constructor.name === "ListObjectVersionsCommand") {
      return {
        Versions: [
          {
            Key: "qm/production/point.qmbackup",
            VersionId: "version-1",
            Size: 5,
          },
        ],
      };
    }
    return {
      ContentLength: 5,
      Metadata: { "qm-sha256": sha256, "qm-format": "qm-backup-v1" },
      ObjectLockMode: "GOVERNANCE",
      ObjectLockRetainUntilDate: new Date(retainUntil),
      VersionId: "version-1",
    };
  };
  const store = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    send,
  );

  assert.deepEqual(await store.upload("qm/production/point.qmbackup", Buffer.from("point"), sha256, retainUntil), {
    versionId: "version-1",
    sizeBytes: 5,
    sha256,
    immutableUntil: retainUntil,
  });
  assert.deepEqual(await store.verify("qm/production/point.qmbackup", "version-1", 5, sha256, retainUntil), {
    versionId: "version-1",
    sizeBytes: 5,
    sha256,
    immutableUntil: retainUntil,
  });

  assert.equal(calls[0]!.name, "PutObjectCommand");
  assert.equal(calls[0]!.input.ServerSideEncryption, "AES256");
  assert.equal(calls[0]!.input.ObjectLockMode, "GOVERNANCE");
  assert.equal(calls[0]!.input.IfNoneMatch, undefined);
  assert.equal(calls[0]!.input.ChecksumSHA256, Buffer.from(sha256, "hex").toString("base64"));
  assert.deepEqual(
    calls.slice(1).map((call) => call.name),
    ["ListObjectVersionsCommand", "HeadObjectCommand"],
  );
  assert.equal(calls[1]!.input.Prefix, "qm/production/point.qmbackup");
  assert.equal(calls[2]!.input.VersionId, "version-1");
});

test("B2 object store bounds downloads and rejects metadata or retention mismatch", async () => {
  const sha256 = "b".repeat(64);
  const send = async (command: any): Promise<any> => {
    if (command.constructor.name === "ListObjectVersionsCommand") {
      return {
        Versions: [
          {
            Key: "qm/production/point.qmbackup",
            VersionId: "version-1",
            Size: 5,
          },
        ],
      };
    }
    if (command.constructor.name === "GetObjectCommand") {
      return {
        Body: (async function* () {
          yield Buffer.alloc(4);
          yield Buffer.alloc(4);
          yield Buffer.alloc(4);
        })(),
      };
    }
    return { ContentLength: 5, Metadata: { "qm-sha256": "wrong" } };
  };
  const store = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    send,
  );
  await assert.rejects(store.download("qm/production/point.qmbackup", "version-1", 5), /byte limit/);
  await assert.rejects(
    store.download("qm/production/point.qmbackup", "version-1", MAX_BACKUP_ARCHIVE_BYTES + 2),
    /byte limit is invalid/,
  );
  await assert.rejects(store.verify("qm/production/point.qmbackup", "version-1", 5, sha256), /checksum metadata/);
  await assert.rejects(store.download("other-prefix/point.qmbackup", "version-1", 5), /prefix/);
});

test("B2 recovery listing excludes ambiguous versions and recovery reads stay pinned to listed versions", async () => {
  const key = "qm/production/manual/point-bkp_one.qmbackup";
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const store = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    async (command: any): Promise<any> => {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: (async function* () {
            yield Buffer.from("point");
          })(),
        };
      }
      return {
        Versions: [
          { Key: key, VersionId: "version-2", Size: 5, LastModified: new Date(2000) },
          { Key: key, VersionId: "version-1", Size: 5, LastModified: new Date(1000) },
        ],
      };
    },
  );

  await assert.rejects(store.probe(key), /ambiguous versions/);
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.download(key, "version-1", 6)).toString("utf8"), "point");
  assert.equal(calls.at(-1)?.name, "GetObjectCommand");
  assert.equal(calls.at(-1)?.input.VersionId, "version-1");

  const deleted = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    async () => ({ Versions: [{ Key: key, VersionId: "version-1" }], DeleteMarkers: [{ Key: key }] }),
  );
  await assert.rejects(deleted.probe(key), /ambiguous versions/);
  assert.deepEqual(await deleted.list(), []);
});

test("B2 recovery listing carries ambiguity detection across version pages", async () => {
  const splitKey = "qm/production/manual/point-bkp_split.qmbackup";
  const deletedKey = "qm/production/manual/point-bkp_deleted.qmbackup";
  const validKey = "qm/production/manual/point-bkp_valid.qmbackup";
  const calls: Array<Record<string, unknown>> = [];
  const store = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    async (command: any) => {
      calls.push(command.input);
      if (calls.length === 1) {
        return {
          IsTruncated: true,
          NextKeyMarker: splitKey,
          NextVersionIdMarker: "version-2",
          Versions: [
            { Key: splitKey, VersionId: "version-2", Size: 5 },
            { Key: deletedKey, VersionId: "version-1", Size: 5 },
          ],
        };
      }
      return {
        IsTruncated: false,
        Versions: [
          { Key: splitKey, VersionId: "version-1", Size: 5 },
          { Key: validKey, VersionId: "version-1", Size: 7, LastModified: new Date(3000) },
        ],
        DeleteMarkers: [{ Key: deletedKey, VersionId: "delete-1" }],
      };
    },
  );

  assert.deepEqual(await store.list(), [{ key: validKey, versionId: "version-1", sizeBytes: 7, lastModified: 3000 }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.KeyMarker, splitKey);
  assert.equal(calls[1]!.VersionIdMarker, "version-2");
});

test("B2 recovery listing fails closed when a truncated page omits its continuation", async () => {
  const store = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    async () => ({
      IsTruncated: true,
      Versions: [
        {
          Key: "qm/production/manual/point-bkp_one.qmbackup",
          VersionId: "version-1",
          Size: 5,
        },
      ],
    }),
  );

  await assert.rejects(store.list(), /continuation is invalid/);
});

test("B2 recovery listing bounds remote pagination when lifecycle history is unexpectedly unbounded", async () => {
  let page = 0;
  const store = createB2ObjectStore(
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      credential: { keyId: "key", applicationKey: "secret" },
    },
    async () => {
      page += 1;
      return {
        IsTruncated: true,
        NextKeyMarker: `qm/production/page-${page}`,
        Versions: [],
      };
    },
  );

  await assert.rejects(store.list(), /exceeds its safety limit/);
  assert.equal(page, 100);
});
