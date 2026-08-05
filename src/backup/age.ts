import { createHash } from "node:crypto";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";

export function recipientFingerprint(recipient: string): string {
  return `age-sha256:${createHash("sha256").update(recipient.trim()).digest("hex")}`;
}

export async function generateRecoveryIdentity(): Promise<{
  identity: string;
  recipient: string;
  fingerprint: string;
}> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient, fingerprint: recipientFingerprint(recipient) };
}

export async function encryptAge(bytes: Uint8Array, recipients: string[]): Promise<Uint8Array> {
  if (recipients.length < 1 || new Set(recipients).size !== recipients.length) {
    throw new Error("age encryption requires one or more unique recipients");
  }
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return encrypter.encrypt(bytes);
}

export async function decryptAge(bytes: Uint8Array, identity: string): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(bytes);
}

function strongPassphrase(passphrase: string): string {
  if (passphrase.length < 16 || passphrase.length > 1024) {
    throw new Error("recovery-kit passphrase must contain between 16 and 1024 characters");
  }
  return passphrase;
}

export async function encryptRecoveryKit(bytes: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(strongPassphrase(passphrase));
  return encrypter.encrypt(bytes);
}

export async function decryptRecoveryKit(bytes: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(strongPassphrase(passphrase));
  return decrypter.decrypt(bytes);
}
