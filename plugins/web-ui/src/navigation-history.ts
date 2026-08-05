export type NavigationHistoryMode = "push" | "replace" | "none";
export type NavigationScreen = "list" | "conversation" | "split";

export interface NavigationHistoryWriter {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function navigationScreen(
  view: string,
  splitActive: boolean,
  threadRef: string | null,
  sessionId: string | null,
): NavigationScreen {
  if (view !== "chats") return "list";
  if (splitActive) return "split";
  return threadRef !== null || sessionId !== null ? "conversation" : "list";
}

export function writeNavigationHistory(
  writer: NavigationHistoryWriter,
  next: string,
  mode: NavigationHistoryMode,
  state: object,
): boolean {
  if (mode === "none") return false;
  if (mode === "push") writer.pushState(state, "", next);
  else writer.replaceState(state, "", next);
  return true;
}
