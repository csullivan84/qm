import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { App } from "../api/app-types.ts";
import { safeAttachmentName } from "../core/attachments.ts";
import type { IngestEvent } from "../surface-cache/types.ts";
import type { IncomingAttachment, TurnRequest, TurnResult } from "../types.ts";
import type { MatrixApprovalMode, MatrixPluginConfig } from "./config.ts";
import {
  createMatrixClient,
  type MatrixClient,
  type MatrixEvent,
  type MatrixMember,
  MatrixRequestError,
  type MatrixRelation,
} from "./client.ts";
import { matrixFormattedBody } from "./format.ts";
import { MatrixSyncLeaseError, matrixSyncIdentityKey, type MatrixSyncStateStore } from "./sync-state.ts";

export type { MatrixEvent };
export type MatrixApi = MatrixClient;

export type MatrixCore = Pick<App, "turn" | "ingestSurfaceEvents" | "readSurfaceMessages" | "getApproval"> & {
  stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }>;
  readBlob(blobId: string): Promise<Buffer>;
};

interface MatrixEventEnvelope {
  roomId: string;
  event: MatrixEvent;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function externalId(config: MatrixPluginConfig, userId: string): string {
  return config.principalMap[userId] ?? userId;
}

function displayName(member: MatrixMember | undefined, userId: string): string {
  if (member?.displayName?.trim()) return member.displayName.trim();
  const local = userId.startsWith("@") ? userId.slice(1).split(":", 1)[0] : userId;
  return local || userId;
}

function leadingMentionPattern(botUserId: string): RegExp {
  const local = botUserId.slice(1).split(":", 1)[0] ?? botUserId;
  const escaped = [botUserId, `@${local}`]
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  return new RegExp(`^\\s*(?:${escaped.join("|")})(?:\\s*[:,;—-]?\\s*)`, "i");
}

function relation(content: Record<string, unknown>): Record<string, unknown> {
  return object(content["m.relates_to"]);
}

function replyEventId(content: Record<string, unknown>): string | undefined {
  const value = object(relation(content)["m.in_reply_to"]).event_id;
  return typeof value === "string" ? value : undefined;
}

function explicitThreadRoot(content: Record<string, unknown>): string | undefined {
  const related = relation(content);
  return related.rel_type === "m.thread" && typeof related.event_id === "string" ? related.event_id : undefined;
}

function mentionsBot(content: Record<string, unknown>, botUserId: string): boolean {
  const ids = object(content["m.mentions"]).user_ids;
  return Array.isArray(ids) && ids.includes(botUserId);
}

function resultBody(result: TurnResult, config: MatrixPluginConfig): string | undefined {
  if (result.pendingApprovals?.length) {
    return result.pendingApprovals
      .map((pending) => {
        const modes = config.approvalModes.filter((mode) => {
          if (mode === "session") return pending.grantModes?.session !== false;
          if (mode === "always") return pending.grantModes?.always !== false;
          return true;
        });
        if (!modes.length) {
          return `Approval required for ${pending.command}\n${pending.reason}\nOpen the QM web interface to review and decide this request. Matrix approval commands are disabled.`;
        }
        const actions = modes.map((mode) => `${mode === "deny" ? "deny" : `allow ${mode}`} ${pending.requestId}`);
        return [
          `Approval required for ${pending.command}`,
          pending.reason,
          "Reply with exactly one permitted action:",
          ...actions,
        ].join("\n");
      })
      .join("\n\n");
  }
  if (result.reply?.trim()) return result.reply.trim();
  if ((result.status === "refused" || result.status === "failed") && result.reason?.trim()) {
    return result.reason.trim();
  }
  return undefined;
}

function formattedBody(config: MatrixPluginConfig, body: string): string | undefined {
  return config.formattedMessages ? matrixFormattedBody(body) : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function matrixCacheTimestamp(originServerTs: number, eventId: string): string {
  const timestamp = Number.isFinite(originServerTs) && originServerTs >= 0 ? Math.floor(originServerTs) : Date.now();
  const seconds = Math.floor(timestamp / 1_000);
  const milliseconds = String(timestamp % 1_000).padStart(3, "0");
  const tieBreaker = (BigInt(`0x${hash(eventId).slice(0, 15)}`) % 1_000_000_000n).toString().padStart(9, "0");
  return `${seconds}.${milliseconds}${tieBreaker}`;
}

function matrixTransactionId(...parts: string[]): string {
  return `qm-${hash(parts.join("\0")).slice(0, 40)}`;
}

function sameMembers(first: MatrixMember[], second: MatrixMember[]): boolean {
  const ids = (members: MatrixMember[]): string =>
    members
      .map((member) => member.userId)
      .sort()
      .join("\0");
  return ids(first) === ids(second);
}

function membersForAudience(config: MatrixPluginConfig, members: MatrixMember[], botUserId: string) {
  const allowed = new Set(config.allowedUserIds);
  return members
    .filter((member) => member.userId !== botUserId && allowed.has(member.userId))
    .map((member) => ({
      externalId: externalId(config, member.userId),
      displayName: displayName(member, member.userId),
    }));
}

function fileMetadata(
  event: MatrixEvent,
): { name: string; contentUri: string; mimetype: string; sizeBytes: number } | null {
  const msgtype = event.content.msgtype;
  if (msgtype !== "m.file" && msgtype !== "m.image" && msgtype !== "m.audio" && msgtype !== "m.video") return null;
  const info = object(event.content.info);
  const nameValue = typeof event.content.filename === "string" ? event.content.filename : event.content.body;
  if (
    typeof nameValue !== "string" ||
    typeof event.content.url !== "string" ||
    typeof info.mimetype !== "string" ||
    !Number.isInteger(info.size) ||
    (info.size as number) < 0
  ) {
    return null;
  }
  return {
    name: safeAttachmentName(nameValue),
    contentUri: event.content.url,
    mimetype: info.mimetype.toLowerCase(),
    sizeBytes: info.size as number,
  };
}

function approvalAction(text: string): { mode: MatrixApprovalMode; requestId: string } | null {
  const match = /^(allow (once|session|always)|deny)\s+([A-Za-z0-9._:-]{1,200})$/i.exec(text.trim());
  if (!match) return null;
  return {
    mode: match[1]!.toLowerCase() === "deny" ? "deny" : (match[2]!.toLowerCase() as MatrixApprovalMode),
    requestId: match[3]!,
  };
}

function storedApprovalRequest(
  value: Awaited<ReturnType<App["getApproval"]>>,
  actorId: string,
  threadRef: string,
): TurnRequest | null {
  const request = value?.request;
  if (!request || request.surface !== "matrix") return null;
  if (request.actor.externalId !== actorId || request.conversation.threadRef !== threadRef) return null;
  return request;
}

function approvalTurn(
  request: TurnRequest,
  event: MatrixEvent,
  actor: TurnRequest["actor"],
  mode: MatrixApprovalMode,
  requestId: string,
): TurnRequest {
  const { approval: _approval, async: _async, idempotencyKey: _idempotencyKey, ...base } = request;
  return {
    ...base,
    actor,
    origin: { kind: "human", messageTs: event.eventId, entryTs: event.eventId },
    triggerTs: event.eventId,
    entryTs: event.eventId,
    liveActor: true,
    addressed: true,
    approval: {
      requestId,
      approved: mode !== "deny",
      ...(mode !== "deny" ? { scope: mode } : {}),
    },
    idempotencyKey: `matrix-approval:${event.eventId}`,
  };
}

export function createMatrixEventHandler(opts: {
  config: MatrixPluginConfig;
  matrix: MatrixApi;
  app: MatrixCore;
  botUserId: string;
  beforeSideEffect?: () => Promise<void>;
}) {
  const allowedRooms = new Set(opts.config.allowedRoomIds);
  const allowedUsers = new Set(opts.config.allowedUserIds);
  const mentionPattern = leadingMentionPattern(opts.botUserId);

  const authorizedMembers = async (roomId: string): Promise<MatrixMember[] | null> => {
    const [members, security] = await Promise.all([
      opts.matrix.joinedMembers(roomId),
      opts.matrix.roomSecurity(roomId),
    ]);
    if (
      security.encrypted ||
      security.joinRule !== "invite" ||
      security.historyVisibility !== "joined" ||
      security.guestAccess !== "forbidden"
    ) {
      return null;
    }
    const participants = new Set(security.participatingUserIds);
    if (!participants.has(opts.botUserId) || !members.some((member) => member.userId === opts.botUserId)) return null;
    if ([...participants].some((userId) => userId !== opts.botUserId && !allowedUsers.has(userId))) return null;
    if (members.some((member) => member.userId !== opts.botUserId && !allowedUsers.has(member.userId))) return null;
    return members;
  };

  const stillAuthorized = async (roomId: string, members: MatrixMember[], eventId: string): Promise<void> => {
    const currentMembers = await authorizedMembers(roomId);
    if (!currentMembers || !sameMembers(members, currentMembers)) {
      throw new Error(`Matrix room authorization changed while processing ${eventId}`);
    }
  };

  const ingestSelf = async (input: {
    roomId: string;
    eventId: string;
    sentAt: number;
    body: string;
    isDirect: boolean;
    threadRoot: string;
    audience: ReturnType<typeof membersForAudience>;
    name: string;
    kind: "dm" | "channel";
    editedAt?: number;
    files?: IngestEvent["files"];
  }): Promise<void> => {
    await opts.beforeSideEffect?.();
    await opts.app.ingestSurfaceEvents(
      [
        {
          container: input.roomId,
          ts: matrixCacheTimestamp(input.sentAt, input.eventId),
          sourceEventId: input.eventId,
          ...(!input.isDirect ? { sub: input.threadRoot } : {}),
          authorId: opts.botUserId,
          authorName: "QM",
          text: input.body,
          self: true,
          bot: true,
          handled: true,
          createdAt: input.sentAt,
          ...(input.editedAt ? { editedAt: input.editedAt } : {}),
          ...(input.files?.length ? { files: input.files } : {}),
          members: input.audience.map((member) => member.externalId),
          containerName: input.name,
          kind: input.kind,
        },
      ],
      "matrix",
      { name: "QM", mentionId: opts.botUserId },
    );
  };

  const deliver = async (input: {
    roomId: string;
    triggerEventId: string;
    targetEventId: string;
    members: MatrixMember[];
    isDirect: boolean;
    threadRoot: string;
    audience: ReturnType<typeof membersForAudience>;
    name: string;
    kind: "dm" | "channel";
    result: TurnResult;
    progressEventId?: string;
  }): Promise<void> => {
    await stillAuthorized(input.roomId, input.members, input.triggerEventId);
    if (opts.config.reactions) {
      for (const key of input.result.reactions ?? []) {
        await opts.beforeSideEffect?.();
        await opts.matrix.sendReaction(
          input.roomId,
          input.targetEventId,
          key,
          matrixTransactionId("reaction", input.roomId, input.targetEventId, key),
        );
      }
    }
    const sendRelation: MatrixRelation | undefined = input.isDirect
      ? undefined
      : { threadRootEventId: input.threadRoot, replyToEventId: input.triggerEventId };
    const attachments = opts.config.attachments.enabled
      ? (input.result.attachments ?? []).slice(0, opts.config.attachments.maxCount)
      : [];
    let body = resultBody(input.result, opts.config);
    if (!body && attachments.length) body = "Completed; attached file(s) below.";
    if (!body && input.progressEventId) body = "Done.";
    if (body && input.progressEventId) {
      await opts.beforeSideEffect?.();
      await opts.matrix.editText(
        input.roomId,
        input.progressEventId,
        body,
        matrixTransactionId("edit", input.roomId, input.progressEventId, input.triggerEventId),
        formattedBody(opts.config, body),
      );
      await ingestSelf({
        ...input,
        eventId: input.progressEventId,
        sentAt: Date.now(),
        body,
        editedAt: Date.now(),
      });
    } else if (body) {
      await opts.beforeSideEffect?.();
      const sent = await opts.matrix.sendText(
        input.roomId,
        body,
        sendRelation,
        matrixTransactionId("reply", input.roomId, input.triggerEventId),
        formattedBody(opts.config, body),
      );
      const sentEvent = await opts.matrix.getEvent(input.roomId, sent.eventId);
      await ingestSelf({
        ...input,
        eventId: sent.eventId,
        sentAt: sentEvent?.originServerTs ?? Date.now(),
        body,
      });
    }
    for (const attachment of attachments) {
      if (
        attachment.sizeBytes > opts.config.attachments.maxBytes ||
        !opts.config.attachments.allowedMimeTypes.includes(attachment.mimetype.toLowerCase())
      ) {
        throw new Error(`Matrix outbound attachment ${attachment.name} violates the configured attachment policy`);
      }
      const bytes = await opts.app.readBlob(attachment.blobId);
      if (bytes.length !== attachment.sizeBytes || bytes.length > opts.config.attachments.maxBytes) {
        throw new Error(`Matrix outbound attachment ${attachment.name} failed its byte-count check`);
      }
      const name = safeAttachmentName(attachment.name);
      await opts.beforeSideEffect?.();
      const upload = await opts.matrix.uploadMedia(name, attachment.mimetype, bytes);
      await opts.beforeSideEffect?.();
      const sent = await opts.matrix.sendFile(
        input.roomId,
        {
          name,
          mimetype: attachment.mimetype,
          sizeBytes: attachment.sizeBytes,
          contentUri: upload.contentUri,
        },
        sendRelation,
        matrixTransactionId("file", input.roomId, input.triggerEventId, attachment.blobId),
      );
      await ingestSelf({
        ...input,
        eventId: sent.eventId,
        sentAt: Date.now(),
        body: name,
        files: [{ fileId: upload.contentUri, name, mimetype: attachment.mimetype }],
      });
    }
  };

  const handleReaction = async (
    roomId: string,
    event: MatrixEvent,
    members: MatrixMember[],
    sender: MatrixMember,
  ): Promise<void> => {
    if (!opts.config.reactions) return;
    const related = relation(event.content);
    if (
      related.rel_type !== "m.annotation" ||
      typeof related.event_id !== "string" ||
      typeof related.key !== "string" ||
      !related.key.trim()
    ) {
      return;
    }
    const target = await opts.matrix.getEvent(roomId, related.event_id);
    if (!target || target.sender === event.sender) return;
    const audience = membersForAudience(opts.config, members, opts.botUserId);
    const isDirect = members.length === 2 && audience.length === 1;
    const targetParentId = replyEventId(target.content);
    const targetParent = targetParentId ? await opts.matrix.getEvent(roomId, targetParentId) : null;
    const threadRoot =
      explicitThreadRoot(target.content) ??
      (targetParent ? (explicitThreadRoot(targetParent.content) ?? targetParent.eventId) : undefined) ??
      target.eventId;
    const stake = isDirect
      ? true
      : target.sender === opts.botUserId ||
        (await opts.app.readSurfaceMessages(roomId, { sub: threadRoot, limit: 200 })).some((message) => message.self);
    if (!stake) return;
    const name = await opts.matrix.roomName(roomId);
    const kind = isDirect ? "dm" : "channel";
    const mappedSender = externalId(opts.config, event.sender);
    const actorName = displayName(sender, event.sender);
    const targetBody = typeof target.content.body === "string" ? target.content.body.trim().slice(0, 240) : "a message";
    const text = `${actorName} reacted ${related.key} to: ${targetBody}`;
    await opts.beforeSideEffect?.();
    await opts.app.ingestSurfaceEvents(
      [
        {
          container: roomId,
          ts: matrixCacheTimestamp(event.originServerTs, event.eventId),
          sourceEventId: event.eventId,
          ...(!isDirect ? { sub: threadRoot } : {}),
          authorId: mappedSender,
          authorName: actorName,
          text,
          handled: true,
          createdAt: event.originServerTs,
          members: audience.map((member) => member.externalId),
          containerName: name,
          kind,
        },
      ],
      "matrix",
      { name: "QM", mentionId: opts.botUserId },
    );
    await opts.beforeSideEffect?.();
    const result = await opts.app.turn({
      surface: "matrix",
      actor: { externalId: mappedSender, displayName: actorName },
      conversation: {
        kind,
        threadRef: isDirect ? `matrix:${roomId}` : `matrix:${roomId}:${threadRoot}`,
        ...(!isDirect ? { channelRef: roomId } : {}),
        channelName: name,
        audience,
        isPrivate: true,
      },
      text,
      origin: { kind: "ambient", entryTs: event.eventId, live: true },
      entryTs: event.eventId,
      unprompted: true,
      liveActor: true,
      addressed: false,
      idempotencyKey: `matrix-reaction:${event.eventId}`,
    });
    if (result.status === "silent") return;
    await deliver({
      roomId,
      triggerEventId: event.eventId,
      targetEventId: target.eventId,
      members,
      isDirect,
      threadRoot,
      audience,
      name,
      kind,
      result,
    });
  };

  return async ({ roomId, event }: MatrixEventEnvelope): Promise<void> => {
    if (!allowedRooms.has(roomId) || event.sender === opts.botUserId || !allowedUsers.has(event.sender)) return;
    if (event.type === "m.room.encrypted") return;
    const members = await authorizedMembers(roomId);
    if (!members) return;
    const sender = members.find((member) => member.userId === event.sender);
    if (!sender) return;
    if (event.type === "m.room.redaction") {
      if (!event.redacts) return;
      await opts.beforeSideEffect?.();
      await opts.app.ingestSurfaceEvents(
        [
          {
            container: roomId,
            ts: matrixCacheTimestamp(event.originServerTs, event.eventId),
            sourceEventId: event.redacts,
            deleted: true,
            createdAt: event.originServerTs,
          },
        ],
        "matrix",
        { name: "QM", mentionId: opts.botUserId },
      );
      return;
    }
    if (event.type === "m.reaction") return handleReaction(roomId, event, members, sender);
    if (event.type !== "m.room.message" || relation(event.content).rel_type === "m.replace") return;
    const file = fileMetadata(event);
    if (!file && (event.content.msgtype !== "m.text" || typeof event.content.body !== "string")) return;

    const audience = membersForAudience(opts.config, members, opts.botUserId);
    const isDirect = members.length === 2 && audience.length === 1;
    const name = await opts.matrix.roomName(roomId);
    const parentId = replyEventId(event.content);
    const parent = parentId ? await opts.matrix.getEvent(roomId, parentId) : null;
    const threadRoot =
      explicitThreadRoot(event.content) ??
      (parent ? (explicitThreadRoot(parent.content) ?? parent.eventId) : undefined) ??
      event.eventId;
    const bodyText = typeof event.content.body === "string" ? event.content.body : "";
    const directlyAddressed =
      isDirect ||
      mentionsBot(event.content, opts.botUserId) ||
      bodyText.includes(opts.botUserId) ||
      parent?.sender === opts.botUserId;
    const threaded = Boolean(explicitThreadRoot(event.content) || parent);
    const followed =
      !directlyAddressed &&
      !isDirect &&
      threaded &&
      opts.config.followThreads &&
      (await opts.app.readSurfaceMessages(roomId, { sub: threadRoot, limit: 200 })).some((message) => message.self);
    const mappedSender = externalId(opts.config, event.sender);
    const kind = isDirect ? "dm" : "channel";
    const incoming: IngestEvent = {
      container: roomId,
      ts: matrixCacheTimestamp(event.originServerTs, event.eventId),
      sourceEventId: event.eventId,
      ...(!isDirect ? { sub: threadRoot } : {}),
      authorId: mappedSender,
      authorName: displayName(sender, event.sender),
      text: bodyText,
      mentionsSelf: directlyAddressed,
      handled: true,
      createdAt: event.originServerTs,
      ...(file ? { files: [{ fileId: file.contentUri, name: file.name, mimetype: file.mimetype }] } : {}),
      members: audience.map((member) => member.externalId),
      containerName: name,
      kind,
    };
    await opts.beforeSideEffect?.();
    await opts.app.ingestSurfaceEvents([incoming], "matrix", {
      name: "QM",
      mentionId: opts.botUserId,
    });
    if (!directlyAddressed && !followed) return;

    const attachments: IncomingAttachment[] = [];
    const inboundNotes: string[] = [];
    if (file) {
      if (!opts.config.attachments.enabled) {
        inboundNotes.push(`skipped ${file.name} because Matrix attachments are disabled`);
      } else if (file.sizeBytes > opts.config.attachments.maxBytes) {
        inboundNotes.push(`skipped ${file.name} because it exceeds the configured Matrix attachment limit`);
      } else if (!opts.config.attachments.allowedMimeTypes.includes(file.mimetype)) {
        inboundNotes.push(`skipped ${file.name} because its MIME type is not allowed`);
      } else {
        try {
          const downloaded = await opts.matrix.downloadMedia(file.contentUri, {
            maxBytes: opts.config.attachments.maxBytes,
            allowedServerNames: opts.config.attachments.allowedMediaServerNames,
            allowedMimeTypes: opts.config.attachments.allowedMimeTypes,
            expectedMimetype: file.mimetype,
          });
          if (downloaded.bytes.length !== file.sizeBytes)
            throw new Error("downloaded byte count did not match event metadata");
          await opts.beforeSideEffect?.();
          const staged = await opts.app.stageBlob(downloaded.bytes);
          attachments.push({
            name: file.name,
            mimetype: downloaded.mimetype,
            sizeBytes: downloaded.bytes.length,
            blobId: staged.blobId,
            sourceId: file.contentUri,
            author: displayName(sender, event.sender),
          });
        } catch (error) {
          inboundNotes.push(`could not read ${file.name}: ${(error as Error).message}`);
        }
      }
    }

    const text = bodyText.replace(mentionPattern, "").trim();
    if (!text && !attachments.length) return;
    const actor = { externalId: mappedSender, displayName: displayName(sender, event.sender) };
    const threadRef = isDirect ? `matrix:${roomId}` : `matrix:${roomId}:${threadRoot}`;
    const action = approvalAction(text);
    let request: TurnRequest;
    if (action) {
      if (!opts.config.approvalModes.includes(action.mode)) {
        const result: TurnResult = {
          status: "refused",
          reason: "That Matrix approval action is disabled. Use the authenticated QM web interface.",
        };
        return deliver({
          roomId,
          triggerEventId: event.eventId,
          targetEventId: event.eventId,
          members,
          isDirect,
          threadRoot,
          audience,
          name,
          kind,
          result,
        });
      }
      const stored = await opts.app.getApproval(action.requestId, mappedSender);
      const original = storedApprovalRequest(stored, mappedSender, threadRef);
      const modeAllowed =
        action.mode !== "session"
          ? action.mode !== "always" || stored?.grantModes?.always !== false
          : stored?.grantModes?.session !== false;
      if (!original || !modeAllowed) {
        const result: TurnResult = {
          status: "refused",
          reason: "That approval is expired, belongs to another requester or thread, or does not allow that mode.",
        };
        return deliver({
          roomId,
          triggerEventId: event.eventId,
          targetEventId: event.eventId,
          members,
          isDirect,
          threadRoot,
          audience,
          name,
          kind,
          result,
        });
      }
      request = approvalTurn(original, event, actor, action.mode, action.requestId);
    } else {
      request = {
        surface: "matrix",
        actor,
        conversation: {
          kind,
          threadRef,
          ...(!isDirect ? { channelRef: roomId } : {}),
          channelName: name,
          audience,
          isPrivate: true,
        },
        text,
        origin: followed
          ? { kind: "ambient", entryTs: event.eventId, live: true }
          : { kind: "human", messageTs: event.eventId, entryTs: event.eventId },
        ...(followed ? { unprompted: true, liveActor: true } : { triggerTs: event.eventId }),
        entryTs: event.eventId,
        ...(attachments.length ? { attachments } : {}),
        ...(inboundNotes.length ? { inboundNotes } : {}),
        addressed: directlyAddressed,
        idempotencyKey: `matrix:${event.eventId}`,
      };
    }
    const sendRelation: MatrixRelation | undefined = isDirect
      ? undefined
      : { threadRootEventId: threadRoot, replyToEventId: event.eventId };
    let progressEventId: string | undefined;
    if (opts.config.deliveryMode === "edits" && !followed) {
      await opts.beforeSideEffect?.();
      const progress = await opts.matrix.sendText(
        roomId,
        "Working…",
        sendRelation,
        matrixTransactionId("progress", roomId, event.eventId),
        formattedBody(opts.config, "Working…"),
      );
      progressEventId = progress.eventId;
      await ingestSelf({
        roomId,
        eventId: progress.eventId,
        sentAt: Date.now(),
        body: "Working…",
        isDirect,
        threadRoot,
        audience,
        name,
        kind,
      });
    }
    await opts.beforeSideEffect?.();
    const result = await opts.app.turn(request);
    if (result.steered) return;
    await deliver({
      roomId,
      triggerEventId: event.eventId,
      targetEventId: event.eventId,
      members,
      isDirect,
      threadRoot,
      audience,
      name,
      kind,
      result,
      ...(progressEventId ? { progressEventId } : {}),
    });
  };
}

async function readCursor(path: string): Promise<string | null> {
  try {
    const cursor = (await readFile(path, "utf8")).trim();
    return cursor || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeCursor(path: string, cursor: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${cursor}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface MatrixInstallationFence {
  acquire(token: string, expiresAt: number): Promise<boolean>;
  renew(token: string, expiresAt: number): Promise<boolean>;
  release(token: string): Promise<void>;
}

class MatrixInstallationFenceError extends Error {}

const MATRIX_PROCESSING_LEASE_TTL_MS = 30_000;

export async function startMatrixPlugin(
  config: MatrixPluginConfig,
  app: MatrixCore,
  fetchImpl: typeof fetch = fetch,
  syncState?: MatrixSyncStateStore,
  syncGeneration?: string,
  installationFence?: MatrixInstallationFence,
): Promise<{ stop(): Promise<void>; done: Promise<void> }> {
  const matrix = createMatrixClient(config, fetchImpl);
  const identity = await matrix.whoAmI();
  const controller = new AbortController();
  const syncStateId = matrixSyncIdentityKey(config.homeserverUrl, identity.userId, syncGeneration);
  const cursorPath = `${config.syncCursorPath}.${syncStateId.slice("matrix:".length)}`;
  const leaseTtlMs = Math.max(90_000, config.syncTimeoutMs * 3);
  const claim = syncState
    ? await syncState.claim(syncStateId, `${process.pid}:${randomUUID()}`, leaseTtlMs)
    : undefined;
  if (syncState && !claim) throw new MatrixSyncLeaseError("Another Matrix sync consumer holds the active lease");
  const leaseToken = claim?.token;
  let cursor: string;
  try {
    const storedCursor = syncState ? await syncState.cursor(syncStateId, leaseToken!) : await readCursor(cursorPath);
    if (storedCursor) {
      cursor = storedCursor;
    } else {
      const initial = await matrix.sync(undefined, 0, controller.signal);
      cursor = initial.nextBatch;
      if (syncState) await syncState.advance(syncStateId, leaseToken!, cursor, leaseTtlMs);
      else await writeCursor(cursorPath, cursor);
    }
  } catch (error) {
    controller.abort();
    if (syncState && leaseToken) await syncState.release(syncStateId, leaseToken);
    throw error;
  }
  let stopped = false;
  let terminalError: unknown;
  let retryMs = 1_000;
  let currentSideEffectFence: (() => Promise<void>) | undefined;
  const handle = createMatrixEventHandler({
    config,
    matrix,
    app,
    botUserId: identity.userId,
    beforeSideEffect: async () => currentSideEffectFence?.(),
  });
  let heartbeat = Promise.resolve();
  const heartbeatTimer = syncState
    ? setInterval(
        () => {
          heartbeat = heartbeat
            .then(async () => {
              if (!stopped) await syncState.heartbeat(syncStateId, leaseToken!, leaseTtlMs);
            })
            .catch((error) => {
              if (stopped) return;
              terminalError = error;
              stopped = true;
              controller.abort();
              console.error("[matrix-plugin] durable sync lease failed:", error);
            });
        },
        Math.floor(leaseTtlMs / 3),
      )
    : undefined;
  heartbeatTimer?.unref();

  const loop = async (): Promise<void> => {
    syncLoop: while (!stopped) {
      try {
        const next = await matrix.sync(cursor, config.syncTimeoutMs, controller.signal);
        const limited = next.joinedRooms.find((room) => room.limited);
        if (limited) throw new Error(`Matrix sync timeline for ${limited.roomId} is limited; cursor not advanced`);
        for (const room of next.joinedRooms) {
          for (const event of room.events) {
            if (!installationFence) {
              await handle({ roomId: room.roomId, event });
              continue;
            }
            const processingToken = randomUUID();
            const acquired = await installationFence.acquire(
              processingToken,
              Date.now() + MATRIX_PROCESSING_LEASE_TTL_MS,
            );
            if (!acquired) {
              stopped = true;
              controller.abort();
              break syncLoop;
            }
            let fenceFailure: unknown;
            let renewal = Promise.resolve();
            const renew = async (): Promise<void> => {
              renewal = renewal
                .then(async () => {
                  if (fenceFailure) return;
                  const renewed = await installationFence.renew(
                    processingToken,
                    Date.now() + MATRIX_PROCESSING_LEASE_TTL_MS,
                  );
                  if (!renewed) throw new MatrixInstallationFenceError("Matrix installation processing lease was lost");
                })
                .catch((error) => {
                  fenceFailure =
                    error instanceof MatrixInstallationFenceError
                      ? error
                      : new MatrixInstallationFenceError("Matrix installation processing lease renewal failed", {
                          cause: error,
                        });
                });
              await renewal;
              if (fenceFailure) throw fenceFailure;
            };
            currentSideEffectFence = renew;
            const processingHeartbeat = setInterval(() => void renew().catch(() => undefined), 10_000);
            processingHeartbeat.unref();
            let processingFailure: unknown;
            try {
              await handle({ roomId: room.roomId, event });
              await renew();
            } catch (error) {
              processingFailure = error;
            } finally {
              clearInterval(processingHeartbeat);
              currentSideEffectFence = undefined;
              await renewal;
              try {
                await installationFence.release(processingToken);
              } catch (error) {
                if (!processingFailure) {
                  processingFailure = new MatrixInstallationFenceError(
                    "Matrix installation processing lease release failed",
                    {
                      cause: error,
                    },
                  );
                }
              }
            }
            if (processingFailure) throw processingFailure;
          }
        }
        if (syncState) await syncState.advance(syncStateId, leaseToken!, next.nextBatch, leaseTtlMs);
        else await writeCursor(cursorPath, next.nextBatch);
        cursor = next.nextBatch;
        retryMs = 1_000;
      } catch (error) {
        if (stopped || controller.signal.aborted) break;
        let failure = error;
        if (error instanceof MatrixRequestError && error.errcode === "M_UNKNOWN_POS") {
          try {
            const baseline = await matrix.sync(undefined, 0, controller.signal);
            if (syncState) await syncState.advance(syncStateId, leaseToken!, baseline.nextBatch, leaseTtlMs);
            else await writeCursor(cursorPath, baseline.nextBatch);
            cursor = baseline.nextBatch;
            retryMs = 1_000;
            console.warn("[matrix-plugin] expired sync cursor replaced with a fresh baseline");
            continue;
          } catch (baselineError) {
            failure = baselineError;
          }
        }
        if (failure instanceof MatrixSyncLeaseError || failure instanceof MatrixInstallationFenceError) {
          terminalError = failure;
          stopped = true;
          controller.abort();
          console.error("[matrix-plugin] durable sync lease lost:", failure);
          break;
        }
        console.error("[matrix-plugin] sync failed:", failure);
        await wait(retryMs, controller.signal);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  };

  const done = loop()
    .finally(async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeat;
      if (syncState && leaseToken) await syncState.release(syncStateId, leaseToken);
    })
    .then(() => {
      if (terminalError) throw terminalError;
    });
  console.log(`[matrix-plugin] connected as ${identity.userId}`);
  return {
    async stop() {
      stopped = true;
      controller.abort();
      await done.catch((error) => {
        if (!terminalError) throw error;
      });
    },
    done,
  };
}
