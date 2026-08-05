import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRecoveryContainerArgs } from "../src/commands/backup.ts";

test("recovery container argv is immutable, locked down, and contains no passphrase or database URL", () => {
  const args = buildRecoveryContainerArgs({
    image: `localhost/qm-recovery@sha256:${"a".repeat(64)}`,
    kitFile: "/private/kit.age",
    command: "restore",
    recoveryPoint: "bkp_proof",
    targetDatabaseUrlFile: "/private/target-url",
    outputDir: "/private/restored",
  });
  assert.deepEqual(args.slice(0, 11), [
    "run",
    "--rm",
    "--pull=never",
    "--network=host",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,mode=0700",
    "-i",
    "-v",
  ]);
  assert.ok(args.includes("/private/kit.age:/recovery/kit.age:ro"));
  assert.ok(args.includes("/private/target-url:/run/secrets/target-database-url:ro"));
  assert.ok(args.includes("/private/restored:/recovery/output:rw"));
  assert.ok(args.includes("--passphrase-stdin"));
  assert.doesNotMatch(args.join(" "), /correct horse|postgresql:\/\//);
});

test("recovery container appends only CLI arguments to its image entrypoint", async () => {
  const args = buildRecoveryContainerArgs({
    image: `localhost/qm-recovery@sha256:${"a".repeat(64)}`,
    kitFile: "/private/kit.age",
    command: "verify",
    recoveryPoint: "bkp_proof",
  });
  const imageIndex = args.indexOf(`localhost/qm-recovery@sha256:${"a".repeat(64)}`);
  assert.deepEqual(args.slice(imageIndex), [
    `localhost/qm-recovery@sha256:${"a".repeat(64)}`,
    "verify",
    "--kit-file",
    "/recovery/kit.age",
    "--passphrase-stdin",
    "--recovery-point",
    "bkp_proof",
  ]);
  const dockerfile = await readFile(new URL("../../deploy/recovery/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/src\/backup\/recovery-cli-main\.ts"\]/);
});
