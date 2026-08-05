import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Decrypter } from "age-encryption";
import { CliError, note } from "../log.ts";
import { promptHidden } from "../util.ts";

type Flags = Record<string, string | boolean>;

interface RecoveryKitPublic {
  format: "qm-recovery-kit/v1";
  issuedAt: number;
  organizationId: string;
  deploymentId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  fingerprint: string;
  sourceCommit: string;
  recoveryImage: string;
  commands: string[];
}

interface InspectedKit {
  public: RecoveryKitPublic;
  recoveryImage: string;
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CliError(`--${name} needs a value`, { clause: "cli.invocation" });
  return value;
}

function exactFlags(flags: Flags, allowed: string[]): void {
  const unknown = Object.keys(flags).filter((name) => !allowed.includes(name));
  if (unknown.length) throw new CliError(`unknown option: --${unknown[0]}`, { clause: "cli.invocation" });
}

function privateRegularFile(path: string, label: string): string {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CliError(`${label} must be a regular file`);
  return realpathSync(resolved);
}

function privateSecretFile(path: string, label: string): string {
  const resolved = privateRegularFile(path, label);
  if ((lstatSync(resolved).mode & 0o077) !== 0) throw new CliError(`${label} must not be readable by group or other`);
  return resolved;
}

function boundedFile(path: string, maximumBytes: number, label: string): Buffer {
  const resolved = privateRegularFile(path, label);
  const metadata = lstatSync(resolved);
  if (metadata.size > maximumBytes) throw new CliError(`${label} exceeds its byte limit`);
  return readFileSync(resolved);
}

async function passphrase(flags: Flags): Promise<string> {
  const file = stringFlag(flags, "passphrase-file");
  if (!file) return promptHidden("Recovery kit passphrase");
  const bytes = boundedFile(privateSecretFile(file, "passphrase file"), 4096, "passphrase file");
  try {
    return bytes.toString("utf8").replace(/[\r\n]+$/, "");
  } finally {
    bytes.fill(0);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("recovery kit is invalid");
  return value as Record<string, unknown>;
}

function requiredText(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || !value) throw new CliError("recovery kit is invalid");
  return value;
}

async function inspectKit(kitFile: string, secret: string): Promise<InspectedKit> {
  const encrypted = boundedFile(kitFile, 16 * 1024 * 1024, "recovery kit");
  try {
    if (secret.length < 16 || secret.length > 1024) throw new CliError("recovery kit passphrase is invalid");
    const decrypter = new Decrypter();
    decrypter.addPassphrase(secret);
    const plaintext = await decrypter.decrypt(encrypted);
    const kit = object(JSON.parse(Buffer.from(plaintext).toString("utf8")));
    const destination = object(kit.destination);
    const recoveryImage = requiredText(kit, "recoveryImage");
    if (!/@sha256:[0-9a-f]{64}$/.test(recoveryImage)) {
      throw new CliError("recovery kit does not pin an immutable recovery image");
    }
    if (kit.format !== "qm-recovery-kit/v1" || !Number.isSafeInteger(kit.issuedAt)) {
      throw new CliError("recovery kit is invalid");
    }
    const commands = Array.isArray(kit.commands)
      ? kit.commands.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      recoveryImage,
      public: {
        format: "qm-recovery-kit/v1",
        issuedAt: kit.issuedAt as number,
        organizationId: requiredText(kit, "organizationId"),
        deploymentId: requiredText(kit, "deploymentId"),
        endpoint: requiredText(destination, "endpoint"),
        region: requiredText(destination, "region"),
        bucket: requiredText(destination, "bucket"),
        prefix: requiredText(destination, "prefix"),
        fingerprint: requiredText(kit, "fingerprint"),
        sourceCommit: requiredText(kit, "sourceCommit"),
        recoveryImage,
        commands,
      },
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("recovery kit could not be decrypted or validated");
  } finally {
    encrypted.fill(0);
  }
}

export function buildRecoveryContainerArgs(input: {
  image: string;
  kitFile: string;
  command: "list" | "inspect" | "verify" | "restore" | "prepare-cutover";
  recoveryPoint?: string;
  targetDatabaseUrlFile?: string;
  outputDir?: string;
}): string[] {
  const args = [
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
    `${input.kitFile}:/recovery/kit.age:ro`,
  ];
  if (input.targetDatabaseUrlFile) {
    args.push("-v", `${input.targetDatabaseUrlFile}:/run/secrets/target-database-url:ro`);
  }
  if (input.outputDir) {
    args.push("-v", `${input.outputDir}:/recovery/output:rw`);
  }
  args.push(input.image, input.command, "--kit-file", "/recovery/kit.age", "--passphrase-stdin");
  if (input.recoveryPoint) args.push("--recovery-point", input.recoveryPoint);
  if (input.targetDatabaseUrlFile) args.push("--target-database-url-file", "/run/secrets/target-database-url");
  if (input.outputDir) args.push("--output-dir", "/recovery/output");
  return args;
}

export async function runBackupCommand(positionals: string[], flags: Flags): Promise<void> {
  exactFlags(flags, ["kit-file", "passphrase-file", "runtime", "target-database-url-file", "output-dir"]);
  const kitFileFlag = stringFlag(flags, "kit-file");
  if (!kitFileFlag) throw new CliError("--kit-file is required", { clause: "cli.invocation" });
  const kitFile = privateRegularFile(kitFileFlag, "recovery kit");
  const secret = await passphrase(flags);
  try {
    const inspected = await inspectKit(kitFile, secret);
    if (positionals[0] === "kit" && positionals[1] === "inspect" && positionals.length === 2) {
      note(JSON.stringify(inspected.public, null, 2));
      return;
    }
    const command = positionals[0];
    if (!command || !["list", "inspect", "verify", "restore", "prepare-cutover"].includes(command)) {
      throw new CliError(
        "usage: qm backup kit inspect | list | inspect <point> | verify <point> | restore <point> | prepare-cutover <restored-dir>",
        { clause: "cli.invocation" },
      );
    }
    const recoveryPoint = ["inspect", "verify", "restore"].includes(command) ? positionals[1] : undefined;
    if (["inspect", "verify", "restore"].includes(command) && (!recoveryPoint || positionals.length !== 2)) {
      throw new CliError(`${command} requires exactly one recovery point`, { clause: "cli.invocation" });
    }
    if (command === "list" && positionals.length !== 1) {
      throw new CliError("list does not accept a recovery point", { clause: "cli.invocation" });
    }
    const restoredDir = command === "prepare-cutover" ? positionals[1] : undefined;
    if (command === "prepare-cutover" && (!restoredDir || positionals.length !== 2)) {
      throw new CliError("prepare-cutover requires exactly one restored deployment directory", {
        clause: "cli.invocation",
      });
    }
    const targetFileFlag = stringFlag(flags, "target-database-url-file");
    if (command === "restore" && !targetFileFlag) {
      throw new CliError("restore requires --target-database-url-file", { clause: "cli.invocation" });
    }
    const targetDatabaseUrlFile = targetFileFlag
      ? privateSecretFile(targetFileFlag, "target database URL file")
      : undefined;
    const outputFlag = stringFlag(flags, "output-dir");
    if (command === "restore" && !outputFlag) {
      throw new CliError("restore requires --output-dir", { clause: "cli.invocation" });
    }
    const outputDir = resolve(restoredDir ?? outputFlag ?? "");
    const runtime = stringFlag(flags, "runtime") ?? "podman";
    if (runtime !== "podman" && runtime !== "docker") {
      throw new CliError("--runtime must be podman or docker", { clause: "cli.invocation" });
    }
    const containerCommand = command as "list" | "inspect" | "verify" | "restore" | "prepare-cutover";
    const args = buildRecoveryContainerArgs({
      image: inspected.recoveryImage,
      kitFile,
      command: containerCommand,
      ...(recoveryPoint ? { recoveryPoint } : {}),
      ...(targetDatabaseUrlFile ? { targetDatabaseUrlFile } : {}),
      ...((command === "restore" || command === "prepare-cutover") && outputDir ? { outputDir } : {}),
    });
    const result = spawnSync(runtime, args, { stdio: ["pipe", "inherit", "inherit"], input: `${secret}\n` });
    if (result.error) throw new CliError(`${runtime} could not launch the pinned recovery image`);
    if (result.status !== 0) throw new CliError(`recovery command failed with exit ${result.status ?? "unknown"}`);
  } finally {
    Buffer.from(secret).fill(0);
  }
}
