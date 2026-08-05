export interface MatrixEvent {
  type: string;
  eventId: string;
  sender: string;
  originServerTs: number;
  content: Record<string, unknown>;
  redacts?: string;
}

interface MatrixJoinedRoom {
  roomId: string;
  limited: boolean;
  previousBatch?: string;
  events: MatrixEvent[];
}

interface MatrixSyncResult {
  nextBatch: string;
  joinedRooms: MatrixJoinedRoom[];
}

interface MatrixRoomSecurity {
  encrypted: boolean;
  joinRule?: string;
  historyVisibility?: string;
  guestAccess?: string;
  participatingUserIds: string[];
}

export interface MatrixMember {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface MatrixRelation {
  threadRootEventId?: string;
  replyToEventId?: string;
}

export interface MatrixClient {
  whoAmI(): Promise<{ userId: string; deviceId?: string }>;
  sync(since?: string, timeoutMs?: number, signal?: AbortSignal): Promise<MatrixSyncResult>;
  joinedMembers(roomId: string): Promise<MatrixMember[]>;
  roomSecurity(roomId: string): Promise<MatrixRoomSecurity>;
  roomName(roomId: string): Promise<string>;
  getEvent(roomId: string, eventId: string): Promise<MatrixEvent | null>;
  sendText(
    roomId: string,
    body: string,
    relation?: MatrixRelation,
    transactionId?: string,
    formattedBody?: string,
  ): Promise<{ eventId: string }>;
  editText(
    roomId: string,
    eventId: string,
    body: string,
    transactionId?: string,
    formattedBody?: string,
  ): Promise<{ eventId: string }>;
  downloadMedia(
    contentUri: string,
    policy: {
      maxBytes: number;
      allowedServerNames: string[];
      allowedMimeTypes: string[];
      expectedMimetype?: string;
    },
  ): Promise<{ bytes: Uint8Array; mimetype: string }>;
  uploadMedia(name: string, mimetype: string, bytes: Uint8Array): Promise<{ contentUri: string }>;
  sendFile(
    roomId: string,
    file: { name: string; mimetype: string; sizeBytes: number; contentUri: string },
    relation?: MatrixRelation,
    transactionId?: string,
  ): Promise<{ eventId: string }>;
  sendReaction(roomId: string, eventId: string, key: string, transactionId?: string): Promise<{ eventId: string }>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MatrixRequestError extends Error {
  readonly status: number;
  readonly errcode: string;

  constructor(status: number, errcode: string, message: string) {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function matrixEvent(value: unknown): MatrixEvent | null {
  const raw = object(value);
  if (
    typeof raw.type !== "string" ||
    typeof raw.event_id !== "string" ||
    typeof raw.sender !== "string" ||
    typeof raw.origin_server_ts !== "number"
  ) {
    return null;
  }
  const content = object(raw.content);
  const redacts = typeof raw.redacts === "string" ? raw.redacts : content.redacts;
  return {
    type: raw.type,
    eventId: raw.event_id,
    sender: raw.sender,
    originServerTs: raw.origin_server_ts,
    content,
    ...(typeof redacts === "string" ? { redacts } : {}),
  };
}

function encoded(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function messageRelation(relation: MatrixRelation | undefined): Record<string, unknown> | undefined {
  if (relation?.threadRootEventId) {
    return {
      rel_type: "m.thread",
      event_id: relation.threadRootEventId,
      is_falling_back: true,
      ...(relation.replyToEventId ? { "m.in_reply_to": { event_id: relation.replyToEventId } } : {}),
    };
  }
  if (relation?.replyToEventId) return { "m.in_reply_to": { event_id: relation.replyToEventId } };
  return undefined;
}

function formattedText(body: string, formattedBody: string | undefined): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body,
    ...(formattedBody ? { format: "org.matrix.custom.html", formatted_body: formattedBody } : {}),
  };
}

function parseMxc(contentUri: string): { serverName: string; mediaId: string } {
  let url: URL;
  try {
    url = new URL(contentUri);
  } catch {
    throw new Error("Matrix attachment has an invalid MXC URI");
  }
  const mediaId = url.pathname.replace(/^\/+/, "");
  if (url.protocol !== "mxc:" || !url.host || !mediaId || url.username || url.password || url.search || url.hash) {
    throw new Error("Matrix attachment has an invalid MXC URI");
  }
  return { serverName: url.host.toLowerCase(), mediaId };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Matrix attachment exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function createMatrixClient(
  config: { homeserverUrl: string; accessToken: string },
  fetchImpl: FetchLike = fetch,
): MatrixClient {
  const base = config.homeserverUrl.replace(/\/+$/, "");

  const authorizationHeaders = (headers?: RequestInit["headers"]): Headers => {
    const next = new Headers(headers);
    next.set("authorization", `Bearer ${config.accessToken}`);
    return next;
  };

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = authorizationHeaders(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetchImpl(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      const error = object(payload);
      const code = typeof error.errcode === "string" ? error.errcode : `HTTP_${response.status}`;
      const detail = typeof error.error === "string" ? error.error : response.statusText || "Matrix request failed";
      throw new MatrixRequestError(response.status, code, `Matrix ${code}: ${detail}`);
    }
    return payload as T;
  }

  return {
    async whoAmI() {
      const payload = await request<{ user_id?: unknown; device_id?: unknown }>("/_matrix/client/v3/account/whoami");
      if (typeof payload.user_id !== "string") throw new Error("Matrix whoami response contained no user id");
      return {
        userId: payload.user_id,
        ...(typeof payload.device_id === "string" ? { deviceId: payload.device_id } : {}),
      };
    },
    async sync(since, timeoutMs = 30_000, signal) {
      const url = new URL(`${base}/_matrix/client/v3/sync`);
      if (since) url.searchParams.set("since", since);
      url.searchParams.set("timeout", String(timeoutMs));
      url.searchParams.set(
        "filter",
        JSON.stringify({
          room: {
            timeline: {
              limit: 50,
              types: ["m.room.message", "m.room.encrypted", "m.reaction", "m.room.redaction"],
            },
          },
        }),
      );
      const path = `${url.pathname}${url.search}`;
      const payload = await request<Record<string, unknown>>(path, signal ? { signal } : {});
      if (typeof payload.next_batch !== "string") throw new Error("Matrix sync response contained no next batch token");
      const join = object(object(payload.rooms).join);
      const joinedRooms = Object.entries(join).map(([roomId, room]) => {
        const timeline = object(object(room).timeline);
        const events = timeline.events;
        return {
          roomId,
          limited: timeline.limited === true,
          ...(typeof timeline.prev_batch === "string" ? { previousBatch: timeline.prev_batch } : {}),
          events: Array.isArray(events)
            ? events.map(matrixEvent).filter((event): event is MatrixEvent => Boolean(event))
            : [],
        };
      });
      return { nextBatch: payload.next_batch, joinedRooms };
    },
    async joinedMembers(roomId) {
      const payload = await request<Record<string, unknown>>(
        `/_matrix/client/v3/rooms/${encoded(roomId)}/joined_members`,
      );
      return Object.entries(object(payload.joined)).map(([userId, value]) => {
        const member = object(value);
        return {
          userId,
          ...(typeof member.display_name === "string" ? { displayName: member.display_name } : {}),
          ...(typeof member.avatar_url === "string" ? { avatarUrl: member.avatar_url } : {}),
        };
      });
    },
    async roomSecurity(roomId) {
      const payload = await request<unknown>(`/_matrix/client/v3/rooms/${encoded(roomId)}/state`);
      const events = Array.isArray(payload) ? payload.map(object) : [];
      const stateContent = (type: string): Record<string, unknown> =>
        object(events.find((event) => event.type === type)?.content);
      const joinRule = stateContent("m.room.join_rules").join_rule;
      const historyVisibility = stateContent("m.room.history_visibility").history_visibility;
      const guestAccess = stateContent("m.room.guest_access").guest_access;
      const participatingUserIds = events
        .filter((event) => event.type === "m.room.member" && typeof event.state_key === "string")
        .filter((event) => {
          const membership = object(event.content).membership;
          return membership === "join" || membership === "invite";
        })
        .map((event) => event.state_key as string);
      return {
        encrypted: events.some((event) => event.type === "m.room.encryption"),
        ...(typeof joinRule === "string" ? { joinRule } : {}),
        ...(typeof historyVisibility === "string" ? { historyVisibility } : {}),
        ...(typeof guestAccess === "string" ? { guestAccess } : {}),
        participatingUserIds,
      };
    },
    async roomName(roomId) {
      try {
        const payload = await request<Record<string, unknown>>(
          `/_matrix/client/v3/rooms/${encoded(roomId)}/state/m.room.name/`,
        );
        return typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : roomId;
      } catch (error) {
        if (error instanceof MatrixRequestError && error.status === 404) return roomId;
        throw error;
      }
    },
    async getEvent(roomId, eventId) {
      try {
        const payload = await request<unknown>(`/_matrix/client/v3/rooms/${encoded(roomId)}/event/${encoded(eventId)}`);
        return matrixEvent(payload);
      } catch (error) {
        if (error instanceof MatrixRequestError && error.status === 404) return null;
        throw error;
      }
    },
    async sendText(roomId, body, relation, transactionId, formattedBody) {
      const content: Record<string, unknown> = formattedText(body, formattedBody);
      const relatesTo = messageRelation(relation);
      if (relatesTo) content["m.relates_to"] = relatesTo;
      const payload = await request<{ event_id?: unknown }>(
        `/_matrix/client/v3/rooms/${encoded(roomId)}/send/m.room.message/${encoded(transactionId ?? crypto.randomUUID())}`,
        { method: "PUT", body: JSON.stringify(content) },
      );
      if (typeof payload.event_id !== "string") throw new Error("Matrix send response contained no event id");
      return { eventId: payload.event_id };
    },
    async editText(roomId, eventId, body, transactionId, formattedBody) {
      const content = {
        msgtype: "m.text",
        body: `* ${body}`,
        "m.new_content": formattedText(body, formattedBody),
        "m.relates_to": { rel_type: "m.replace", event_id: eventId },
      };
      const payload = await request<{ event_id?: unknown }>(
        `/_matrix/client/v3/rooms/${encoded(roomId)}/send/m.room.message/${encoded(transactionId ?? crypto.randomUUID())}`,
        { method: "PUT", body: JSON.stringify(content) },
      );
      if (typeof payload.event_id !== "string") throw new Error("Matrix edit response contained no event id");
      return { eventId: payload.event_id };
    },
    async downloadMedia(contentUri, policy) {
      const { serverName, mediaId } = parseMxc(contentUri);
      const allowedServers = new Set(policy.allowedServerNames.map((value) => value.toLowerCase()));
      if (!allowedServers.has(serverName)) throw new Error(`Matrix media server ${serverName} is not allowlisted`);
      const response = await fetchImpl(
        `${base}/_matrix/client/v1/media/download/${encoded(serverName)}/${encoded(mediaId)}`,
        {
          headers: authorizationHeaders(),
          redirect: "manual",
          signal: AbortSignal.timeout(300_000),
        },
      );
      if (!response.ok) {
        throw new MatrixRequestError(
          response.status,
          `HTTP_${response.status}`,
          `Matrix media HTTP_${response.status}`,
        );
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
        throw new Error(`Matrix attachment exceeds the ${policy.maxBytes}-byte limit`);
      }
      const mimetype = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const allowedMimeTypes = new Set(policy.allowedMimeTypes.map((value) => value.toLowerCase()));
      if (!mimetype || !allowedMimeTypes.has(mimetype)) {
        throw new Error(`Matrix attachment MIME type ${mimetype || "unknown"} is not allowlisted`);
      }
      if (policy.expectedMimetype && policy.expectedMimetype.toLowerCase() !== mimetype) {
        throw new Error(`Matrix attachment MIME type does not match its event metadata`);
      }
      const bytes = await readBoundedBody(response, policy.maxBytes);
      return { bytes, mimetype };
    },
    async uploadMedia(name, mimetype, bytes) {
      const url = new URL(`${base}/_matrix/media/v3/upload`);
      url.searchParams.set("filename", name);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: authorizationHeaders({ "content-type": mimetype }),
        body: Buffer.from(bytes),
        redirect: "manual",
        signal: AbortSignal.timeout(300_000),
      });
      const text = await response.text();
      const payload: Record<string, unknown> = (() => {
        try {
          return object(text ? JSON.parse(text) : {});
        } catch {
          return {};
        }
      })();
      if (!response.ok) {
        throw new MatrixRequestError(
          response.status,
          `HTTP_${response.status}`,
          `Matrix media upload HTTP_${response.status}`,
        );
      }
      if (typeof payload.content_uri !== "string") throw new Error("Matrix media upload returned no content URI");
      return { contentUri: payload.content_uri };
    },
    async sendFile(roomId, file, relation, transactionId) {
      const content: Record<string, unknown> = {
        msgtype: "m.file",
        body: file.name,
        filename: file.name,
        url: file.contentUri,
        info: { mimetype: file.mimetype, size: file.sizeBytes },
      };
      const relatesTo = messageRelation(relation);
      if (relatesTo) content["m.relates_to"] = relatesTo;
      const payload = await request<{ event_id?: unknown }>(
        `/_matrix/client/v3/rooms/${encoded(roomId)}/send/m.room.message/${encoded(transactionId ?? crypto.randomUUID())}`,
        { method: "PUT", body: JSON.stringify(content) },
      );
      if (typeof payload.event_id !== "string") throw new Error("Matrix file send response contained no event id");
      return { eventId: payload.event_id };
    },
    async sendReaction(roomId, eventId, key, transactionId) {
      const payload = await request<{ event_id?: unknown }>(
        `/_matrix/client/v3/rooms/${encoded(roomId)}/send/m.reaction/${encoded(transactionId ?? crypto.randomUUID())}`,
        {
          method: "PUT",
          body: JSON.stringify({
            "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
          }),
        },
      );
      if (typeof payload.event_id !== "string") throw new Error("Matrix reaction response contained no event id");
      return { eventId: payload.event_id };
    },
  };
}
