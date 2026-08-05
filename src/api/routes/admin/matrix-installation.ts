import { join, resolve } from "node:path";
import { matrixPluginConfigFromEnv } from "../../../matrix/config.ts";
import { validateMatrixInstallation } from "../../../surfaces/matrix-installation.ts";
import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

function boolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
  return value;
}

function number(value: unknown, key: string): number {
  if (typeof value !== "number") throw new Error(`${key} must be a number`);
  return value;
}

function installationEnv(body: Record<string, unknown>, accessToken: string, syncCursorPath: string) {
  const attachments = body.attachments;
  if (!attachments || typeof attachments !== "object" || Array.isArray(attachments)) {
    throw new Error("attachments must be an object");
  }
  const filePolicy = attachments as Record<string, unknown>;
  const principalMap = body.principalMap;
  if (!principalMap || typeof principalMap !== "object" || Array.isArray(principalMap)) {
    throw new Error("principalMap must be an object");
  }
  return {
    MATRIX_HOMESERVER_URL: typeof body.homeserverUrl === "string" ? body.homeserverUrl : "",
    MATRIX_ACCESS_TOKEN: accessToken,
    MATRIX_ALLOWED_ROOM_IDS: stringArray(body.allowedRoomIds, "allowedRoomIds").join(","),
    MATRIX_ALLOWED_USER_IDS: stringArray(body.allowedUserIds, "allowedUserIds").join(","),
    MATRIX_PRINCIPAL_MAP_JSON: JSON.stringify(principalMap),
    MATRIX_SYNC_TIMEOUT_MS: String(number(body.syncTimeoutMs, "syncTimeoutMs")),
    MATRIX_SYNC_CURSOR_PATH: syncCursorPath,
    MATRIX_DELIVERY_MODE: typeof body.deliveryMode === "string" ? body.deliveryMode : "",
    MATRIX_FORMATTED_MESSAGES: String(boolean(body.formattedMessages, "formattedMessages")),
    MATRIX_FOLLOW_THREADS: String(boolean(body.followThreads, "followThreads")),
    MATRIX_REACTIONS: String(boolean(body.reactions, "reactions")),
    MATRIX_ATTACHMENTS_ENABLED: String(boolean(filePolicy.enabled, "attachments.enabled")),
    MATRIX_ATTACHMENT_MAX_COUNT: String(number(filePolicy.maxCount, "attachments.maxCount")),
    MATRIX_ATTACHMENT_MAX_BYTES: String(number(filePolicy.maxBytes, "attachments.maxBytes")),
    MATRIX_ATTACHMENT_MIME_TYPES: stringArray(filePolicy.allowedMimeTypes, "attachments.allowedMimeTypes").join(","),
    MATRIX_MEDIA_SERVER_NAMES: stringArray(
      filePolicy.allowedMediaServerNames,
      "attachments.allowedMediaServerNames",
    ).join(","),
    MATRIX_APPROVAL_MODES: stringArray(body.approvalModes, "approvalModes").join(","),
  };
}

export async function getMatrixInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.matrixInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "matrix-installation.read",
    resource: "matrix-installation",
    scopeLabel: scope,
  });
  const managementAvailable = ctx.deps.matrixInstallationDurable === true;
  const stored = await ctx.deps.matrixInstallation.status();
  if (stored.managed) {
    return sendJson(ctx.res, 200, {
      ...stored,
      source: "admin",
      managementAvailable,
      tokenRequired: !stored.configured,
    });
  }
  if (ctx.deps.matrixEnvironmentState === "configured") {
    return sendJson(ctx.res, 200, {
      configured: true,
      managed: false,
      source: "environment",
      managementAvailable,
      tokenRequired: true,
    });
  }
  return sendJson(ctx.res, 200, {
    configured: false,
    managed: false,
    source: ctx.deps.matrixEnvironmentState === "partial" ? "invalid_environment" : "none",
    managementAvailable,
    tokenRequired: true,
  });
}

export async function putMatrixInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.matrixInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  if (ctx.deps.matrixInstallationDurable !== true) {
    return sendJson(ctx.res, 503, {
      error: "durable_storage_required",
      message: "PostgreSQL durable storage is required for Admin-managed Matrix credentials",
    });
  }
  try {
    const body = ctx.body as Record<string, unknown>;
    const current = await ctx.deps.matrixInstallation.get();
    const submittedToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    const accessToken = submittedToken || current?.accessToken || "";
    if (!accessToken) throw new Error("accessToken is required for a new Matrix installation");
    const cursorPath =
      current?.syncCursorPath ?? ctx.deps.matrixSyncCursorPath ?? resolve(join("./data", "matrix-sync-cursor"));
    const config = matrixPluginConfigFromEnv(installationEnv(body, accessToken, cursorPath));
    if (!config) throw new Error("Matrix configuration is required");
    const identity = await validateMatrixInstallation(config, ctx.deps.matrixInstallationFetch);
    const status = await ctx.deps.matrixInstallation.set({ config, ...identity, updatedBy: actor.id });
    audit(ctx.deps, {
      principalId: actor.id,
      action: "matrix-installation.update",
      resource: "matrix-installation",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, { ...status, source: "admin" });
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_matrix_installation", message: errMessage(error) });
  }
}

export async function deleteMatrixInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.matrixInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  if (ctx.deps.matrixInstallationDurable !== true) {
    return sendJson(ctx.res, 503, {
      error: "durable_storage_required",
      message: "PostgreSQL durable storage is required for Admin-managed Matrix credentials",
    });
  }
  await ctx.deps.matrixInstallation.delete(actor.id);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "matrix-installation.delete",
    resource: "matrix-installation",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, { configured: false, managed: true, source: "admin" });
}
