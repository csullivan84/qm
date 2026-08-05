import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateRecoveryIdentity } from "../src/backup/age.ts";
import { createRecoveryKit } from "../src/backup/recovery-kit.ts";

const passphrase = "correct horse battery staple";

async function recoveryKit(directory: string): Promise<string> {
  const identity = await generateRecoveryIdentity();
  const created = await createRecoveryKit({
    passphrase,
    offlineIdentity: identity.identity,
    offlineRecipient: identity.recipient,
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
  });
  const path = join(directory, "kit.age");
  await writeFile(path, created.bytes, { mode: 0o600 });
  return path;
}

async function runRecovery(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["src/backup/recovery-cli-main.ts", ...args], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${passphrase}\n`);
  const read = async (stream: NodeJS.ReadableStream): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };
  const [stdout, stderr, code] = await Promise.all([
    read(child.stdout),
    read(child.stderr),
    new Promise<number | null>((resolve) => child.on("close", resolve)),
  ]);
  return { code, stdout, stderr };
}

function receipt(proof: boolean) {
  return {
    format: "qm-restore-receipt/v1",
    restoredAt: 1,
    recoveryPoint: "bkp_one",
    objectKey: "qm/bkp_one.qmbackup",
    objectVersionId: "version-one",
    archiveSha256: "a".repeat(64),
    organizationId: "default-org",
    deploymentId: "example-host",
    targetDatabase: "qm_restore_proof",
    sourceCommit: "b".repeat(40),
    sourceImages: ["localhost/qm@sha256:" + "c".repeat(64)],
    deploymentFileCount: 1,
    secretFileCount: 1,
    rotationsRequired: ["portal session secret"],
    ...(proof
      ? {
          proof: {
            postgresServerVersionNum: 180004,
            expectedDatabaseInvariants: {
              targetPostgresServerVersionNum: 180004,
              organizationId: "default-org",
              minimumTableCount: 1,
              tableRowCountsJson: JSON.stringify({ sessions: "1" }),
              tableMaxTimestampsJson: JSON.stringify({ "sessions.updated_at": "1" }),
              requiredApplicationTablesJson: JSON.stringify(["sessions"]),
            },
            invariants: {
              postgresVersion: true,
              schema: true,
              rowBounds: true,
              timestamps: true,
              organization: true,
              applicationHealth: true,
            },
          },
        }
      : {}),
  };
}

test("prepare-cutover accepts only a complete PostgreSQL 18.4 recovery proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-recovery-cli-"));
  try {
    const kit = await recoveryKit(directory);
    await writeFile(join(directory, "restore-receipt.json"), JSON.stringify(receipt(true)), { mode: 0o600 });
    const accepted = await runRecovery([
      "prepare-cutover",
      "--kit-file",
      kit,
      "--output-dir",
      directory,
      "--passphrase-stdin",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).status, "approval_required");
    await writeFile(join(directory, "restore-receipt.json"), JSON.stringify(receipt(false)), { mode: 0o600 });
    const rejected = await runRecovery([
      "prepare-cutover",
      "--kit-file",
      kit,
      "--output-dir",
      directory,
      "--passphrase-stdin",
    ]);
    assert.notEqual(rejected.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-cutover rejects a missing output directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-recovery-cli-"));
  try {
    const kit = await recoveryKit(directory);
    const result = await runRecovery(["prepare-cutover", "--kit-file", kit, "--passphrase-stdin"]);
    assert.notEqual(result.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
