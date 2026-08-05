import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const sourceScript = resolve(import.meta.dirname, "../scripts/sync-remote-source.sh");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

test("syncs an exact committed source checkout through the public repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qm-remote-sync-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const mirror = join(root, "remote", "qm.git");
  const builds = join(root, "remote", "builds");
  const fakeBin = join(root, "bin");

  await mkdir(join(source, "scripts"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await git(root, "init", "--bare", origin);
  await git(root, "init", "--initial-branch=main", source);
  await copyFile(sourceScript, join(source, "scripts", "sync-remote-source.sh"));
  await writeFile(join(source, "README.md"), "QM sync test\n");
  await git(source, "config", "user.name", "QM Test");
  await git(source, "config", "user.email", "qm-test@example.com");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "test: seed source sync");
  await git(source, "remote", "add", "origin", origin);

  const fakeSsh = join(fakeBin, "ssh");
  await writeFile(fakeSsh, '#!/usr/bin/env bash\nset -euo pipefail\nshift\nexec "$@"\n');
  await chmod(fakeSsh, 0o755);

  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    QM_REMOTE_HOST: "test-remote",
    QM_PUBLIC_REPO_URL: origin,
    QM_REMOTE_MIRROR: mirror,
    QM_REMOTE_BUILD_ROOT: builds,
  };
  const first = await execFile("bash", ["scripts/sync-remote-source.sh"], {
    cwd: source,
    env: environment,
    encoding: "utf8",
  });
  const sha = await git(source, "rev-parse", "HEAD");
  const shortSha = await git(source, "rev-parse", "--short=8", "HEAD");
  const checkout = join(builds, `qm-${shortSha}`);

  assert.equal(await git(checkout, "rev-parse", "HEAD"), sha);
  assert.match(first.stdout, new RegExp(`source_checkout=${checkout.replaceAll("/", "\\/")}`));
  assert.match(first.stdout, new RegExp(`source_sha=${sha}`));

  const second = await execFile("bash", ["scripts/sync-remote-source.sh"], {
    cwd: source,
    env: environment,
    encoding: "utf8",
  });
  assert.match(second.stdout, /source_status=already-synced/);
  assert.equal(await readFile(join(checkout, "README.md"), "utf8"), "QM sync test\n");
});

test("refuses to sync an uncommitted worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qm-remote-dirty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await git(root, "init", "--initial-branch=main");
  await copyFile(sourceScript, join(root, "scripts", "sync-remote-source.sh"));
  await git(root, "config", "user.name", "QM Test");
  await git(root, "config", "user.email", "qm-test@example.com");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "test: seed dirty guard");
  await writeFile(join(root, "dirty.txt"), "dirty\n");

  await assert.rejects(
    execFile("bash", ["scripts/sync-remote-source.sh"], {
      cwd: root,
      env: { ...process.env, QM_REMOTE_HOST: "test-remote" },
      encoding: "utf8",
    }),
    (error: unknown) => {
      const failure = error as { stderr?: string };
      assert.match(failure.stderr ?? "", /worktree must be clean/);
      return true;
    },
  );
});
