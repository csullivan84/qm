import assert from "node:assert/strict";
import test from "node:test";
import { matrixPluginConfigFromEnv } from "../src/matrix/config.ts";

test("Matrix configuration is absent when no Matrix variables are set", () => {
  assert.equal(matrixPluginConfigFromEnv({}), null);
});

test("Matrix configuration requires a complete fail-closed credential and allowlist", () => {
  assert.throws(
    () => matrixPluginConfigFromEnv({ MATRIX_HOMESERVER_URL: "https://matrix.example.com" }),
    /MATRIX_ACCESS_TOKEN/,
  );
  assert.throws(
    () =>
      matrixPluginConfigFromEnv({
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_ACCESS_TOKEN: "secret",
        MATRIX_ALLOWED_USER_IDS: "@alice:matrix.example.com",
      }),
    /MATRIX_ALLOWED_ROOM_IDS/,
  );
});

test("Matrix configuration normalizes values and explicit principal mappings", () => {
  const config = matrixPluginConfigFromEnv({
    MATRIX_HOMESERVER_URL: "https://matrix.example.com/",
    MATRIX_ACCESS_TOKEN: "secret",
    MATRIX_ALLOWED_ROOM_IDS: " !room:example.com, !other:example.com ",
    MATRIX_ALLOWED_USER_IDS: "@alice:example.com,@chris:example.com",
    MATRIX_PRINCIPAL_MAP_JSON: '{"@alice:example.com":"alice"}',
    MATRIX_SYNC_TIMEOUT_MS: "12000",
    DATA_DIR: "/var/lib/qm",
  });

  assert.deepEqual(config, {
    homeserverUrl: "https://matrix.example.com",
    accessToken: "secret",
    allowedRoomIds: ["!room:example.com", "!other:example.com"],
    allowedUserIds: ["@alice:example.com", "@chris:example.com"],
    principalMap: { "@alice:example.com": "alice" },
    syncTimeoutMs: 12000,
    syncCursorPath: "/var/lib/qm/matrix-sync-cursor",
    deliveryMode: "edits",
    formattedMessages: true,
    followThreads: true,
    reactions: true,
    attachments: {
      enabled: true,
      maxCount: 10,
      maxBytes: 25000000,
      allowedMimeTypes: [
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
      ],
      allowedMediaServerNames: ["matrix.example.com", "example.com"],
    },
    approvalModes: [],
  });
});

test("Matrix configuration accepts explicit delivery, attachment, thread, reaction, and approval policy", () => {
  const config = matrixPluginConfigFromEnv({
    MATRIX_HOMESERVER_URL: "https://matrix.example.com",
    MATRIX_ACCESS_TOKEN: "secret",
    MATRIX_ALLOWED_ROOM_IDS: "!room:example.com",
    MATRIX_ALLOWED_USER_IDS: "@alice:example.com",
    MATRIX_DELIVERY_MODE: "final",
    MATRIX_FORMATTED_MESSAGES: "false",
    MATRIX_FOLLOW_THREADS: "false",
    MATRIX_REACTIONS: "false",
    MATRIX_ATTACHMENTS_ENABLED: "false",
    MATRIX_ATTACHMENT_MAX_COUNT: "3",
    MATRIX_ATTACHMENT_MAX_BYTES: "4096",
    MATRIX_ATTACHMENT_MIME_TYPES: "text/plain,application/pdf",
    MATRIX_MEDIA_SERVER_NAMES: "media.example.com,matrix.example.com:8448",
    MATRIX_APPROVAL_MODES: "once,deny",
  });

  assert.equal(config?.deliveryMode, "final");
  assert.equal(config?.formattedMessages, false);
  assert.equal(config?.followThreads, false);
  assert.equal(config?.reactions, false);
  assert.deepEqual(config?.attachments, {
    enabled: false,
    maxCount: 3,
    maxBytes: 4096,
    allowedMimeTypes: ["text/plain", "application/pdf"],
    allowedMediaServerNames: ["media.example.com", "matrix.example.com:8448"],
  });
  assert.deepEqual(config?.approvalModes, ["once", "deny"]);
});

test("Matrix configuration rejects unsafe homeserver and mapping values", () => {
  const base = {
    MATRIX_ACCESS_TOKEN: "secret",
    MATRIX_ALLOWED_ROOM_IDS: "!room:example.com",
    MATRIX_ALLOWED_USER_IDS: "@alice:example.com",
  };
  assert.throws(() => matrixPluginConfigFromEnv({ ...base, MATRIX_HOMESERVER_URL: "file:///tmp/matrix" }), /http/);
  assert.throws(
    () =>
      matrixPluginConfigFromEnv({
        ...base,
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_PRINCIPAL_MAP_JSON: '{"@alice:example.com":""}',
      }),
    /principal mapping/,
  );
  assert.throws(
    () =>
      matrixPluginConfigFromEnv({
        ...base,
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_DELIVERY_MODE: "stream",
      }),
    /MATRIX_DELIVERY_MODE/,
  );
  assert.throws(
    () =>
      matrixPluginConfigFromEnv({
        ...base,
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_APPROVAL_MODES: "once,anything",
      }),
    /MATRIX_APPROVAL_MODES/,
  );
  assert.throws(
    () =>
      matrixPluginConfigFromEnv({
        ...base,
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_ATTACHMENT_MAX_BYTES: "1000000001",
      }),
    /MATRIX_ATTACHMENT_MAX_BYTES/,
  );
});
