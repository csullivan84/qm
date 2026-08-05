import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const crons = readFileSync(new URL("../src/crons.ts", import.meta.url), "utf8");
const files = readFileSync(new URL("../src/files.ts", import.meta.url), "utf8");
const deploys = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");

test("SPA routes separate deliberate pushes, normalization replacements, and popstate restoration", () => {
  assert.match(shell, /syncUrlFromState\(historyMode\)/);
  assert.match(shell, /switchView\("keychain", "replace", false\)/);
  assert.match(shell, /openSession\(match, entriesPrefetch \?\? undefined, "replace", false\)/);
  assert.match(shell, /window\.addEventListener\("popstate", \(\) => void restoreRouteFromLocation\(\)\)/);
  assert.match(shell, /openSession\(match, undefined, "none", true\)/);
  assert.match(shell, /stored\?\.screen === "conversation"/);
  assert.match(shell, /stored\?\.screen === "split"/);
  assert.match(shell, /screen: navigationScreen\(/);
  assert.match(shell, /sessionsState\.openingKey = null;/);
  assert.match(shell, /if \(sessionId\) \{\s+exitSplitIfActive\(\);\s+switchView\("chats", "none", false\)/);
  assert.match(shell, /if \(mode !== "none"\) cancelPendingRouteRestore\(\)/);
  assert.match(shell, /expectedLocation !== currentNavigationLocation\(\)/);
  assert.match(sessions, /if \(historyMode !== "none"\) cancelPendingRouteRestore\(\)/);
  assert.match(chat, /function newChat\([\s\S]*?sessionsState\.openingKey = null/);
  assert.match(chat, /function mountContinuable\([\s\S]*?sessionsState\.openingKey = null/);
  assert.match(
    shell,
    /navigationScreen\(v, splitState\.active, chatState\.threadRef, chatState\.sessionId\) === "conversation"/,
  );
  assert.doesNotMatch(shell, /v === "chats" && chatState\.host && !splitState\.active/);
  assert.match(chat, /if \(ctx\.ownsUrl\) \{[\s\S]{0,180}?appState\.viewRenderSeq\+\+;/);
  assert.match(sessions, /const stale = \(\) =>[\s\S]*?chatState\.sessionId !== null;/);
  assert.match(sessions, /if \(stale\(\)\) return;\s+drawChatsPage\(\);/);
  assert.match(sessions, /chatState\.sessionId !== null;\s+drawChatsPage\(\);\s+await ensureContexts\(\)/);
  assert.match(shell, /if \(parsed\.view === "app-edit"\) \{\s+prepareAppEditView\(\);/);
  assert.match(shell, /if \(wanted === "app-edit"\) \{\s+prepareAppEditView\(\);/);
  assert.match(
    shell,
    /function prepareAppEditView\(\)[\s\S]*?appState\.currentView = "chats";[\s\S]*?renderSidebarTop\(\);/,
  );
  assert.match(shell, /openAppEditChat\(slug, "none", false\)/);
  assert.doesNotMatch(shell, /if \(currentRoute\.view === "app-edit"\) return;\s+const sessionId = splitState\.active/);
});

test("route changes expose current location, title, announcement, and main focus", () => {
  assert.match(shell, /aria-current=\$\{appState\.currentView === v \? "page" : nothing\}/);
  assert.match(shell, /document\.title = `\$\{label\} · \$\{brandName\(\)\}`/);
  assert.match(shell, /currentRoute\.view === "app-edit"[\s\S]*?`Edit \$\{slug\}`/);
  assert.match(
    chat,
    /function activeConversationTitle\(\): string \{\s+if \(ctx\.ownsUrl\) return navigationLabel\(\);/,
  );
  assert.match(shell, /id="navigation-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(shell, /status\.textContent = `Navigated to \$\{label\}\.`/);
  assert.match(shell, /appState\.mainEl\?\.focus\(\{ preventScroll: true \}\)/);
});

test("new app-edit conversations preserve the caller's history mode", () => {
  const openAppEdit = shell.match(/function openAppEditChat\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(openAppEdit, /mountContinuable\(threadRef, null, null, \[\], null, historyMode, announceNavigation\)/);
});

test("top-level route headings render before cold context requests resolve", () => {
  assert.match(crons, /drawCronsPage\(\);\s+await ensureContexts\(\);\s+if \(seq !== appState\.viewRenderSeq/);
  assert.match(files, /drawFiles\(true\);\s+await ensureContexts\(\);\s+if \(requestSeq !== filesRequestSeq/);
  assert.match(deploys, /drawDeploysPage\(\);\s+await ensureContexts\(\);\s+if \(seq !== appState\.viewRenderSeq/);
});

test("conversation route focus is not overwritten by unconditional composer focus", () => {
  const mount = chat.match(/function mountContinuable\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(mount, /const focusComposer = focusComposerOnMount \|\| !announceRoute/);
  assert.match(mount, /updateNavigationPresentation\(announceRoute, announceRoute && !focusComposer\)/);
  assert.match(mount, /if \(focusComposer\) ctx\.composer\.focusComposerEnd\(\)/);
  const create = chat.match(/function newChat\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(create, /announceRoute,\s+true,\s+\)/);
  assert.doesNotMatch(create, /focusComposerEnd\(\)/);
});

test("active conversation and project renames refresh their heading and document title", () => {
  assert.match(sessions, /refreshActiveConversationPresentation\(\)/);
  assert.match(sessions, /if \(await renameProject\(project, next\)\) refreshActiveConversationPresentation\(\)/);
  assert.match(chat, /function refreshActiveConversationPresentation\(\)/);
  assert.match(chat, /refreshPresentation: refreshActiveConversationPresentation/);
  assert.match(chat, /heading\.textContent = label/);
  assert.match(chat, /updateNavigationPresentation\(\)/);
  assert.match(chat, /readOnlyView = \{ id: s\.id, threadRef: s\.threadRef, session: s, anchorSeq \};\s+const draw/);
  assert.match(chat, /const session = readOnlyView\?\.id === s\.id \? readOnlyView\.session : s/);
  assert.match(chat, /if \(readOnlyView\) \{[\s\S]*?readOnlyView\.session = updated;[\s\S]*?readonlyRedraw\?\.\(\)/);
  const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
  const rename = contexts.match(/export async function renameProject\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(rename, /drawContexts\(\);\s+updateNavigationPresentation\(\);/);
});

test("dragging into the split canvas announces and focuses the pushed destination", () => {
  const activateCanvas = split.match(/function activateCanvas\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(activateCanvas, /syncUrlFromState\("push"\)/);
  assert.match(activateCanvas, /renderList\(\);\s+updateNavigationPresentation\(true, true\);/);
});

test("transcript messages identify their speakers without live token announcements", () => {
  assert.match(chat, /class="message-stack[^"\n]*"[\s\S]{0,120}?aria-live="off"/);
  assert.doesNotMatch(chat, /role="feed"/);
  assert.match(chat, /<span class="sr-only" id=\$\{`message-\$\{index\}-speaker`\}>You<\/span>/);
  assert.match(chat, /<span class="sr-only" id=\$\{`message-\$\{index\}-speaker`\}>Assistant<\/span>/);
  assert.match(chat, /aria-busy=\$\{isStreaming \? "true" : "false"\}/);
  assert.doesNotMatch(chat, /class="chat-scroll"[^>]+aria-live="polite"/);
  assert.doesNotMatch(chat, /class="pane-card" aria-live="polite"/);
});

test("assistant completion is announced once after agent_end and newest reply is keyboard reachable", () => {
  assert.match(chat, /e\.type === "agent_end"\) announceCompletedAssistantReply\(agent\)/);
  assert.match(chat, /id="assistant-reply-status"\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"/);
  assert.match(chat, /assistantCompletionAnnouncement = formatAssistantCompletionAnnouncement\(/);
  assert.match(chat, /class="a11y-jump-latest" type="button" @click=\$\{focusNewestAssistantReply\}/);
  assert.match(chat, /newestReplyControl\(!glanceTier && hasCompletedReply\)/);
  assert.match(chat, /assistantRenderState\(message, false\)\?\.visible === true/);
  assert.match(chat, /\.assistant-row:not\(\.streaming\)/);
  assert.match(chat, /chatState\.host\?\.querySelectorAll<HTMLElement>\("\.assistant-row:not\(\.streaming\)"\)/);
  assert.match(chat, /if \(document\.activeElement !== newest\) focus\(\)/);
});

test("approval continuations announce only a freshly fetched terminal reply", () => {
  const approveCommand = chat.match(/async function approveCommand\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(approveCommand, /const previousReplyKey = assistantReplyKey\(agent\)/);
  assert.match(approveCommand, /assistantCompletionAnnouncement = ""/);
  assert.match(approveCommand, /const refreshed = await refreshTranscriptFromEntries\(agent\)/);
  assert.match(
    approveCommand,
    /if \(refreshed && agent === chatState\.agent\) \{\s+announceCompletedAssistantReply\(agent, previousReplyKey\)/,
  );
  assert.match(chat, /function assistantCompletionKey[\s\S]*?pendingApprovals\?\.length\) return null/);
  assert.match(chat, /catch \{\s+drawActiveChat\(agent\);\s+return false;\s+\}/);
});
