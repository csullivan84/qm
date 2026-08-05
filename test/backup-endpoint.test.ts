import assert from "node:assert/strict";
import test from "node:test";
import { backupObjectKey, normalizeB2Destination } from "../src/backup/endpoint.ts";

test("B2 destination normalization accepts only exact regional HTTPS endpoints and safe prefixes", () => {
  assert.deepEqual(
    normalizeB2Destination({
      endpoint: "https://s3.us-west-004.backblazeb2.com/",
      bucket: "qm-backups-test",
      prefix: "/qm//production/",
    }),
    {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
    },
  );

  for (const endpoint of [
    "http://s3.us-west-004.backblazeb2.com",
    "https://s3.us-west-004.backblazeb2.com.evil.example",
    "https://user:pass@s3.us-west-004.backblazeb2.com",
    "https://127.0.0.1",
    "https://s3.us-west-004.backblazeb2.com/path",
  ]) {
    assert.throws(() => normalizeB2Destination({ endpoint, bucket: "qm-backups-test", prefix: "qm" }), /B2 endpoint/);
  }

  for (const prefix of ["../escape", "qm/../escape", "qm\u0000bad", "qm\\windows"]) {
    assert.throws(
      () =>
        normalizeB2Destination({
          endpoint: "https://s3.us-west-004.backblazeb2.com",
          bucket: "qm-backups-test",
          prefix,
        }),
      /prefix/,
    );
  }
});

test("backup object keys are deterministic, normalized, and retention-class scoped", () => {
  assert.equal(
    backupObjectKey({
      prefix: "qm/production/",
      deploymentId: "example-host",
      retentionClass: "predeploy",
      startedAt: Date.UTC(2026, 7, 4, 12, 13, 14),
      jobId: "bkp_abc123",
    }),
    "qm/production/qm-backup/v1/example-host/predeploy/20260804T121314Z-bkp_abc123.qmbackup",
  );
  assert.throws(
    () =>
      backupObjectKey({
        prefix: "",
        deploymentId: "../example-host",
        retentionClass: "manual",
        startedAt: 0,
        jobId: "bkp_ok",
      }),
    /deployment/,
  );
});
