import assert from "node:assert/strict";
import test from "node:test";
import { generateRecoveryIdentity } from "../src/backup/age.ts";
import { createRecoveryKit, inspectRecoveryKit } from "../src/backup/recovery-kit.ts";

test("recovery kit contains the offline identity and destination bootstrap only inside a one-time encrypted envelope", async () => {
  const offline = await generateRecoveryIdentity();
  const created = await createRecoveryKit({
    passphrase: "correct horse battery staple",
    offlineIdentity: offline.identity,
    offlineRecipient: offline.recipient,
    organizationId: "default-org",
    deploymentId: "example-host",
    destination: {
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "qm-backups-test",
      prefix: "qm/production/",
      keyId: "recovery-key-id",
      applicationKey: "recovery-application-key",
    },
    sourceCommit: "a".repeat(40),
    recoveryImage: "localhost/qm-backup@sha256:" + "b".repeat(64),
    issuedAt: 1000,
  });

  assert.equal(Buffer.from(created.bytes).includes(Buffer.from("recovery-application-key")), false);
  const inspected = await inspectRecoveryKit(created.bytes, "correct horse battery staple");
  assert.equal(inspected.public.fingerprint, offline.fingerprint);
  assert.equal(inspected.public.bucket, "qm-backups-test");
  assert.doesNotMatch(JSON.stringify(inspected.public), /recovery-application-key|AGE-SECRET-KEY/);
  assert.equal(inspected.secret.destination.applicationKey, "recovery-application-key");
  assert.equal(inspected.secret.offlineIdentity, offline.identity);
  assert.equal(
    inspected.secret.commands.find((command) => command.startsWith("qm backup restore")),
    "qm backup restore <recovery-point> --kit-file <path> --target-database-url-file <path> --output-dir <empty-directory>",
  );
});

test("recovery kit creation rejects a private identity that does not match the configured recipient", async () => {
  const first = await generateRecoveryIdentity();
  const second = await generateRecoveryIdentity();
  await assert.rejects(
    createRecoveryKit({
      passphrase: "correct horse battery staple",
      offlineIdentity: first.identity,
      offlineRecipient: second.recipient,
      organizationId: "default-org",
      deploymentId: "example-host",
      destination: {
        endpoint: "https://s3.us-west-004.backblazeb2.com",
        region: "us-west-004",
        bucket: "qm-backups-test",
        prefix: "qm/production/",
        keyId: "key",
        applicationKey: "secret",
      },
      sourceCommit: "a".repeat(40),
      recoveryImage: "image",
    }),
    /does not match/,
  );
});
