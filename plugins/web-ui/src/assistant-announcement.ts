export function formatAssistantCompletionAnnouncement(
  text: string,
  stopReason?: string,
  errorMessage?: string,
): string {
  if (stopReason === "error")
    return errorMessage ? `Assistant reply failed: ${errorMessage}` : "Assistant reply failed.";
  if (stopReason === "aborted") return "Assistant reply stopped.";
  return text.trim() ? `Assistant: ${text.trim()}` : "Assistant reply complete.";
}
