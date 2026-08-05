import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixClient } from "../src/matrix/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Matrix client authenticates with a bearer header and never puts the token in the URL", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "top-secret" },
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ user_id: "@qm:example.com", device_id: "QM" });
    },
  );

  assert.deepEqual(await client.whoAmI(), { userId: "@qm:example.com", deviceId: "QM" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://matrix.example.com/_matrix/client/v3/account/whoami");
  assert.equal(calls[0]!.url.includes("top-secret"), false);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer top-secret");
});

test("Matrix client encodes sync cursors and sends threaded replies", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "secret" },
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return calls.length === 1
        ? jsonResponse({ next_batch: "next", rooms: {} })
        : jsonResponse({ event_id: "$reply:example.com" });
    },
  );

  await client.sync("s/1", 12000);
  await client.sendText(
    "!room:example.com",
    "hello",
    {
      threadRootEventId: "$root:example.com",
      replyToEventId: "$message:example.com",
    },
    "reply-event-1",
  );

  const syncUrl = new URL(calls[0]!.url);
  assert.equal(syncUrl.searchParams.get("since"), "s/1");
  assert.equal(syncUrl.searchParams.get("timeout"), "12000");
  assert.ok(syncUrl.searchParams.get("filter")?.includes("m.room.message"));
  assert.ok(syncUrl.searchParams.get("filter")?.includes("m.reaction"));

  assert.match(calls[1]!.url, /rooms\/%21room%3Aexample\.com\/send\/m\.room\.message\//);
  assert.match(calls[1]!.url, /reply-event-1$/);
  const body = JSON.parse(String(calls[1]!.init.body));
  assert.deepEqual(body, {
    msgtype: "m.text",
    body: "hello",
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: "$root:example.com",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$message:example.com" },
    },
  });
});

test("Matrix client sends safe formatted text and deterministic replacement edits", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "secret" },
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ event_id: calls.length === 1 ? "$working:example.com" : "$edit:example.com" });
    },
  );

  await client.sendText(
    "!room:example.com",
    "Working…",
    { threadRootEventId: "$root:example.com", replyToEventId: "$trigger:example.com" },
    "progress-1",
    "<p><strong>Working…</strong></p>",
  );
  await client.editText("!room:example.com", "$working:example.com", "Finished", "progress-edit-1", "<p>Finished</p>");

  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    msgtype: "m.text",
    body: "Working…",
    format: "org.matrix.custom.html",
    formatted_body: "<p><strong>Working…</strong></p>",
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: "$root:example.com",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$trigger:example.com" },
    },
  });
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    msgtype: "m.text",
    body: "* Finished",
    "m.new_content": {
      msgtype: "m.text",
      body: "Finished",
      format: "org.matrix.custom.html",
      formatted_body: "<p>Finished</p>",
    },
    "m.relates_to": { rel_type: "m.replace", event_id: "$working:example.com" },
  });
});

test("Matrix client downloads only allowlisted MXC media with an exact allowed MIME type and byte limit", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "secret" },
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("hello", { headers: { "content-type": "text/plain", "content-length": "5" } });
    },
  );

  const downloaded = await client.downloadMedia("mxc://example.com/media/id", {
    maxBytes: 5,
    allowedServerNames: ["example.com"],
    allowedMimeTypes: ["text/plain"],
    expectedMimetype: "text/plain",
  });
  assert.equal(Buffer.from(downloaded.bytes).toString(), "hello");
  assert.equal(downloaded.mimetype, "text/plain");
  assert.match(calls[0]!.url, /_matrix\/client\/v1\/media\/download\/example\.com\/media%2Fid$/);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer secret");
  assert.equal(calls[0]!.init.redirect, "manual");

  await assert.rejects(
    client.downloadMedia("mxc://evil.example/media", {
      maxBytes: 5,
      allowedServerNames: ["example.com"],
      allowedMimeTypes: ["text/plain"],
    }),
    /not allowlisted/,
  );
});

test("Matrix client stops reading a chunked media response as soon as the byte limit is crossed", async () => {
  let pulls = 0;
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "secret" },
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls > 100) return controller.close();
            controller.enqueue(new Uint8Array(4));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  );

  await assert.rejects(
    client.downloadMedia("mxc://example.com/large", {
      maxBytes: 5,
      allowedServerNames: ["example.com"],
      allowedMimeTypes: ["text/plain"],
    }),
    /exceeds the 5-byte limit/,
  );
  assert.ok(pulls < 10);
});

test("Matrix client uploads bytes and sends a threaded file event", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "secret" },
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return calls.length === 1
        ? jsonResponse({ content_uri: "mxc://example.com/outbound" })
        : jsonResponse({ event_id: "$file:example.com" });
    },
  );

  const upload = await client.uploadMedia("report.txt", "text/plain", Buffer.from("report"));
  assert.deepEqual(upload, { contentUri: "mxc://example.com/outbound" });
  assert.equal(calls[0]!.init.body instanceof Uint8Array, true);
  assert.equal(new Headers(calls[0]!.init.headers).get("content-type"), "text/plain");

  await client.sendFile(
    "!room:example.com",
    {
      name: "report.txt",
      mimetype: "text/plain",
      sizeBytes: 6,
      contentUri: upload.contentUri,
    },
    { threadRootEventId: "$root:example.com", replyToEventId: "$trigger:example.com" },
    "file-1",
  );
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    msgtype: "m.file",
    body: "report.txt",
    filename: "report.txt",
    url: "mxc://example.com/outbound",
    info: { mimetype: "text/plain", size: 6 },
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: "$root:example.com",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$trigger:example.com" },
    },
  });
});

test("Matrix client reports API errors without exposing its access token", async () => {
  const client = createMatrixClient(
    { homeserverUrl: "https://matrix.example.com", accessToken: "top-secret" },
    async () => jsonResponse({ errcode: "M_FORBIDDEN", error: "No access" }, 403),
  );

  await assert.rejects(client.whoAmI(), (error: Error) => {
    assert.match(error.message, /M_FORBIDDEN/);
    assert.equal(error.message.includes("top-secret"), false);
    return true;
  });
});

test("Matrix client normalizes joined-room timeline events from sync", async () => {
  const client = createMatrixClient({ homeserverUrl: "https://matrix.example.com", accessToken: "secret" }, async () =>
    jsonResponse({
      next_batch: "next",
      rooms: {
        join: {
          "!room:example.com": {
            timeline: {
              limited: true,
              prev_batch: "older",
              events: [
                {
                  type: "m.room.message",
                  event_id: "$event:example.com",
                  sender: "@alice:example.com",
                  origin_server_ts: 1_785_600_000_000,
                  content: { msgtype: "m.text", body: "hello" },
                },
                {
                  type: "m.room.redaction",
                  event_id: "$legacy-redaction:example.com",
                  sender: "@alice:example.com",
                  origin_server_ts: 1_785_600_000_001,
                  redacts: "$event:example.com",
                  content: {},
                },
                {
                  type: "m.room.redaction",
                  event_id: "$modern-redaction:example.com",
                  sender: "@alice:example.com",
                  origin_server_ts: 1_785_600_000_002,
                  content: { redacts: "$other:example.com" },
                },
              ],
            },
          },
        },
      },
    }),
  );

  assert.deepEqual(await client.sync(), {
    nextBatch: "next",
    joinedRooms: [
      {
        roomId: "!room:example.com",
        limited: true,
        previousBatch: "older",
        events: [
          {
            type: "m.room.message",
            eventId: "$event:example.com",
            sender: "@alice:example.com",
            originServerTs: 1_785_600_000_000,
            content: { msgtype: "m.text", body: "hello" },
          },
          {
            type: "m.room.redaction",
            eventId: "$legacy-redaction:example.com",
            sender: "@alice:example.com",
            originServerTs: 1_785_600_000_001,
            content: {},
            redacts: "$event:example.com",
          },
          {
            type: "m.room.redaction",
            eventId: "$modern-redaction:example.com",
            sender: "@alice:example.com",
            originServerTs: 1_785_600_000_002,
            content: { redacts: "$other:example.com" },
            redacts: "$other:example.com",
          },
        ],
      },
    ],
  });
});

test("Matrix client reads room privacy and membership state", async () => {
  const client = createMatrixClient({ homeserverUrl: "https://matrix.example.com", accessToken: "secret" }, async () =>
    jsonResponse([
      { type: "m.room.join_rules", content: { join_rule: "invite" } },
      { type: "m.room.history_visibility", content: { history_visibility: "joined" } },
      { type: "m.room.guest_access", content: { guest_access: "forbidden" } },
      { type: "m.room.member", state_key: "@qm:example.com", content: { membership: "join" } },
      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "invite" } },
    ]),
  );

  assert.deepEqual(await client.roomSecurity("!room:example.com"), {
    encrypted: false,
    joinRule: "invite",
    historyVisibility: "joined",
    guestAccess: "forbidden",
    participatingUserIds: ["@qm:example.com", "@alice:example.com"],
  });
});
