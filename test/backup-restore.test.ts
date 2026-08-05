import assert from "node:assert/strict";
import test from "node:test";
import { encryptAge, generateRecoveryIdentity } from "../src/backup/age.ts";
import { assertIsolatedRestoreTarget, restoreEncryptedDatabase } from "../src/backup/restore.ts";

test("restore streams decrypted custom dump bytes to pg_restore without placing credentials in argv", async () => {
  const identity = await generateRecoveryIdentity();
  const encrypted = await encryptAge(Buffer.from("custom dump bytes"), [identity.recipient]);
  let observed: { args: string[]; env: NodeJS.ProcessEnv; input: Buffer } | undefined;
  await restoreEncryptedDatabase({
    encrypted,
    identity: identity.identity,
    targetDatabaseUrl:
      "postgresql://restore-user:restore-password@restore-db:5432/qm_restore_drill?application_name=qm-backup-restore",
    runPgRestore: async (args, env, source) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      observed = { args, env, input: Buffer.concat(chunks) };
    },
  });

  assert.deepEqual(observed?.args, [
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    "--dbname",
    "qm_restore_drill",
  ]);
  assert.equal(observed?.env.PGPASSWORD, "restore-password");
  assert.equal(observed?.args.join(" ").includes("restore-password"), false);
  assert.equal(observed?.input.toString(), "custom dump bytes");
});

test("restore refuses production-looking or non-empty-target naming before decryption", () => {
  for (const url of [
    "postgresql://user:pass@db:5432/qm",
    "postgresql://user:pass@db:5432/qm_restore_drill",
    "postgresql://user:pass@db:5432/qm_restore_drill?application_name=qm",
  ]) {
    assert.throws(() => assertIsolatedRestoreTarget(url), /isolated restore target/);
  }
});
