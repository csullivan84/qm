import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Encrypter } from "age-encryption";
import * as tar from "tar-stream";

function safeArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("recovery input archive path is unsafe");
  }
  return normalized;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

interface AllowlistedRoot {
  path: string;
  realPath: string;
}

interface WalkedFile {
  path: string;
  relativePath: string;
  size: number;
  device: bigint;
  inode: bigint;
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new Error(`recovery input escapes its allowlisted root: ${target}`);
  const suffix = relative(root, target);
  if (!suffix) return;
  let current = root;
  for (const segment of suffix.split(sep)) {
    current = resolve(current, segment);
    if ((await lstat(current, { bigint: true })).isSymbolicLink()) {
      throw new Error(`recovery input has a symlink path component: ${current}`);
    }
  }
}

function safeFileSize(size: bigint, path: string): number {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`recovery input is too large to capture safely: ${path}`);
  return Number(size);
}

async function walk(source: string, root: string): Promise<WalkedFile[]> {
  await assertNoSymlinkPath(root, source);
  const sourceStat = await lstat(source, { bigint: true });
  if (sourceStat.isSymbolicLink()) throw new Error(`recovery input is a symlink: ${source}`);
  if (sourceStat.isFile()) {
    return [
      {
        path: source,
        relativePath: "",
        size: safeFileSize(sourceStat.size, source),
        device: sourceStat.dev,
        inode: sourceStat.ino,
      },
    ];
  }
  if (!sourceStat.isDirectory()) throw new Error(`recovery input is not a regular file or directory: ${source}`);
  const files: WalkedFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    await assertNoSymlinkPath(root, directory);
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error(`recovery input is a symlink: ${path}`);
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile())
        files.push({
          path,
          relativePath: relative(source, path),
          size: safeFileSize(metadata.size, path),
          device: metadata.dev,
          inode: metadata.ino,
        });
      else throw new Error(`recovery input has an unsupported file type: ${path}`);
    }
  };
  await visit(source);
  return files;
}

async function descriptorRealPath(handle: FileHandle): Promise<string> {
  if (process.platform !== "linux") throw new Error("descriptor path verification requires Linux");
  return realpath(`/proc/self/fd/${handle.fd}`);
}

async function openVerifiedFile(
  path: string,
  expectedSize: number,
  expectedDevice: bigint,
  expectedInode: bigint,
  allowedRoot: string,
  resolveDescriptorPath: (handle: FileHandle) => Promise<string>,
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [opened, openedRealPath] = await Promise.all([handle.stat({ bigint: true }), resolveDescriptorPath(handle)]);
    if (
      !opened.isFile() ||
      opened.size !== BigInt(expectedSize) ||
      opened.dev !== expectedDevice ||
      opened.ino !== expectedInode ||
      !inside(allowedRoot, openedRealPath)
    ) {
      throw new Error(`recovery input changed during capture: ${path}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function encryptReadableToFile(
  source: Readable,
  recipients: string[],
  outputPath: string,
): Promise<{ sizeBytes: number }> {
  if (!recipients.length || new Set(recipients).size !== recipients.length) {
    throw new Error("backup encryption requires unique recipients");
  }
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  try {
    const encrypted = await encrypter.encrypt(
      Readable.toWeb(source, {
        strategy: { highWaterMark: source.readableHighWaterMark, size: (chunk) => chunk.length },
      }) as ReadableStream<Uint8Array>,
    );
    await pipeline(Readable.fromWeb(encrypted), createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    return { sizeBytes: (await stat(outputPath)).size };
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

export async function createEncryptedAllowlistedTar(input: {
  inputs: Array<{ source: string; archiveRoot: string }>;
  allowedRoots: string[];
  recipients: string[];
  outputPath: string;
  maxEntries?: number;
  maxBytes?: number;
  resolveDescriptorPath?: (handle: FileHandle) => Promise<string>;
  beforeFileOpen?: (path: string) => Promise<void>;
}): Promise<{ sizeBytes: number; entryCount: number; plaintextBytes: number; entries: string[] }> {
  const allowedRoots: AllowlistedRoot[] = await Promise.all(
    input.allowedRoots.map(async (root) => {
      const path = resolve(root);
      return { path, realPath: await realpath(path) };
    }),
  );
  const collected: Array<WalkedFile & { archivePath: string; allowedRootPath: string; allowedRootRealPath: string }> =
    [];
  const names = new Set<string>();
  let plaintextBytes = 0;
  for (const item of input.inputs) {
    const source = resolve(item.source);
    const sourceRealPath = await realpath(source);
    const allowedRoot = allowedRoots.find((root) => inside(root.path, source) && inside(root.realPath, sourceRealPath));
    if (!allowedRoot) {
      throw new Error(`recovery input escapes its allowlisted roots: ${source}`);
    }
    await assertNoSymlinkPath(allowedRoot.path, source);
    const metadata = await lstat(source, { bigint: true });
    if (metadata.isSymbolicLink()) throw new Error(`recovery input is a symlink: ${source}`);
    const files = await walk(source, allowedRoot.path);
    for (const file of files) {
      const fileRealPath = await realpath(file.path);
      if (!inside(allowedRoot.realPath, fileRealPath)) {
        throw new Error(`recovery input escapes its allowlisted roots: ${file.path}`);
      }
      const archivePath = safeArchivePath(
        file.relativePath ? `${item.archiveRoot}/${file.relativePath.split(sep).join("/")}` : item.archiveRoot,
      );
      if (names.has(archivePath)) throw new Error(`duplicate recovery input archive path: ${archivePath}`);
      names.add(archivePath);
      plaintextBytes += file.size;
      if (collected.length + 1 > (input.maxEntries ?? 10_000))
        throw new Error("recovery input entry count exceeds its limit");
      if (plaintextBytes > (input.maxBytes ?? 10 * 1024 * 1024 * 1024)) {
        throw new Error("recovery input byte count exceeds its limit");
      }
      collected.push({
        ...file,
        archivePath,
        allowedRootPath: allowedRoot.path,
        allowedRootRealPath: allowedRoot.realPath,
      });
    }
  }
  collected.sort((first, second) => first.archivePath.localeCompare(second.archivePath));
  const pack = tar.pack();
  const encrypted = encryptReadableToFile(pack, input.recipients, input.outputPath);
  void encrypted.catch(() => undefined);
  try {
    for (const file of collected) {
      await input.beforeFileOpen?.(file.path);
      await assertNoSymlinkPath(file.allowedRootPath, file.path);
      const handle = await openVerifiedFile(
        file.path,
        file.size,
        file.device,
        file.inode,
        file.allowedRootRealPath,
        input.resolveDescriptorPath ?? descriptorRealPath,
      );
      try {
        const entry = pack.entry({
          name: file.archivePath,
          type: "file",
          size: file.size,
          mode: 0o600,
          mtime: new Date(0),
          uid: 0,
          gid: 0,
        });
        await pipeline(handle.createReadStream({ autoClose: false }), entry);
      } finally {
        await handle.close();
      }
    }
    pack.finalize();
    const result = await encrypted;
    return {
      ...result,
      entryCount: collected.length,
      plaintextBytes,
      entries: collected.map((file) => file.archivePath),
    };
  } catch (error) {
    pack.destroy(error as Error);
    await encrypted.catch(() => undefined);
    throw error;
  }
}

function postgresEnvironment(databaseUrl: string, environment: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("database URL must use PostgreSQL");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) throw new Error("database URL is incomplete");
  const sslmode = url.searchParams.get("sslmode");
  return {
    ...environment,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
  };
}

export async function captureEncryptedDatabase(input: {
  databaseUrl: string;
  recipients: string[];
  outputPath: string;
  snapshotId?: string;
  pgDumpBin?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ sizeBytes: number }> {
  if (input.snapshotId && !/^[0-9a-f]+-[0-9a-f]+-[0-9]+$/i.test(input.snapshotId)) {
    throw new Error("PostgreSQL snapshot identifier is invalid");
  }
  const args = ["--format=custom", "--compress=zstd:6", "--no-owner", "--no-privileges"];
  if (input.snapshotId) args.push(`--snapshot=${input.snapshotId}`);
  const process = spawn(input.pgDumpBin ?? "pg_dump", args, {
    env: postgresEnvironment(input.databaseUrl, input.environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  process.stderr.on("data", (chunk) => {
    if (stderrBytes >= 64 * 1024) return;
    const bounded = Buffer.from(chunk).subarray(0, 64 * 1024 - stderrBytes);
    stderr.push(bounded);
    stderrBytes += bounded.length;
  });
  const exited = new Promise<void>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump failed with ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}`));
    });
  });
  try {
    const [encrypted] = await Promise.all([
      encryptReadableToFile(process.stdout, input.recipients, input.outputPath),
      exited,
    ]);
    return encrypted;
  } catch (error) {
    process.kill("SIGKILL");
    await unlink(input.outputPath).catch(() => undefined);
    throw error;
  } finally {
    for (const chunk of stderr) chunk.fill(0);
  }
}
