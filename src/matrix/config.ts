import { join, resolve } from "node:path";

const MATRIX_ENV_KEYS = [
  "MATRIX_HOMESERVER_URL",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_ALLOWED_ROOM_IDS",
  "MATRIX_ALLOWED_USER_IDS",
  "MATRIX_PRINCIPAL_MAP_JSON",
  "MATRIX_SYNC_TIMEOUT_MS",
  "MATRIX_SYNC_CURSOR_PATH",
  "MATRIX_DELIVERY_MODE",
  "MATRIX_FORMATTED_MESSAGES",
  "MATRIX_FOLLOW_THREADS",
  "MATRIX_REACTIONS",
  "MATRIX_ATTACHMENTS_ENABLED",
  "MATRIX_ATTACHMENT_MAX_COUNT",
  "MATRIX_ATTACHMENT_MAX_BYTES",
  "MATRIX_ATTACHMENT_MIME_TYPES",
  "MATRIX_MEDIA_SERVER_NAMES",
  "MATRIX_APPROVAL_MODES",
] as const;

const DEFAULT_MIME_TYPES = [
  "application/json",
  "application/pdf",
  "application/zip",
  "audio/mpeg",
  "audio/ogg",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
];

export type MatrixApprovalMode = "once" | "session" | "always" | "deny";
export type MatrixDeliveryMode = "edits" | "final";

export interface MatrixAttachmentPolicy {
  enabled: boolean;
  maxCount: number;
  maxBytes: number;
  allowedMimeTypes: string[];
  allowedMediaServerNames: string[];
}

export interface MatrixPluginConfig {
  homeserverUrl: string;
  accessToken: string;
  allowedRoomIds: string[];
  allowedUserIds: string[];
  principalMap: Record<string, string>;
  syncTimeoutMs: number;
  syncCursorPath: string;
  deliveryMode: MatrixDeliveryMode;
  formattedMessages: boolean;
  followThreads: boolean;
  reactions: boolean;
  attachments: MatrixAttachmentPolicy;
  approvalModes: MatrixApprovalMode[];
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required when Matrix is configured`);
  return value;
}

function idList(raw: string, key: string, prefix: string): string[] {
  const values = uniqueList(raw);
  if (!values.length) throw new Error(`${key} must contain at least one value`);
  if (values.some((value) => !value.startsWith(prefix))) {
    throw new Error(`${key} contains an invalid Matrix identifier`);
  }
  return values;
}

function uniqueList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function homeserverUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MATRIX_HOMESERVER_URL must be an http or https URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MATRIX_HOMESERVER_URL must be an http or https URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MATRIX_HOMESERVER_URL must not contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function principalMap(raw: string | undefined, allowedUserIds: string[]): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MATRIX_PRINCIPAL_MAP_JSON must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MATRIX_PRINCIPAL_MAP_JSON must be a JSON object");
  }
  const allowed = new Set(allowedUserIds);
  const entries = Object.entries(parsed);
  for (const [userId, principalId] of entries) {
    if (!allowed.has(userId) || typeof principalId !== "string" || !principalId.trim()) {
      throw new Error("every Matrix principal mapping must map an allowed user to a non-empty principal id");
    }
  }
  return Object.fromEntries(entries.map(([userId, principalId]) => [userId, (principalId as string).trim()]));
}

function integer(raw: string | undefined, key: string, fallback: number, minimum: number, maximum: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function enabled(raw: string | undefined, key: string, fallback: boolean): boolean {
  if (!raw?.trim()) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be true or false`);
}

function syncCursorPath(env: Record<string, string | undefined>): string {
  const configured = env.MATRIX_SYNC_CURSOR_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(join(env.DATA_DIR?.trim() || "./data", "matrix-sync-cursor"));
}

function matrixServerName(id: string): string | null {
  const separator = id.indexOf(":");
  return separator >= 0 && separator < id.length - 1 ? id.slice(separator + 1) : null;
}

function mediaServerNames(
  raw: string | undefined,
  normalizedHomeserverUrl: string,
  allowedRoomIds: string[],
  allowedUserIds: string[],
): string[] {
  const values = raw?.trim()
    ? uniqueList(raw)
    : [
        new URL(normalizedHomeserverUrl).host,
        ...[...allowedRoomIds, ...allowedUserIds]
          .map(matrixServerName)
          .filter((value): value is string => Boolean(value)),
      ];
  const unique = [...new Set(values.map((value) => value.toLowerCase()))];
  if (
    !unique.length ||
    unique.some(
      (value) =>
        value.length > 255 || !value.trim() || /[\s/@?#]/.test(value) || value.startsWith(".") || value.endsWith("."),
    )
  ) {
    throw new Error("MATRIX_MEDIA_SERVER_NAMES contains an invalid Matrix server name");
  }
  return unique;
}

function mimeTypes(raw: string | undefined): string[] {
  const values = raw?.trim() ? uniqueList(raw).map((value) => value.toLowerCase()) : DEFAULT_MIME_TYPES;
  if (!values.length || values.some((value) => !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value))) {
    throw new Error("MATRIX_ATTACHMENT_MIME_TYPES must contain exact MIME types");
  }
  return [...new Set(values)];
}

function approvalModes(raw: string | undefined): MatrixApprovalMode[] {
  if (!raw?.trim()) return [];
  const values = uniqueList(raw);
  const allowed = new Set<MatrixApprovalMode>(["once", "session", "always", "deny"]);
  if (values.some((value) => !allowed.has(value as MatrixApprovalMode))) {
    throw new Error("MATRIX_APPROVAL_MODES may contain only once, session, always, and deny");
  }
  return values as MatrixApprovalMode[];
}

function deliveryMode(raw: string | undefined): MatrixDeliveryMode {
  if (!raw?.trim() || raw === "edits") return "edits";
  if (raw === "final") return "final";
  throw new Error("MATRIX_DELIVERY_MODE must be edits or final");
}

export function matrixPluginConfigFromEnv(env: Record<string, string | undefined>): MatrixPluginConfig | null {
  if (!MATRIX_ENV_KEYS.some((key) => env[key] !== undefined)) return null;
  const normalizedHomeserverUrl = homeserverUrl(required(env, "MATRIX_HOMESERVER_URL"));
  const accessToken = required(env, "MATRIX_ACCESS_TOKEN");
  const allowedRoomIds = idList(required(env, "MATRIX_ALLOWED_ROOM_IDS"), "MATRIX_ALLOWED_ROOM_IDS", "!");
  const allowedUserIds = idList(required(env, "MATRIX_ALLOWED_USER_IDS"), "MATRIX_ALLOWED_USER_IDS", "@");
  return {
    homeserverUrl: normalizedHomeserverUrl,
    accessToken,
    allowedRoomIds,
    allowedUserIds,
    principalMap: principalMap(env.MATRIX_PRINCIPAL_MAP_JSON, allowedUserIds),
    syncTimeoutMs: integer(env.MATRIX_SYNC_TIMEOUT_MS, "MATRIX_SYNC_TIMEOUT_MS", 30_000, 1_000, 60_000),
    syncCursorPath: syncCursorPath(env),
    deliveryMode: deliveryMode(env.MATRIX_DELIVERY_MODE),
    formattedMessages: enabled(env.MATRIX_FORMATTED_MESSAGES, "MATRIX_FORMATTED_MESSAGES", true),
    followThreads: enabled(env.MATRIX_FOLLOW_THREADS, "MATRIX_FOLLOW_THREADS", true),
    reactions: enabled(env.MATRIX_REACTIONS, "MATRIX_REACTIONS", true),
    attachments: {
      enabled: enabled(env.MATRIX_ATTACHMENTS_ENABLED, "MATRIX_ATTACHMENTS_ENABLED", true),
      maxCount: integer(env.MATRIX_ATTACHMENT_MAX_COUNT, "MATRIX_ATTACHMENT_MAX_COUNT", 10, 1, 10),
      maxBytes: integer(env.MATRIX_ATTACHMENT_MAX_BYTES, "MATRIX_ATTACHMENT_MAX_BYTES", 25_000_000, 1, 1_000_000_000),
      allowedMimeTypes: mimeTypes(env.MATRIX_ATTACHMENT_MIME_TYPES),
      allowedMediaServerNames: mediaServerNames(
        env.MATRIX_MEDIA_SERVER_NAMES,
        normalizedHomeserverUrl,
        allowedRoomIds,
        allowedUserIds,
      ),
    },
    approvalModes: approvalModes(env.MATRIX_APPROVAL_MODES),
  };
}

export function matrixConfigEnv(
  config: Omit<MatrixPluginConfig, "accessToken" | "syncCursorPath">,
  accessToken: string,
) {
  return {
    MATRIX_HOMESERVER_URL: config.homeserverUrl,
    MATRIX_ACCESS_TOKEN: accessToken,
    MATRIX_ALLOWED_ROOM_IDS: config.allowedRoomIds.join(","),
    MATRIX_ALLOWED_USER_IDS: config.allowedUserIds.join(","),
    MATRIX_PRINCIPAL_MAP_JSON: JSON.stringify(config.principalMap),
    MATRIX_SYNC_TIMEOUT_MS: String(config.syncTimeoutMs),
    MATRIX_SYNC_CURSOR_PATH: "./matrix-sync-cursor",
    MATRIX_DELIVERY_MODE: config.deliveryMode,
    MATRIX_FORMATTED_MESSAGES: String(config.formattedMessages),
    MATRIX_FOLLOW_THREADS: String(config.followThreads),
    MATRIX_REACTIONS: String(config.reactions),
    MATRIX_ATTACHMENTS_ENABLED: String(config.attachments.enabled),
    MATRIX_ATTACHMENT_MAX_COUNT: String(config.attachments.maxCount),
    MATRIX_ATTACHMENT_MAX_BYTES: String(config.attachments.maxBytes),
    MATRIX_ATTACHMENT_MIME_TYPES: config.attachments.allowedMimeTypes.join(","),
    MATRIX_MEDIA_SERVER_NAMES: config.attachments.allowedMediaServerNames.join(","),
    MATRIX_APPROVAL_MODES: config.approvalModes.join(","),
  };
}
