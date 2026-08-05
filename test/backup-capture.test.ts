import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptAge, generateRecoveryIdentity } from "../src/backup/age.ts";
import { verifySafeTar } from "../src/backup/archive.ts";
import { captureEncryptedDatabase, createEncryptedAllowlistedTar } from "../src/backup/capture.ts";

test("database capture streams pg_dump stdout without asking PostgreSQL 18 to open a file named dash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-pg-dump-"));
  try {
    const recovery = await generateRecoveryIdentity();
    const argumentsFile = join(directory, "arguments.json");
    const executable = join(directory, "fake-pg-dump.mjs");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.ARGUMENTS_FILE, JSON.stringify(process.argv.slice(2)));",
        'process.stdout.write("PGDMP fake custom dump");',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const output = join(directory, "database.dump.age");
    await captureEncryptedDatabase({
      databaseUrl: "postgresql://qm:dummy-password@db.example/qm?sslmode=require",
      recipients: [recovery.recipient],
      outputPath: output,
      snapshotId: "00000003-0000001b-1",
      pgDumpBin: executable,
      environment: { ...process.env, ARGUMENTS_FILE: argumentsFile },
    });

    assert.deepEqual(JSON.parse(await readFile(argumentsFile, "utf8")), [
      "--format=custom",
      "--compress=zstd:6",
      "--no-owner",
      "--no-privileges",
      "--snapshot=00000003-0000001b-1",
    ]);
    assert.equal(
      Buffer.from(await decryptAge(await readFile(output), recovery.identity)).toString("utf8"),
      "PGDMP fake custom dump",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowlisted recovery inputs stream into an encrypted normalized tar without plaintext staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-capture-"));
  try {
    const deployment = join(directory, "deployment");
    await mkdir(join(deployment, "quadlets"), { recursive: true });
    await writeFile(join(deployment, "quadlets", "qm.container"), "unit\n", { mode: 0o600 });
    const recovery = await generateRecoveryIdentity();
    const output = join(directory, "deployment.tar.age");
    const result = await createEncryptedAllowlistedTar({
      inputs: [{ source: deployment, archiveRoot: "deployment" }],
      allowedRoots: [deployment],
      recipients: [recovery.recipient],
      outputPath: output,
      ...(process.platform === "linux"
        ? {}
        : { resolveDescriptorPath: async () => realpath(join(deployment, "quadlets", "qm.container")) }),
    });

    assert.equal(result.entryCount, 1);
    const ciphertext = await readFile(output);
    assert.equal(ciphertext.includes(Buffer.from("unit\n")), false);
    const plaintext = await decryptAge(ciphertext, recovery.identity);
    assert.deepEqual(await verifySafeTar(plaintext), ["deployment/quadlets/qm.container"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowlisted recovery collector rejects symlinks even when their current target is inside the root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-symlink-"));
  try {
    await writeFile(join(directory, "real"), "secret");
    await symlink(join(directory, "real"), join(directory, "link"));
    const recovery = await generateRecoveryIdentity();
    await assert.rejects(
      createEncryptedAllowlistedTar({
        inputs: [{ source: join(directory, "link"), archiveRoot: "secrets/link" }],
        allowedRoots: [directory],
        recipients: [recovery.recipient],
        outputPath: join(directory, "secrets.tar.age"),
      }),
      /symlink/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowlisted recovery collector rejects a symlink in an input ancestor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-ancestor-symlink-"));
  try {
    const realDirectory = join(directory, "real");
    await mkdir(realDirectory);
    await writeFile(join(realDirectory, "input"), "secret");
    await symlink(realDirectory, join(directory, "alias"));
    const recovery = await generateRecoveryIdentity();
    await assert.rejects(
      createEncryptedAllowlistedTar({
        inputs: [{ source: join(directory, "alias", "input"), archiveRoot: "secrets/input" }],
        allowedRoots: [directory],
        recipients: [recovery.recipient],
        outputPath: join(directory, "secrets.tar.age"),
      }),
      /symlink path component/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowlisted recovery collector rejects a same-size pathname substitution before opening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-inode-race-"));
  try {
    const source = join(directory, "input");
    const replacement = join(directory, "replacement");
    const original = join(directory, "original");
    await writeFile(source, "first!");
    await writeFile(replacement, "second");
    const recovery = await generateRecoveryIdentity();
    let replaced = false;
    await assert.rejects(
      createEncryptedAllowlistedTar({
        inputs: [{ source, archiveRoot: "secrets/input" }],
        allowedRoots: [directory],
        recipients: [recovery.recipient],
        outputPath: join(directory, "secrets.tar.age"),
        beforeFileOpen: async () => {
          if (replaced) return;
          replaced = true;
          await rename(source, original);
          await rename(replacement, source);
        },
        ...(process.platform === "linux" ? {} : { resolveDescriptorPath: async () => realpath(source) }),
      }),
      /changed during capture/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowlisted recovery collector validates the opened descriptor path rather than a raced pathname", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-backup-descriptor-path-"));
  const outside = await mkdtemp(join(tmpdir(), "qm-backup-descriptor-outside-"));
  try {
    const source = join(directory, "input");
    await writeFile(source, "secret");
    const recovery = await generateRecoveryIdentity();
    await assert.rejects(
      createEncryptedAllowlistedTar({
        inputs: [{ source, archiveRoot: "secrets/input" }],
        allowedRoots: [directory],
        recipients: [recovery.recipient],
        outputPath: join(directory, "secrets.tar.age"),
        resolveDescriptorPath: async () => join(outside, "input"),
      }),
      /changed during capture/,
    );
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});
