import type { BackupConfigurationInput } from "../../../backup/config-store.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

function exact(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`unknown field: ${unknown[0]}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function configInput(value: unknown): BackupConfigurationInput {
  const body = bodyObject(value);
  exact(body, [
    "enabled",
    "deploymentId",
    "endpoint",
    "bucket",
    "prefix",
    "keyId",
    "applicationKey",
    "operationalRecipient",
    "scheduleIntervalMinutes",
    "retention",
    "objectLock",
  ]);
  const retention = bodyObject(body.retention);
  exact(retention, ["hourlyDays", "dailyDays", "monthlyDays", "predeployDays", "manualDays"]);
  const objectLock = bodyObject(body.objectLock);
  exact(objectLock, ["required", "mode", "minimumDays"]);
  if (objectLock.mode !== "GOVERNANCE") throw new Error("objectLock.mode must be GOVERNANCE");
  return {
    enabled: bool(body.enabled, "enabled"),
    deploymentId: text(body.deploymentId, "deploymentId"),
    endpoint: text(body.endpoint, "endpoint"),
    bucket: text(body.bucket, "bucket"),
    prefix: text(body.prefix, "prefix"),
    keyId: text(body.keyId, "keyId"),
    applicationKey: text(body.applicationKey, "applicationKey"),
    operationalRecipient: text(body.operationalRecipient, "operationalRecipient"),
    scheduleIntervalMinutes: integer(body.scheduleIntervalMinutes, "scheduleIntervalMinutes"),
    retention: {
      hourlyDays: integer(retention.hourlyDays, "retention.hourlyDays"),
      dailyDays: integer(retention.dailyDays, "retention.dailyDays"),
      monthlyDays: integer(retention.monthlyDays, "retention.monthlyDays"),
      predeployDays: integer(retention.predeployDays, "retention.predeployDays"),
      manualDays: integer(retention.manualDays, "retention.manualDays"),
    },
    objectLock: {
      required: bool(objectLock.required, "objectLock.required"),
      mode: "GOVERNANCE",
      minimumDays: integer(objectLock.minimumDays, "objectLock.minimumDays"),
    },
  };
}

async function admin(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  return actor ? { actor, scope } : null;
}

function service(ctx: ApiCtx) {
  if (!ctx.deps.backup) {
    sendJson(ctx.res, 404, { error: "backup_not_available" });
    return null;
  }
  return ctx.deps.backup;
}

function durable(ctx: ApiCtx): boolean {
  if (ctx.deps.backupManagementDurable === true) return true;
  sendJson(ctx.res, 503, {
    error: "durable_storage_required",
    message: "PostgreSQL durable storage is required for Recovery management",
  });
  return false;
}

function idempotencyKey(ctx: ApiCtx): string {
  const value = ctx.req.headers["idempotency-key"];
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error("Idempotency-Key header is required");
  }
  return value.trim();
}

function invalid(ctx: ApiCtx, code: string): void {
  sendJson(ctx.res, 400, { error: code, message: "Recovery request could not be validated" });
}

export async function getBackupStatus(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, {
    ...(await backup.status()),
    managementAvailable: ctx.deps.backupManagementDurable === true,
  });
}

export async function getBackupConfig(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, {
    configuration: await backup.configuration(),
    managementAvailable: ctx.deps.backupManagementDurable === true,
  });
}

export async function putBackupConfig(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    const status = await backup.configure(configInput(ctx.body), authorized.actor.id);
    audit(ctx.deps, {
      principalId: authorized.actor.id,
      action: "backup.config.update",
      resource: "backup-config",
      scopeLabel: authorized.scope,
    });
    return sendJson(ctx.res, 200, status);
  } catch {
    return invalid(ctx, "invalid_backup_configuration");
  }
}

export async function deleteBackupConfig(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  await backup.remove(authorized.actor.id);
  return sendJson(ctx.res, 200, { configured: false });
}

export async function testBackupDestination(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    const body = bodyObject(ctx.body);
    exact(body, ["configuration"]);
    const report = await backup.testDestination(
      body.configuration === undefined ? undefined : configInput(body.configuration),
      authorized.actor.id,
    );
    return sendJson(ctx.res, 200, report);
  } catch {
    return invalid(ctx, "backup_destination_test_failed");
  }
}

export async function issueBackupRecoveryKit(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    const body = bodyObject(ctx.body);
    exact(body, ["passphrase"]);
    const created = await backup.issueRecoveryKit(text(body.passphrase, "passphrase"), authorized.actor.id);
    ctx.res.writeHead(200, {
      "content-type": "application/vnd.qm.recovery-kit+age",
      "content-disposition": 'attachment; filename="qm-recovery-kit.age"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-qm-recovery-kit-fingerprint": created.fingerprint,
      "content-length": created.bytes.length,
    });
    ctx.res.end(Buffer.from(created.bytes));
  } catch {
    return invalid(ctx, "recovery_kit_issue_failed");
  }
}

export async function acknowledgeBackupRecoveryKit(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    const body = bodyObject(ctx.body);
    exact(body, ["fingerprint"]);
    return sendJson(
      ctx.res,
      200,
      await backup.acknowledgeRecoveryKit(text(body.fingerprint, "fingerprint"), authorized.actor.id),
    );
  } catch {
    return invalid(ctx, "recovery_kit_acknowledgement_failed");
  }
}

export async function listBackupRuns(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, { runs: await backup.runs() });
}

export async function getBackupRun(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  const run = await backup.run(ctx.params.id!);
  return run ? sendJson(ctx.res, 200, run) : sendJson(ctx.res, 404, { error: "backup_run_not_found" });
}

export async function requestBackupRun(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    const body = bodyObject(ctx.body);
    exact(body, ["purpose"]);
    if (body.purpose !== "manual" && body.purpose !== "predeploy") throw new Error("purpose is invalid");
    return sendJson(
      ctx.res,
      202,
      await backup.requestRun({ purpose: body.purpose, idempotencyKey: idempotencyKey(ctx) }, authorized.actor.id),
    );
  } catch {
    return invalid(ctx, "backup_run_request_failed");
  }
}

export async function retryBackupRun(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    idempotencyKey(ctx);
    return sendJson(ctx.res, 202, await backup.retryRun(ctx.params.id!, authorized.actor.id));
  } catch {
    return invalid(ctx, "backup_run_retry_failed");
  }
}

export async function listRecoveryPoints(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, { recoveryPoints: await backup.recoveryPoints() });
}

export async function listRestoreDrills(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, { restoreDrills: await backup.restoreDrills() });
}

export async function requestRestoreDrill(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    return sendJson(
      ctx.res,
      202,
      await backup.requestRestoreDrill(ctx.params.id!, idempotencyKey(ctx), authorized.actor.id),
    );
  } catch {
    return invalid(ctx, "restore_drill_request_failed");
  }
}

export async function suspendBackups(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, await backup.suspend(authorized.actor.id));
}

export async function resumeBackups(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, await backup.resume(authorized.actor.id));
}

export async function prepareBackupRecovery(ctx: ApiCtx): Promise<void> {
  const authorized = await admin(ctx);
  if (!authorized || !durable(ctx)) return;
  const backup = service(ctx);
  if (!backup) return;
  try {
    idempotencyKey(ctx);
    return sendJson(ctx.res, 200, await backup.prepareRecovery(ctx.params.id!, authorized.actor.id));
  } catch {
    return invalid(ctx, "recovery_prepare_failed");
  }
}

export async function listBackupAudit(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx))) return;
  const backup = service(ctx);
  if (!backup) return;
  return sendJson(ctx.res, 200, { events: await backup.auditEvents() });
}
