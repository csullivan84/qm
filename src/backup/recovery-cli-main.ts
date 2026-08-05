import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  extractSafeTarEntries,
  inspectBackupArchive,
  MAX_BACKUP_ARCHIVE_BYTES,
  verifySafeTar,
  type BackupManifest,
} from "./archive.ts";
import { decryptAge } from "./age.ts";
import { createB2ObjectStore } from "./object-store.ts";
import { inspectRecoveryKit, type RecoveryKit } from "./recovery-kit.ts";
import {
  REQUIRED_POSTGRES_SERVER_VERSION_NUM,
  requiredDatabaseInvariants,
  restoreEncryptedDatabase,
  verifyRestoredDatabase,
} from "./restore.ts";

const MAX_KIT_BYTES = 16 * 1024 * 1024;
const MAX_PASSPHRASE_BYTES = 4096;
const RECOVERY_POINT = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;

interface ParsedArgs {
  command: "list" | "inspect" | "verify" | "restore" | "prepare-cutover";
  kitFile: string;
  recoveryPoint?: string;
  targetDatabaseUrlFile?: string;
  outputDir?: string;
  passphraseStdin: boolean;
}

interface RecoveryPoint {
  id: string;
  key: string;
  versionId: string;
  sizeBytes: number;
  lastModified?: number;
}

interface RestoreReceipt {
  format: "qm-restore-receipt/v1";
  restoredAt: number;
  recoveryPoint: string;
  objectKey: string;
  objectVersionId: string;
  archiveSha256: string;
  organizationId: string;
  deploymentId: string;
  targetDatabase: string;
  sourceCommit: string;
  sourceImages: string[];
  deploymentFileCount: number;
  secretFileCount: number;
  rotationsRequired: string[];
  proof: {
    postgresServerVersionNum: number;
    expectedDatabaseInvariants: Record<string, string | number | boolean>;
    invariants: {
      postgresVersion: boolean;
      schema: boolean;
      rowBounds: boolean;
      timestamps: boolean;
      organization: boolean;
      applicationHealth: boolean;
    };
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (!command || !["list", "inspect", "verify", "restore", "prepare-cutover"].includes(command)) {
    fail("invalid recovery command");
  }
  const values = new Map<string, string>();
  let passphraseStdin = false;
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index]!;
    if (name === "--passphrase-stdin") {
      passphraseStdin = true;
      continue;
    }
    if (
      !name.startsWith("--") ||
      !["--kit-file", "--recovery-point", "--target-database-url-file", "--output-dir"].includes(name)
    ) {
      fail("invalid recovery option");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--") || values.has(name)) fail("invalid recovery option value");
    values.set(name, value);
  }
  const kitFile = values.get("--kit-file");
  if (!kitFile || !passphraseStdin) fail("recovery kit and passphrase input are required");
  return {
    command: command as ParsedArgs["command"],
    kitFile,
    passphraseStdin,
    ...(values.get("--recovery-point") ? { recoveryPoint: values.get("--recovery-point") } : {}),
    ...(values.get("--target-database-url-file")
      ? { targetDatabaseUrlFile: values.get("--target-database-url-file") }
      : {}),
    ...(values.get("--output-dir") ? { outputDir: values.get("--output-dir") } : {}),
  };
}

async function boundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) fail(`${label} is invalid`);
  return readFile(await realpath(path));
}

async function readPassphrase(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PASSPHRASE_BYTES) fail("passphrase input is invalid");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    const value = bytes.toString("utf8").replace(/[\r\n]+$/, "");
    if (value.length < 16 || value.length > 1024) fail("passphrase input is invalid");
    return value;
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function pointId(key: string): string | undefined {
  const match = /-([a-z0-9][a-z0-9_-]{0,127})\.qmbackup$/.exec(basename(key));
  return match?.[1];
}

async function recoveryPoints(store: ReturnType<typeof createB2ObjectStore>): Promise<RecoveryPoint[]> {
  const objects = await store.list(1000);
  return objects
    .map((object) => {
      const id = pointId(object.key);
      return id ? { id, ...object } : null;
    })
    .filter((point): point is RecoveryPoint => point !== null)
    .sort((left, right) => (right.lastModified ?? 0) - (left.lastModified ?? 0));
}

async function selectedPoint(
  store: ReturnType<typeof createB2ObjectStore>,
  requested: string | undefined,
): Promise<RecoveryPoint> {
  if (!requested || !RECOVERY_POINT.test(requested)) fail("recovery point identifier is invalid");
  const matches = (await recoveryPoints(store)).filter((point) => point.id === requested);
  if (matches.length !== 1)
    fail(matches.length ? "recovery point identifier is ambiguous" : "recovery point not found");
  return matches[0]!;
}

function validateManifest(manifest: BackupManifest, kit: RecoveryKit, point: RecoveryPoint): void {
  if (
    manifest.jobId !== point.id ||
    manifest.organizationId !== kit.organizationId ||
    manifest.deploymentId !== kit.deploymentId ||
    manifest.restoreCompatibility.archiveFormat !== 1 ||
    manifest.restoreCompatibility.maximumToolMajor < 1
  ) {
    fail("recovery point identity or compatibility does not match the recovery kit");
  }
}

async function downloadedPoint(
  store: ReturnType<typeof createB2ObjectStore>,
  kit: RecoveryKit,
  requested: string | undefined,
) {
  const point = await selectedPoint(store, requested);
  if (point.sizeBytes <= 0 || point.sizeBytes > MAX_BACKUP_ARCHIVE_BYTES) fail("recovery point size is invalid");
  const archive = await store.download(point.key, point.versionId, point.sizeBytes + 1);
  if (archive.length !== point.sizeBytes) fail("recovery point size does not match object metadata");
  const inspected = await inspectBackupArchive(archive);
  validateManifest(inspected.manifest, kit, point);
  return { point, archive, inspected };
}

async function decryptedComponents(entries: Map<string, Buffer>, identity: string) {
  const [database, deployment, secrets] = await Promise.all([
    decryptAge(entries.get("database.dump.age")!, identity),
    decryptAge(entries.get("deployment.tar.age")!, identity),
    decryptAge(entries.get("secrets.tar.age")!, identity),
  ]);
  if (!Buffer.from(database).subarray(0, 5).equals(Buffer.from("PGDMP"))) fail("database dump format is invalid");
  const [deploymentFiles, secretFiles] = await Promise.all([verifySafeTar(deployment), verifySafeTar(secrets)]);
  return { database, deployment, secrets, deploymentFiles, secretFiles };
}

function containedPath(root: string, name: string): string {
  const target = resolve(root, name);
  const local = relative(root, target);
  if (!local || local.startsWith(`..${sep}`) || local === ".." || resolve(root, local) !== target)
    fail("restore path is unsafe");
  return target;
}

async function requireEmptyDirectory(path: string): Promise<string> {
  const root = await realpath(path);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await readdir(root)).length !== 0) {
    fail("restore output directory must be an existing empty directory");
  }
  return root;
}

async function materializeTar(bytes: Uint8Array, root: string): Promise<number> {
  const entries = await extractSafeTarEntries(bytes);
  for (const [name, body] of entries) {
    const target = containedPath(root, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
      body.fill(0);
    }
  }
  return entries.size;
}

async function targetDatabaseUrl(path: string | undefined): Promise<{ value: string; database: string }> {
  if (!path) fail("target database URL file is required");
  const bytes = await boundedRegularFile(path, 16 * 1024, "target database URL file");
  try {
    const value = bytes.toString("utf8").trim();
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!/^qm_restore_[a-z0-9_]+$/.test(database) || url.searchParams.get("application_name") !== "qm-backup-restore") {
      fail("target database must be an explicit isolated qm_restore database");
    }
    return { value, database };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("target database")) throw error;
    fail("target database URL file is invalid");
  } finally {
    bytes.fill(0);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isCompleteRecoveryProof(value: unknown): value is RestoreReceipt["proof"] {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<RestoreReceipt["proof"]>;
  if (proof.postgresServerVersionNum !== REQUIRED_POSTGRES_SERVER_VERSION_NUM) return false;
  const invariants = proof.invariants;
  const names = ["postgresVersion", "schema", "rowBounds", "timestamps", "organization", "applicationHealth"];
  return (
    Boolean(invariants) &&
    typeof invariants === "object" &&
    Object.keys(invariants).length === names.length &&
    names.every((name) => invariants[name as keyof typeof invariants] === true)
  );
}

async function prepareCutover(path: string | undefined, kit: RecoveryKit): Promise<void> {
  if (!path) fail("restored deployment directory is required");
  const root = await realpath(path);
  const receiptBytes = await boundedRegularFile(join(root, "restore-receipt.json"), 1024 * 1024, "restore receipt");
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as RestoreReceipt;
  const proof = receipt.proof;
  if (!isCompleteRecoveryProof(proof)) fail("restore receipt does not contain a complete recovery proof");
  let expected: ReturnType<typeof requiredDatabaseInvariants>;
  try {
    expected = requiredDatabaseInvariants(proof.expectedDatabaseInvariants);
  } catch {
    fail("restore receipt does not contain complete database proof");
  }
  if (
    receipt.format !== "qm-restore-receipt/v1" ||
    receipt.organizationId !== kit.organizationId ||
    receipt.deploymentId !== kit.deploymentId ||
    typeof receipt.objectVersionId !== "string" ||
    !receipt.objectVersionId.trim() ||
    receipt.objectVersionId.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(receipt.objectVersionId) ||
    expected.organizationId !== receipt.organizationId
  ) {
    fail("restore receipt does not contain a complete recovery proof");
  }
  writeJson({
    status: "approval_required",
    source: {
      recoveryPoint: receipt.recoveryPoint,
      deploymentId: receipt.deploymentId,
      sourceCommit: receipt.sourceCommit,
      archiveSha256: receipt.archiveSha256,
      objectVersionId: receipt.objectVersionId,
    },
    target: { database: receipt.targetDatabase, restoredDirectory: root },
    requiredBeforeApproval: [
      "Rotate every credential named by rotationsRequired.",
      "Boot restored services only on non-public addresses.",
      "Validate application health, organization identity, authentication, and connectors.",
      "Record the exact old and new proxy targets and a tested rollback command.",
      "Obtain explicit operator approval before changing public routing.",
      "Preserve the original environment after cutover until retirement is separately approved.",
    ],
    rotationsRequired: receipt.rotationsRequired,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const passphrase = await readPassphrase();
  const kitBytes = await boundedRegularFile(args.kitFile, MAX_KIT_BYTES, "recovery kit");
  let kit: RecoveryKit;
  try {
    kit = (await inspectRecoveryKit(kitBytes, passphrase)).secret;
  } finally {
    kitBytes.fill(0);
    Buffer.from(passphrase).fill(0);
  }
  if (args.command === "prepare-cutover") {
    await prepareCutover(args.outputDir, kit);
    return;
  }
  const store = createB2ObjectStore({
    endpoint: kit.destination.endpoint,
    region: kit.destination.region,
    bucket: kit.destination.bucket,
    prefix: kit.destination.prefix,
    credential: { keyId: kit.destination.keyId, applicationKey: kit.destination.applicationKey },
  });
  try {
    if (args.command === "list") {
      const points = await recoveryPoints(store);
      writeJson(
        points.map(({ id, versionId, sizeBytes, lastModified }) => ({
          id,
          versionId,
          sizeBytes,
          ...(lastModified ? { completedAt: new Date(lastModified).toISOString() } : {}),
        })),
      );
      return;
    }
    const selected = await downloadedPoint(store, kit, args.recoveryPoint);
    if (args.command === "inspect") {
      writeJson({
        id: selected.point.id,
        versionId: selected.point.versionId,
        sizeBytes: selected.point.sizeBytes,
        archiveSha256: selected.inspected.archiveSha256,
        manifest: selected.inspected.manifest,
      });
      return;
    }
    const decrypted = await decryptedComponents(selected.inspected.entries, kit.offlineIdentity);
    if (args.command === "verify") {
      writeJson({
        id: selected.point.id,
        archiveSha256: selected.inspected.archiveSha256,
        versionId: selected.point.versionId,
        checksumVerified: true,
        databaseDecrypted: true,
        deploymentFilesVerified: decrypted.deploymentFiles.length,
        secretFilesVerified: decrypted.secretFiles.length,
      });
      return;
    }
    if (!args.outputDir) fail("restore output directory is required");
    const output = await requireEmptyDirectory(args.outputDir);
    const target = await targetDatabaseUrl(args.targetDatabaseUrlFile);
    await restoreEncryptedDatabase({
      encrypted: selected.inspected.entries.get("database.dump.age")!,
      identity: kit.offlineIdentity,
      targetDatabaseUrl: target.value,
    });
    const invariants = await verifyRestoredDatabase({
      databaseUrl: target.value,
      expected: selected.inspected.manifest.expectedDatabaseInvariants,
    });
    if (
      invariants.postgresServerVersionNum !== REQUIRED_POSTGRES_SERVER_VERSION_NUM ||
      !Object.values({
        postgresVersion: invariants.postgresVersion,
        schema: invariants.schema,
        rowBounds: invariants.rowBounds,
        timestamps: invariants.timestamps,
        organization: invariants.organization,
        applicationHealth: invariants.applicationHealth,
      }).every(Boolean)
    ) {
      fail("restored database does not satisfy the required recovery proof");
    }
    const deploymentRoot = join(output, "deployment");
    const secretRoot = join(output, "secrets");
    await mkdir(deploymentRoot, { mode: 0o700 });
    await mkdir(secretRoot, { mode: 0o700 });
    const [deploymentFileCount, secretFileCount] = await Promise.all([
      materializeTar(decrypted.deployment, deploymentRoot),
      materializeTar(decrypted.secrets, secretRoot),
    ]);
    const receipt: RestoreReceipt = {
      format: "qm-restore-receipt/v1",
      restoredAt: Date.now(),
      recoveryPoint: selected.point.id,
      objectKey: selected.point.key,
      objectVersionId: selected.point.versionId,
      archiveSha256: selected.inspected.archiveSha256,
      organizationId: selected.inspected.manifest.organizationId,
      deploymentId: selected.inspected.manifest.deploymentId,
      targetDatabase: target.database,
      sourceCommit: selected.inspected.manifest.sourceCommit,
      sourceImages: selected.inspected.manifest.sourceImages,
      deploymentFileCount,
      secretFileCount,
      rotationsRequired: ["portal session secret", "portal identity secret", "core signing secret"],
      proof: {
        postgresServerVersionNum: invariants.postgresServerVersionNum,
        expectedDatabaseInvariants: selected.inspected.manifest.expectedDatabaseInvariants,
        invariants: {
          postgresVersion: invariants.postgresVersion,
          schema: invariants.schema,
          rowBounds: invariants.rowBounds,
          timestamps: invariants.timestamps,
          organization: invariants.organization,
          applicationHealth: invariants.applicationHealth,
        },
      },
    };
    await writeFile(join(output, "restore-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await access(join(output, "restore-receipt.json"), constants.R_OK);
    writeJson({
      status: "restored_not_cut_over",
      recoveryPoint: receipt.recoveryPoint,
      archiveSha256: receipt.archiveSha256,
      objectVersionId: receipt.objectVersionId,
      targetDatabase: receipt.targetDatabase,
      restoredDirectory: output,
      next: "Run qm backup prepare-cutover and obtain explicit approval before changing public routing.",
    });
  } finally {
    store.close();
  }
}

main().catch(() => {
  process.stderr.write("Recovery command failed. No production target was changed.\n");
  process.exitCode = 1;
});
