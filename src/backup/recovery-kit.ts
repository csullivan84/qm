import { identityToRecipient } from "age-encryption";
import { z } from "zod";
import { decryptRecoveryKit, encryptRecoveryKit, recipientFingerprint } from "./age.ts";

const kitSchema = z
  .object({
    format: z.literal("qm-recovery-kit/v1"),
    issuedAt: z.number().int().nonnegative(),
    organizationId: z.string().min(1).max(256),
    deploymentId: z.string().min(1).max(128),
    destination: z
      .object({
        endpoint: z.string().url(),
        region: z.string().min(1).max(100),
        bucket: z.string().min(1).max(63),
        prefix: z.string().max(1000),
        keyId: z.string().min(1).max(1000),
        applicationKey: z.string().min(1).max(4000),
      })
      .strict(),
    offlineIdentity: z.string().startsWith("AGE-SECRET-KEY-"),
    offlineRecipient: z.string().startsWith("age1"),
    fingerprint: z.string().startsWith("age-sha256:"),
    sourceCommit: z.string().min(1).max(128),
    recoveryImage: z.string().min(1).max(1000),
    compatibility: z
      .object({ format: z.literal(1), minimumCliVersion: z.string(), maximumCliMajor: z.number().int() })
      .strict(),
    commands: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();

export type RecoveryKit = z.infer<typeof kitSchema>;

export async function createRecoveryKit(input: {
  passphrase: string;
  offlineIdentity: string;
  offlineRecipient: string;
  organizationId: string;
  deploymentId: string;
  destination: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    keyId: string;
    applicationKey: string;
  };
  sourceCommit: string;
  recoveryImage: string;
  issuedAt?: number;
}): Promise<{ bytes: Uint8Array; fingerprint: string }> {
  const derived = await identityToRecipient(input.offlineIdentity);
  if (derived !== input.offlineRecipient) throw new Error("offline recovery identity does not match its recipient");
  const fingerprint = recipientFingerprint(input.offlineRecipient);
  const kit = kitSchema.parse({
    format: "qm-recovery-kit/v1",
    issuedAt: input.issuedAt ?? Date.now(),
    organizationId: input.organizationId,
    deploymentId: input.deploymentId,
    destination: input.destination,
    offlineIdentity: input.offlineIdentity,
    offlineRecipient: input.offlineRecipient,
    fingerprint,
    sourceCommit: input.sourceCommit,
    recoveryImage: input.recoveryImage,
    compatibility: { format: 1, minimumCliVersion: "0.1.0", maximumCliMajor: 1 },
    commands: [
      "qm backup kit inspect --kit-file <path>",
      "qm backup list --kit-file <path>",
      "qm backup verify <recovery-point> --kit-file <path>",
      "qm backup restore <recovery-point> --kit-file <path> --target-database-url-file <path> --output-dir <empty-directory>",
      "qm backup prepare-cutover <restored-deployment> --kit-file <path>",
    ],
  });
  return { bytes: await encryptRecoveryKit(Buffer.from(JSON.stringify(kit)), input.passphrase), fingerprint };
}

export async function inspectRecoveryKit(
  bytes: Uint8Array,
  passphrase: string,
): Promise<{
  public: {
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
  };
  secret: RecoveryKit;
}> {
  const plaintext = await decryptRecoveryKit(bytes, passphrase);
  const kit = kitSchema.parse(JSON.parse(Buffer.from(plaintext).toString("utf8")));
  return {
    public: {
      format: kit.format,
      issuedAt: kit.issuedAt,
      organizationId: kit.organizationId,
      deploymentId: kit.deploymentId,
      endpoint: kit.destination.endpoint,
      region: kit.destination.region,
      bucket: kit.destination.bucket,
      prefix: kit.destination.prefix,
      fingerprint: kit.fingerprint,
      sourceCommit: kit.sourceCommit,
      recoveryImage: kit.recoveryImage,
      commands: kit.commands,
    },
    secret: kit,
  };
}
