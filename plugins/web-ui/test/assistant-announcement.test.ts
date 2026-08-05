import assert from "node:assert/strict";
import test from "node:test";
import { formatAssistantCompletionAnnouncement } from "../src/assistant-announcement.ts";

test("successful assistant replies are announced once with their speaker", () => {
  assert.equal(formatAssistantCompletionAnnouncement(" Answer ", "stop"), "Assistant: Answer");
  assert.equal(formatAssistantCompletionAnnouncement("", "stop"), "Assistant reply complete.");
});

test("errors and aborted replies announce terminal state before partial text", () => {
  assert.equal(
    formatAssistantCompletionAnnouncement("Partial answer", "error", "Connection lost"),
    "Assistant reply failed: Connection lost",
  );
  assert.equal(formatAssistantCompletionAnnouncement("Partial answer", "aborted"), "Assistant reply stopped.");
  assert.equal(formatAssistantCompletionAnnouncement("", "aborted"), "Assistant reply stopped.");
});
