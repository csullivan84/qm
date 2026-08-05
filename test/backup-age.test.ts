import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptAge,
  decryptRecoveryKit,
  encryptAge,
  encryptRecoveryKit,
  generateRecoveryIdentity,
  recipientFingerprint,
} from "../src/backup/age.ts";

test("backup components encrypt to independent operational and offline age recipients", async () => {
  const operational = await generateRecoveryIdentity();
  const offline = await generateRecoveryIdentity();
  const ciphertext = await encryptAge(Buffer.from("database bytes"), [operational.recipient, offline.recipient]);

  assert.notEqual(Buffer.from(ciphertext).includes(Buffer.from("database bytes")), true);
  assert.equal(Buffer.from(await decryptAge(ciphertext, operational.identity)).toString(), "database bytes");
  assert.equal(Buffer.from(await decryptAge(ciphertext, offline.identity)).toString(), "database bytes");
  assert.equal(recipientFingerprint(offline.recipient), offline.fingerprint);
});

test("recovery kits are age-encrypted with a strong passphrase and reject the wrong passphrase", async () => {
  const kit = Buffer.from(JSON.stringify({ format: "qm-recovery-kit/v1", secret: "never plaintext" }));
  const encrypted = await encryptRecoveryKit(kit, "correct horse battery staple");
  assert.equal(Buffer.from(encrypted).includes(Buffer.from("never plaintext")), false);
  assert.equal(
    Buffer.from(await decryptRecoveryKit(encrypted, "correct horse battery staple")).toString(),
    kit.toString(),
  );
  await assert.rejects(decryptRecoveryKit(encrypted, "wrong passphrase here"));
  await assert.rejects(encryptRecoveryKit(kit, "short"), /passphrase/);
});
