import { LocalAuthError } from "../../auth/local-auth.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

function localAuth(ctx: ApiCtx) {
  const service = ctx.deps.localAuth;
  if (!service?.durable) {
    sendJson(ctx.res, 503, {
      error: "not_configured",
      message: "local authentication requires the Postgres-backed account store",
    });
    return null;
  }
  return service;
}

function stringField(body: unknown, name: string, max: number): string {
  const value = isObj(body) ? body[name] : undefined;
  return typeof value === "string" && value.length <= max ? value : "";
}

function localAuthFailure(ctx: ApiCtx, error: unknown): void {
  if (error instanceof LocalAuthError) {
    sendJson(ctx.res, error.status, { error: "local_auth_failed", message: error.message });
    return;
  }
  throw error;
}

async function login(ctx: ApiCtx): Promise<void> {
  const service = localAuth(ctx);
  if (!service) return;
  const username = stringField(ctx.body, "username", 128);
  const password = stringField(ctx.body, "password", 512);
  if (!username || !password) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "username and password are required" });
  }
  const authenticated = await service.authenticate(username, password);
  if (!authenticated) {
    return sendJson(ctx.res, 401, { error: "invalid_credentials", message: "invalid username or password" });
  }
  return sendJson(ctx.res, 200, {
    token: authenticated.token,
    username: authenticated.session.username,
    expiresAt: authenticated.session.expiresAt,
  });
}

async function session(ctx: ApiCtx): Promise<void> {
  const service = localAuth(ctx);
  if (!service) return;
  const token = stringField(ctx.body, "token", 256);
  if (!token) return sendJson(ctx.res, 401, { error: "invalid_session" });
  const resolved = await service.resolveSession(token);
  if (!resolved) return sendJson(ctx.res, 401, { error: "invalid_session" });
  return sendJson(ctx.res, 200, { username: resolved.username, expiresAt: resolved.expiresAt });
}

async function logout(ctx: ApiCtx): Promise<void> {
  const service = localAuth(ctx);
  if (!service) return;
  const token = stringField(ctx.body, "token", 256);
  if (token) await service.revokeSession(token);
  return sendJson(ctx.res, 200, { ok: true });
}

async function setup(ctx: ApiCtx): Promise<void> {
  const service = localAuth(ctx);
  if (!service) return;
  const setupCode = stringField(ctx.body, "setupCode", 256);
  const password = stringField(ctx.body, "password", 512);
  if (!setupCode || !password) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "setup code and password are required" });
  }
  try {
    const completed = await service.completePasswordReset(setupCode, password);
    return sendJson(ctx.res, 200, {
      token: completed.token,
      username: completed.session.username,
      expiresAt: completed.session.expiresAt,
    });
  } catch (error) {
    return localAuthFailure(ctx, error);
  }
}

export const localAuthRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/local/login", auth: "source", handle: login },
  { method: "POST", path: "/v1/auth/local/session", auth: "source", handle: session },
  { method: "POST", path: "/v1/auth/local/logout", auth: "source", handle: logout },
  { method: "POST", path: "/v1/auth/local/setup", auth: "source", handle: setup },
];
