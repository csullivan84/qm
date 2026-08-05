import { inspectBackupArchive, type BackupManifest } from "./archive.ts";
import { createIsolatedRestoreDatabase, restoreEncryptedDatabase, verifyRestoredDatabase } from "./restore.ts";

export interface RestoreVerificationProof {
  downloadVerified: boolean;
  checksumVerified: boolean;
  decrypted: boolean;
  restored: boolean;
  invariants: {
    postgresServerVersionNum: number;
    postgresVersion: boolean;
    schema: boolean;
    rowBounds: boolean;
    timestamps: boolean;
    organization: boolean;
    applicationHealth: boolean;
  };
  cleanup: boolean;
  durationMs: number;
}

export class RestoreVerificationFailure extends Error {
  readonly code: string;
  readonly cleanup: boolean;

  constructor(code: string, cleanup: boolean) {
    super(code);
    this.code = code;
    this.cleanup = cleanup;
  }
}

export async function verifyBackupRestore(input: {
  archive: Uint8Array;
  expectedArchiveSha256?: string;
  identity: string;
  restoreAdminDatabaseUrl: string;
  environment?: NodeJS.ProcessEnv;
  expectedManifest?: BackupManifest;
  now?: () => number;
}): Promise<RestoreVerificationProof> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const inspected = await inspectBackupArchive(input.archive);
  if (input.expectedArchiveSha256 && inspected.archiveSha256 !== input.expectedArchiveSha256) {
    throw new RestoreVerificationFailure("archive_checksum_mismatch", true);
  }
  if (input.expectedManifest && input.expectedManifest.jobId !== inspected.manifest.jobId) {
    throw new RestoreVerificationFailure("archive_manifest_mismatch", true);
  }
  const target = await createIsolatedRestoreDatabase({ adminDatabaseUrl: input.restoreAdminDatabaseUrl });
  let cleanup: boolean;
  try {
    await restoreEncryptedDatabase({
      encrypted: inspected.entries.get("database.dump.age")!,
      identity: input.identity,
      targetDatabaseUrl: target.databaseUrl,
      environment: input.environment,
    });
    const invariants = await verifyRestoredDatabase({
      databaseUrl: target.databaseUrl,
      expected: inspected.manifest.expectedDatabaseInvariants,
    });
    if (!Object.values(invariants).every(Boolean)) {
      throw new RestoreVerificationFailure("restore_invariants_failed", false);
    }
    cleanup = await target.cleanup();
    return {
      downloadVerified: true,
      checksumVerified: true,
      decrypted: true,
      restored: true,
      invariants,
      cleanup,
      durationMs: now() - startedAt,
    };
  } catch (error) {
    try {
      cleanup = await target.cleanup();
    } catch {
      cleanup = false;
    }
    if (error instanceof RestoreVerificationFailure) {
      throw new RestoreVerificationFailure(error.code, cleanup);
    }
    throw new RestoreVerificationFailure("restore_verification_failed", cleanup);
  }
}
