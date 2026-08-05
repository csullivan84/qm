import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMatrixEventHandler, startMatrixPlugin, type MatrixApi, type MatrixEvent } from "../src/matrix/plugin.ts";
import type { MatrixPluginConfig } from "../src/matrix/config.ts";
import {
  createMatrixSyncStateStore,
  MatrixSyncLeaseError,
  type MatrixSyncStateRecord,
} from "../src/matrix/sync-state.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMatrixInstallationStore, type StoredMatrixInstallation } from "../src/surfaces/matrix-installation.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";

const config: MatrixPluginConfig = {
  homeserverUrl: "https://matrix.example.com",
  accessToken: "secret",
  allowedRoomIds: ["!dm:example.com", "!team:example.com"],
  allowedUserIds: ["@alice:example.com", "@chris:example.com"],
  principalMap: { "@alice:example.com": "alice" },
  syncTimeoutMs: 12000,
  syncCursorPath: "/tmp/qm-matrix-test-cursor",
  deliveryMode: "final",
  formattedMessages: true,
  followThreads: true,
  reactions: true,
  attachments: {
    enabled: true,
    maxCount: 10,
    maxBytes: 25000000,
    allowedMimeTypes: ["text/plain", "application/pdf"],
    allowedMediaServerNames: ["example.com"],
  },
  approvalModes: [],
};

class FakeMatrix implements MatrixApi {
  readonly sent: Array<{
    roomId: string;
    body: string;
    relation?: { threadRootEventId?: string; replyToEventId?: string };
  }> = [];
  readonly reactions: Array<{ roomId: string; eventId: string; key: string }> = [];
  readonly edits: Array<{ roomId: string; eventId: string; body: string; formattedBody?: string }> = [];
  readonly files: Array<{
    roomId: string;
    file: { name: string; mimetype: string; sizeBytes: number; contentUri: string };
    relation?: { threadRootEventId?: string; replyToEventId?: string };
  }> = [];
  readonly uploads: Array<{ name: string; mimetype: string; bytes: Uint8Array }> = [];
  readonly downloads = new Map<string, { bytes: Uint8Array; mimetype: string }>();
  readonly transactionIds: string[] = [];
  readonly events = new Map<string, MatrixEvent>();
  membersByRoom = new Map([
    [
      "!dm:example.com",
      [
        { userId: "@qm:example.com", displayName: "QM" },
        { userId: "@alice:example.com", displayName: "Alice" },
      ],
    ],
    [
      "!team:example.com",
      [
        { userId: "@qm:example.com", displayName: "QM" },
        { userId: "@alice:example.com", displayName: "Alice" },
        { userId: "@chris:example.com", displayName: "Chris" },
      ],
    ],
  ]);

  async whoAmI() {
    return { userId: "@qm:example.com", deviceId: "QM" };
  }
  async sync() {
    return { nextBatch: "next", joinedRooms: [] };
  }
  async joinedMembers(roomId: string) {
    return this.membersByRoom.get(roomId) ?? [];
  }
  async roomSecurity(roomId: string) {
    return {
      encrypted: false,
      joinRule: "invite",
      historyVisibility: "joined",
      guestAccess: "forbidden",
      participatingUserIds: (this.membersByRoom.get(roomId) ?? []).map((member) => member.userId),
    };
  }
  async roomName(roomId: string) {
    return roomId === "!team:example.com" ? "Team" : "Direct chat";
  }
  async getEvent(_roomId: string, eventId: string) {
    return this.events.get(eventId) ?? null;
  }
  async sendText(
    roomId: string,
    body: string,
    relation?: { threadRootEventId?: string; replyToEventId?: string },
    transactionId?: string,
    _formattedBody?: string,
  ) {
    this.sent.push({ roomId, body, ...(relation ? { relation } : {}) });
    if (transactionId) this.transactionIds.push(transactionId);
    return { eventId: `$sent-${this.sent.length}:example.com` };
  }
  async editText(roomId: string, eventId: string, body: string, transactionId?: string, formattedBody?: string) {
    this.edits.push({ roomId, eventId, body, ...(formattedBody ? { formattedBody } : {}) });
    if (transactionId) this.transactionIds.push(transactionId);
    return { eventId: `$edit-${this.edits.length}:example.com` };
  }
  async downloadMedia(contentUri: string) {
    const result = this.downloads.get(contentUri);
    if (!result) throw new Error("missing fake Matrix media");
    return result;
  }
  async uploadMedia(name: string, mimetype: string, bytes: Uint8Array) {
    this.uploads.push({ name, mimetype, bytes });
    return { contentUri: `mxc://example.com/upload-${this.uploads.length}` };
  }
  async sendFile(
    roomId: string,
    file: { name: string; mimetype: string; sizeBytes: number; contentUri: string },
    relation?: { threadRootEventId?: string; replyToEventId?: string },
    transactionId?: string,
  ) {
    this.files.push({ roomId, file, ...(relation ? { relation } : {}) });
    if (transactionId) this.transactionIds.push(transactionId);
    return { eventId: `$file-${this.files.length}:example.com` };
  }
  async sendReaction(roomId: string, eventId: string, key: string, transactionId?: string) {
    this.reactions.push({ roomId, eventId, key });
    if (transactionId) this.transactionIds.push(transactionId);
    return { eventId: `$reaction-${this.reactions.length}:example.com` };
  }
}

class FakeApp {
  readonly turns: TurnRequest[] = [];
  readonly ingests: Array<{ surface: string | undefined; events: any[] }> = [];
  result: TurnResult = { status: "ok", reply: "agent reply" };
  onTurn?: () => void;
  readonly approvals = new Map<string, any>();
  readonly blobs = new Map<string, Buffer>();
  private staged = 0;

  async turn(request: TurnRequest): Promise<TurnResult> {
    this.turns.push(request);
    this.onTurn?.();
    return this.result;
  }

  async ingestSurfaceEvents(events: any[], surface?: string): Promise<{ upserted: number }> {
    this.ingests.push({ surface, events });
    return { upserted: events.length };
  }

  async readSurfaceMessages(container: string, opts?: { sub?: string }) {
    return this.ingests
      .flatMap((entry) => entry.events)
      .filter((event) => event.container === container && (!opts?.sub || event.sub === opts.sub));
  }

  async getApproval(requestId: string) {
    return this.approvals.get(requestId) ?? null;
  }

  async stageBlob(bytes: Uint8Array) {
    const blobId = `blob-${++this.staged}`;
    this.blobs.set(blobId, Buffer.from(bytes));
    return { blobId, sizeBytes: bytes.length };
  }

  async readBlob(blobId: string) {
    const bytes = this.blobs.get(blobId);
    if (!bytes) throw new Error("missing fake blob");
    return bytes;
  }
}

function message(roomId: string, eventId: string, sender: string, body: string, content: Record<string, unknown> = {}) {
  return {
    roomId,
    event: {
      type: "m.room.message",
      eventId,
      sender,
      originServerTs: 1_785_600_000_000,
      content: { msgtype: "m.text", body, ...content },
    } satisfies MatrixEvent,
  };
}

test("Matrix direct messages become durable QM turns and replies", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!dm:example.com", "$one", "@alice:example.com", "hello"));

  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0]!.surface, "matrix");
  assert.equal(app.turns[0]!.actor.externalId, "alice");
  assert.equal(app.turns[0]!.actor.displayName, "Alice");
  assert.deepEqual(app.turns[0]!.conversation, {
    kind: "dm",
    threadRef: "matrix:!dm:example.com",
    channelName: "Direct chat",
    audience: [{ externalId: "alice", displayName: "Alice" }],
    isPrivate: true,
  });
  assert.equal(app.turns[0]!.idempotencyKey, "matrix:$one");
  assert.match(app.ingests[0]!.events[0]!.ts, /^\d+\.\d+$/);
  assert.equal(app.ingests[0]!.events[0]!.sourceEventId, "$one");
  assert.equal(app.ingests[1]!.events[0]!.sourceEventId, "$sent-1:example.com");
  assert.equal(matrix.transactionIds.length, 1);
  assert.deepEqual(matrix.sent, [{ roomId: "!dm:example.com", body: "agent reply" }]);
  assert.deepEqual(
    app.ingests.map((entry) => entry.surface),
    ["matrix", "matrix"],
  );
});

test("Matrix rooms only dispatch mentions and keep the reply in a thread", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!team:example.com", "$quiet", "@chris:example.com", "hello team"));
  assert.equal(app.turns.length, 0);
  assert.equal(app.ingests.length, 1);

  await handle(
    message("!team:example.com", "$mention", "@chris:example.com", "@qm:example.com please summarize", {
      "m.mentions": { user_ids: ["@qm:example.com"] },
    }),
  );

  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0]!.text, "please summarize");
  assert.equal(app.turns[0]!.conversation.kind, "channel");
  assert.equal(app.turns[0]!.conversation.channelRef, "!team:example.com");
  assert.equal(app.turns[0]!.conversation.threadRef, "matrix:!team:example.com:$mention");
  assert.deepEqual(matrix.sent[0], {
    roomId: "!team:example.com",
    body: "agent reply",
    relation: { threadRootEventId: "$mention", replyToEventId: "$mention" },
  });
});

test("Matrix posts one progress event and deterministically edits it with safe formatted output", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  app.result = { status: "ok", reply: "**Finished** <script>alert(1)</script>" };
  const handle = createMatrixEventHandler({
    config: { ...config, deliveryMode: "edits" },
    matrix,
    app,
    botUserId: "@qm:example.com",
  });

  await handle(message("!dm:example.com", "$progress", "@alice:example.com", "run it"));

  assert.deepEqual(matrix.sent, [{ roomId: "!dm:example.com", body: "Working…" }]);
  assert.equal(matrix.edits.length, 1);
  assert.equal(matrix.edits[0]!.eventId, "$sent-1:example.com");
  assert.equal(matrix.edits[0]!.body, "**Finished** <script>alert(1)</script>");
  assert.match(matrix.edits[0]!.formattedBody!, /<strong>Finished<\/strong>/);
  assert.doesNotMatch(matrix.edits[0]!.formattedBody!, /<script>/);
  assert.equal(matrix.transactionIds.length, 2);
});

test("Matrix stages allowlisted inbound media and uploads outbound QM blobs", async () => {
  const matrix = new FakeMatrix();
  matrix.downloads.set("mxc://example.com/inbound", { bytes: Buffer.from("source"), mimetype: "text/plain" });
  const app = new FakeApp();
  app.blobs.set("outbound-blob", Buffer.from("result"));
  app.result = {
    status: "ok",
    reply: "Attached result.",
    attachments: [{ name: "result.txt", mimetype: "text/plain", sizeBytes: 6, blobId: "outbound-blob" }],
  };
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle({
    roomId: "!dm:example.com",
    event: {
      type: "m.room.message",
      eventId: "$file-in",
      sender: "@alice:example.com",
      originServerTs: 1_785_600_000_000,
      content: {
        msgtype: "m.file",
        body: "source.txt",
        filename: "source.txt",
        url: "mxc://example.com/inbound",
        info: { mimetype: "text/plain", size: 6 },
      },
    },
  });

  assert.equal(app.turns.length, 1);
  assert.deepEqual(app.turns[0]!.attachments, [
    {
      name: "source.txt",
      mimetype: "text/plain",
      sizeBytes: 6,
      blobId: "blob-1",
      sourceId: "mxc://example.com/inbound",
      author: "Alice",
    },
  ]);
  assert.equal(matrix.uploads.length, 1);
  assert.equal(Buffer.from(matrix.uploads[0]!.bytes).toString(), "result");
  assert.deepEqual(matrix.files[0], {
    roomId: "!dm:example.com",
    file: {
      name: "result.txt",
      mimetype: "text/plain",
      sizeBytes: 6,
      contentUri: "mxc://example.com/upload-1",
    },
  });
});

test("Matrix follows a room thread after the bot has durable stake without requiring another mention", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(
    message("!team:example.com", "$root", "@alice:example.com", "@qm:example.com start", {
      "m.mentions": { user_ids: ["@qm:example.com"] },
    }),
  );
  await handle(
    message("!team:example.com", "$continued", "@chris:example.com", "continue", {
      "m.relates_to": { rel_type: "m.thread", event_id: "$root", "m.in_reply_to": { event_id: "$root" } },
    }),
  );

  assert.equal(app.turns.length, 2);
  assert.equal(app.turns[1]!.conversation.threadRef, "matrix:!team:example.com:$root");
  assert.equal(app.turns[1]!.unprompted, true);
  assert.equal(app.turns[1]!.addressed, false);
});

test("Matrix turns a relevant inbound reaction into an idempotent unprompted turn", async () => {
  const matrix = new FakeMatrix();
  matrix.events.set("$bot", {
    type: "m.room.message",
    eventId: "$bot",
    sender: "@qm:example.com",
    originServerTs: 1,
    content: { msgtype: "m.text", body: "Ship it" },
  });
  const app = new FakeApp();
  app.result = { status: "silent" };
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle({
    roomId: "!team:example.com",
    event: {
      type: "m.reaction",
      eventId: "$reaction-in",
      sender: "@alice:example.com",
      originServerTs: 1_785_600_000_000,
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$bot", key: "👍" } },
    },
  });

  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0]!.unprompted, true);
  assert.match(app.turns[0]!.text, /Alice reacted 👍/);
  assert.equal(app.turns[0]!.idempotencyKey, "matrix-reaction:$reaction-in");
  assert.equal(matrix.sent.length, 0);
});

test("Matrix replies to the bot keep the established room thread active", async () => {
  const matrix = new FakeMatrix();
  matrix.events.set("$bot-reply", {
    type: "m.room.message",
    eventId: "$bot-reply",
    sender: "@qm:example.com",
    originServerTs: 1,
    content: { msgtype: "m.text", body: "prior answer" },
  });
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(
    message("!team:example.com", "$follow", "@alice:example.com", "one more thing", {
      "m.relates_to": { "m.in_reply_to": { event_id: "$bot-reply" } },
    }),
  );

  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0]!.conversation.threadRef, "matrix:!team:example.com:$bot-reply");
  assert.deepEqual(matrix.sent[0]!.relation, {
    threadRootEventId: "$bot-reply",
    replyToEventId: "$follow",
  });
});

test("Matrix rejects unauthorized users before invoking QM", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!dm:example.com", "$bad", "@intruder:example.com", "run this"));

  assert.equal(app.turns.length, 0);
  assert.equal(matrix.sent.length, 0);
  assert.equal(app.ingests.length, 0);
});

test("Matrix fails closed when an allowlisted room contains an unauthorized member", async () => {
  const matrix = new FakeMatrix();
  matrix.membersByRoom.set("!team:example.com", [
    { userId: "@qm:example.com", displayName: "QM" },
    { userId: "@alice:example.com", displayName: "Alice" },
    { userId: "@intruder:example.com", displayName: "Intruder" },
  ]);
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(
    message("!team:example.com", "$unsafe", "@alice:example.com", "@qm:example.com summarize this", {
      "m.mentions": { user_ids: ["@qm:example.com"] },
    }),
  );

  assert.equal(app.turns.length, 0);
  assert.equal(matrix.sent.length, 0);
  assert.equal(app.ingests.length, 0);
});

test("Matrix explains the unencrypted-room requirement once per room", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });
  const encrypted = {
    roomId: "!team:example.com",
    event: {
      type: "m.room.encrypted",
      eventId: "$encrypted",
      sender: "@alice:example.com",
      originServerTs: 1_785_600_000_000,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque" },
    } satisfies MatrixEvent,
  };

  await handle(encrypted);
  await handle({ ...encrypted, event: { ...encrypted.event, eventId: "$encrypted-again" } });

  assert.equal(app.turns.length, 0);
  assert.equal(app.ingests.length, 0);
  assert.equal(matrix.sent.length, 0);
});

test("Matrix keeps approvals in the authenticated web interface", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  app.result = {
    status: "pending_approval",
    pendingApprovals: [{ requestId: "req-1", command: "deploy", reason: "Changes production" }],
  };
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!dm:example.com", "$ask", "@alice:example.com", "deploy"));
  assert.match(matrix.sent[0]!.body, /QM web interface/i);
  assert.match(matrix.sent[0]!.body, /Matrix approval commands are disabled/i);

  app.result = { status: "ok", reply: "approved" };
  await handle(message("!dm:example.com", "$approve", "@alice:example.com", "approve req-1"));
  assert.equal(app.turns[1]!.approval, undefined);
});

test("Matrix resolves an enabled exact approval only for the stored requester and thread", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  app.result = {
    status: "pending_approval",
    pendingApprovals: [
      {
        requestId: "req-1",
        command: "deploy",
        reason: "Changes production",
        grantModes: { session: true, always: false },
      },
    ],
  };
  const approvalConfig: MatrixPluginConfig = { ...config, approvalModes: ["once", "session", "always", "deny"] };
  const handle = createMatrixEventHandler({ config: approvalConfig, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!dm:example.com", "$ask", "@alice:example.com", "deploy"));
  assert.match(matrix.sent[0]!.body, /allow once req-1/i);
  assert.match(matrix.sent[0]!.body, /allow session req-1/i);
  assert.doesNotMatch(matrix.sent[0]!.body, /allow always req-1/i);
  assert.match(matrix.sent[0]!.body, /deny req-1/i);

  app.approvals.set("req-1", {
    requestId: "req-1",
    sessionId: "session-1",
    command: "deploy",
    reason: "Changes production",
    grantModes: { session: true, always: false },
    request: app.turns[0],
  });
  app.result = { status: "ok", reply: "Deployment approved." };
  await handle(message("!dm:example.com", "$approve", "@alice:example.com", "allow once req-1"));

  assert.deepEqual(app.turns[1]!.approval, { requestId: "req-1", approved: true, scope: "once" });
  assert.equal(app.turns[1]!.actor.externalId, "alice");
  assert.equal(app.turns[1]!.idempotencyKey, "matrix-approval:$approve");
});

test("Matrix ignores edits instead of executing replacement text as a new turn", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(
    message("!dm:example.com", "$edit", "@alice:example.com", "changed command", {
      "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      "m.new_content": { msgtype: "m.text", body: "changed command" },
    }),
  );

  assert.equal(app.turns.length, 0);
  assert.equal(app.ingests.length, 0);
});

test("Matrix redactions delete the target source event from durable surface context", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!team:example.com", "$sensitive", "@alice:example.com", "sensitive body"));
  await handle({
    roomId: "!team:example.com",
    event: {
      type: "m.room.redaction",
      eventId: "$redaction",
      sender: "@alice:example.com",
      originServerTs: 1_785_600_001_000,
      content: {},
      redacts: "$sensitive",
    },
  });

  assert.equal(app.turns.length, 0);
  assert.equal(app.ingests.length, 2);
  assert.equal(app.ingests[1]!.surface, "matrix");
  assert.equal(app.ingests[1]!.events[0]!.sourceEventId, "$sensitive");
  assert.equal(app.ingests[1]!.events[0]!.deleted, true);
});

test("Matrix rechecks room authorization before delivering a completed turn", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  app.onTurn = () => {
    matrix.membersByRoom.set("!dm:example.com", [
      { userId: "@qm:example.com", displayName: "QM" },
      { userId: "@alice:example.com", displayName: "Alice" },
      { userId: "@intruder:example.com", displayName: "Intruder" },
    ]);
  };
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await assert.rejects(
    handle(message("!dm:example.com", "$membership-change", "@alice:example.com", "private request")),
    /authorization changed/i,
  );
  assert.equal(matrix.sent.length, 0);
});

test("Matrix cache timestamps stay numeric, ordered, and unique for same-millisecond events", async () => {
  const matrix = new FakeMatrix();
  const app = new FakeApp();
  const handle = createMatrixEventHandler({ config, matrix, app, botUserId: "@qm:example.com" });

  await handle(message("!dm:example.com", "$same-a", "@alice:example.com", "first"));
  await handle(message("!dm:example.com", "$same-b", "@alice:example.com", "second"));
  const incoming = app.ingests.filter((entry) => entry.events[0]?.authorId === "alice").map((entry) => entry.events[0]);
  assert.equal(incoming.length, 2);
  assert.match(incoming[0]!.ts, /^\d+\.\d+$/);
  assert.match(incoming[1]!.ts, /^\d+\.\d+$/);
  assert.notEqual(incoming[0]!.ts, incoming[1]!.ts);
  assert.equal(Number.isFinite(Number(incoming[0]!.ts)), true);
});

test("Matrix plugin persists an identity-scoped local cursor and resumes from it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-matrix-cursor-"));
  const cursorPath = join(directory, "cursor");
  const syncCursors: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com", device_id: "QM" }));
    }
    const since = url.searchParams.get("since");
    syncCursors.push(since);
    if (!since) return new Response(JSON.stringify({ next_batch: "baseline", rooms: {} }));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  try {
    const first = await startMatrixPlugin({ ...config, syncCursorPath: cursorPath }, new FakeApp(), fetchImpl);
    const [cursorFile] = await readdir(directory);
    assert.ok(cursorFile);
    assert.ok(cursorFile.startsWith("cursor."));
    const identityCursorPath = join(directory, cursorFile);
    assert.equal((await readFile(identityCursorPath, "utf8")).trim(), "baseline");
    assert.deepEqual(syncCursors, [null, "baseline"]);
    await first.stop();

    syncCursors.length = 0;
    await writeFile(identityCursorPath, "persisted\n");
    const second = await startMatrixPlugin({ ...config, syncCursorPath: cursorPath }, new FakeApp(), fetchImpl);
    assert.deepEqual(syncCursors, ["persisted"]);
    await second.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Matrix plugin shares its cursor across restarts and refuses a competing durable consumer", async () => {
  const syncCursors: Array<string | null> = [];
  const syncState = createMatrixSyncStateStore(createMemoryMap<MatrixSyncStateRecord>());
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com", device_id: "QM" }));
    }
    const since = url.searchParams.get("since");
    syncCursors.push(since);
    if (!since) return new Response(JSON.stringify({ next_batch: "baseline", rooms: {} }));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };

  const first = await startMatrixPlugin(config, new FakeApp(), fetchImpl, syncState);
  assert.deepEqual(syncCursors, [null, "baseline"]);
  await assert.rejects(startMatrixPlugin(config, new FakeApp(), fetchImpl, syncState), /active lease/);
  await first.stop();

  syncCursors.length = 0;
  const restarted = await startMatrixPlugin(config, new FakeApp(), fetchImpl, syncState);
  assert.deepEqual(syncCursors, ["baseline"]);
  await restarted.stop();
});

test("Matrix plugin replaces an expired durable cursor with a fresh baseline", async () => {
  const backing = createMemoryMap<MatrixSyncStateRecord>();
  const syncState = createMatrixSyncStateStore(backing);
  const identityKey = syncState.identityKey(config.homeserverUrl, "@qm:example.com");
  await backing.put(identityKey, { id: identityKey, cursor: "expired", updatedAt: Date.now() });
  const syncCursors: Array<string | null> = [];
  let baselineReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    baselineReached = resolve;
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com", device_id: "QM" }));
    }
    const since = url.searchParams.get("since");
    syncCursors.push(since);
    if (since === "expired") {
      return new Response(JSON.stringify({ errcode: "M_UNKNOWN_POS", error: "expired" }), { status: 400 });
    }
    if (!since) return new Response(JSON.stringify({ next_batch: "fresh", rooms: {} }));
    baselineReached?.();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };

  const plugin = await startMatrixPlugin(config, new FakeApp(), fetchImpl, syncState);
  await reached;
  assert.deepEqual(syncCursors, ["expired", null, "fresh"]);
  assert.equal((await backing.get(identityKey))?.cursor, "fresh");
  await plugin.stop();
});

test("Matrix plugin ignores disabled-period events when a new sync generation starts", async () => {
  const backing = createMemoryMap<MatrixSyncStateRecord>();
  const syncState = createMatrixSyncStateStore(backing);
  const oldIdentity = syncState.identityKey(config.homeserverUrl, "@qm:example.com", "before-disable");
  const newIdentity = syncState.identityKey(config.homeserverUrl, "@qm:example.com", "after-disable");
  await backing.put(oldIdentity, { id: oldIdentity, cursor: "before-disable-cursor", updatedAt: Date.now() });
  const app = new FakeApp();
  const syncCursors: Array<string | null> = [];
  let liveSyncReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    liveSyncReached = resolve;
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com", device_id: "QM" }));
    }
    const since = url.searchParams.get("since");
    syncCursors.push(since);
    if (!since) {
      return new Response(
        JSON.stringify({
          next_batch: "after-disable-cursor",
          rooms: {
            join: {
              "!dm:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$while-disabled",
                      sender: "@alice:example.com",
                      origin_server_ts: 1_785_600_000_000,
                      content: { msgtype: "m.text", body: "do not execute" },
                    },
                  ],
                },
              },
            },
          },
        }),
      );
    }
    liveSyncReached?.();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };

  const plugin = await startMatrixPlugin(config, app, fetchImpl, syncState, "after-disable");
  await reached;
  assert.deepEqual(syncCursors, [null, "after-disable-cursor"]);
  assert.equal(app.turns.length, 0);
  assert.equal(app.ingests.length, 0);
  assert.equal((await backing.get(newIdentity))?.cursor, "after-disable-cursor");
  assert.equal((await backing.get(oldIdentity))?.cursor, "before-disable-cursor");
  await plugin.stop();
});

test("Matrix plugin fences an in-flight sync response after durable Admin disable completes", async () => {
  const installations = createMatrixInstallationStore(
    "default-org",
    createMemoryMap<StoredMatrixInstallation>(),
    Buffer.alloc(32, 7),
  );
  await installations.set({ config, botUserId: "@qm:example.com", updatedBy: "admin-alice" });
  const active = await installations.runtime();
  assert.ok(active);
  const syncBacking = createMemoryMap<MatrixSyncStateRecord>();
  const syncState = createMatrixSyncStateStore(syncBacking);
  const activeSyncId = syncState.identityKey(config.homeserverUrl, "@qm:example.com", active.syncGeneration);
  let deliverSync: ((response: Response) => void) | undefined;
  let syncWaiting: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    syncWaiting = resolve;
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com", device_id: "QM" }));
    }
    if (!url.searchParams.get("since")) return new Response(JSON.stringify({ next_batch: "active", rooms: {} }));
    syncWaiting?.();
    return new Promise<Response>((resolve, reject) => {
      deliverSync = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const app = new FakeApp();
  const plugin = await startMatrixPlugin(config, app, fetchImpl, syncState, active.syncGeneration, {
    acquire: (token, expiresAt) => installations.acquireProcessingLease(active.version, token, expiresAt),
    renew: (token, expiresAt) => installations.renewProcessingLease(token, expiresAt),
    release: (token) => installations.releaseProcessingLease(token),
  });
  await waiting;

  await installations.delete("admin-alice");
  deliverSync?.(
    Response.json({
      next_batch: "after-disable",
      rooms: {
        join: {
          "!dm:example.com": {
            timeline: {
              events: [
                {
                  type: "m.room.message",
                  event_id: "$after-disable",
                  sender: "@alice:example.com",
                  origin_server_ts: 1_785_600_000_000,
                  content: { msgtype: "m.text", body: "must not execute" },
                },
              ],
            },
          },
        },
      },
    }),
  );
  await plugin.done;
  assert.equal(app.turns.length, 0);
  assert.equal(app.ingests.length, 0);
  assert.equal((await syncBacking.get(activeSyncId))?.cursor, "active");
  await installations.set({ config, botUserId: "@qm:example.com", updatedBy: "admin-alice" });
  const reenabled = await installations.runtime();
  assert.ok(reenabled);
  assert.notEqual(reenabled.syncGeneration, active.syncGeneration);
  await plugin.stop();
});

test("Matrix plugin exposes durable lease loss as terminal completion", async () => {
  const syncState = {
    identityKey: () => "matrix:test",
    claim: async () => ({ token: "lease" }),
    cursor: async () => "cursor",
    advance: async () => {
      throw new MatrixSyncLeaseError("lease advance failed");
    },
    heartbeat: async () => undefined,
    release: async () => undefined,
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/account/whoami")) {
      return new Response(JSON.stringify({ user_id: "@qm:example.com", device_id: "QM" }));
    }
    return new Response(JSON.stringify({ next_batch: "next", rooms: {} }));
  };

  const plugin = await startMatrixPlugin(config, new FakeApp(), fetchImpl, syncState);
  await assert.rejects(plugin.done, /lease advance failed/);
  await plugin.stop();
});
