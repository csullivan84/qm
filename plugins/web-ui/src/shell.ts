import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowLeft,
  Box,
  Brain,
  ChevronDown,
  Clock,
  Files,
  Folder,
  KeyRound,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Rocket,
  type IconNode,
} from "lucide";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
  api,
  fetchRuntimeConfig,
  fetchTranscript,
  setSigninRequiredHandler,
  type SigninRequired,
  TAIL_TURNS,
  withBase,
} from "./core-bridge";
import { applyRuntimeOptions } from "./model-options";
import { errMessage, swallow } from "../../chassis/src/errors";
import { brandMark, brandName, icon, initials } from "./ui";
import { markConnectorConnected } from "./chat";
import { clearSkillsCache, resyncModelSelection, seedRuntimeConfig } from "./composer";
import { ensureDeliveryStream, mainConversation, onExitCanvas } from "./conversations";
import { clearAllDrafts, saveDraft, storedDraft } from "./drafts";
import { deepLinkPath, parseDeepLink, UI_BASE } from "./deep-link";
import {
  addBlankPane,
  canvasToast,
  drawCanvas,
  exitSplitIfActive,
  loadPersistedSplit,
  mountRestoredCanvas,
  restoredCanvasNeedsSessionList,
  splitState,
} from "./split";
import { activityOf } from "./session-list";
import { replaceChildrenPreservingFocus } from "./pane-focus";
import { restoreActiveModalBackgrounds, trapDialogFocus } from "./dialog-focus";
import {
  openSession,
  closeOpenSessionMenu,
  refreshSessions,
  renderChatsPage,
  renderList,
  resetSessionsState,
  sessionTitle,
  sessionsState,
  toggleWebOnly,
} from "./sessions";
import { openCronById, renderCronsPage, resetActiveCron, routeCronsHistory } from "./crons";
import { renderFiles } from "./files";
import { clearConnectorNotice, noteConnectorResult, renderConnectors, resetKeychainState } from "./connectors";
import { renderDeploys } from "./deploys";
import { dismissMemoryConfirmation, renderMemory, resetMemoryState } from "./memory";
import { renderSkills } from "./skills";
import {
  contextsState,
  ensureContexts,
  renderContexts,
  resetContextsState,
  resolveProjectScope,
  selectContext,
} from "./contexts";
import { appState, isView, type AuthMode, type Me, type View } from "./shell-state";
import {
  navigationScreen,
  writeNavigationHistory,
  type NavigationHistoryMode,
  type NavigationScreen,
} from "./navigation-history";
export { appState, can, type Me, type View } from "./shell-state";

let authMode: AuthMode = "portal";
let shellMounted = false;

setSigninRequiredHandler((detail) => {
  authMode = detail.mode ?? authMode;
  renderAuthGate(gateFor(authMode, detail.reason));
});

onExitCanvas(() => exitSplitIfActive());

export const ADMIN_BASE = (() => {
  const base = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");
  return base ? base.replace(/\/[^/]+$/, "/admin") : "/admin";
})();
export const ADMIN_HOME_URL = `${ADMIN_BASE}/`;

export function adminSessionLogUrl(sessionId: string, scopeId: string): string {
  const q = new URLSearchParams({ view: "history", scope: scopeId, session: sessionId });
  return `${ADMIN_BASE}/?${q.toString()}`;
}
export function syncUrlFromState(mode: NavigationHistoryMode = "replace"): void {
  if (mode !== "none") cancelPendingRouteRestore();
  const chatState = mainConversation().state;
  const sessionId = splitState.active ? null : (chatState.sessionId ?? chatState.rememberedSessionId);
  const next = deepLinkPath(UI_BASE, appState.currentView, sessionId, contextsState.selected);
  writeNavigationHistory(history, next, mode, navigationHistoryState());
}

interface QmNavigationState {
  qm: true;
  view: View;
  screen: NavigationScreen;
  sessionId: string | null;
  threadRef: string | null;
  scopeId: string | null;
  contextName: string | null;
  contextScope: string | null;
}

function navigationHistoryState(): QmNavigationState {
  const chatState = mainConversation().state;
  return {
    qm: true,
    view: appState.currentView,
    screen: navigationScreen(appState.currentView, splitState.active, chatState.threadRef, chatState.sessionId),
    sessionId: chatState.sessionId,
    threadRef: chatState.threadRef,
    scopeId: chatState.scopeId,
    contextName: chatState.contextName,
    contextScope: contextsState.selected,
  };
}

const VIEW_TITLES: Record<View, string> = {
  chats: "Chats",
  contexts: "Projects",
  files: "Files",
  keychain: "Keychain",
  deploys: "Apps",
  crons: "Crons",
  memory: "Memory",
  skills: "Skills",
};

export function navigationLabel(): string {
  const chatState = mainConversation().state;
  const currentRoute = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (currentRoute.view === "app-edit") {
    const slug = new URLSearchParams(location.search).get("slug")?.toLowerCase() ?? "";
    return /^[a-z0-9-]{1,63}$/.test(slug) ? `Edit ${slug}` : "Edit app";
  }
  if (appState.currentView === "contexts" && contextsState.selected) {
    const context = contextsState.list.find((candidate) => candidate.scopeId === contextsState.selected);
    return context?.project?.name ?? context?.name ?? "Project details";
  }
  if (appState.currentView !== "chats") return VIEW_TITLES[appState.currentView];
  if (splitState.active) return "Conversations";
  const session = sessionsState.list.find(
    (candidate) =>
      (chatState.sessionId && candidate.id === chatState.sessionId) ||
      (chatState.threadRef && candidate.threadRef === chatState.threadRef),
  );
  if (session) return sessionTitle(session);
  if (chatState.host) return chatState.contextName ? `New chat in ${chatState.contextName}` : "New chat";
  return "Chats";
}

export function updateNavigationPresentation(announce = false, moveFocus = announce): void {
  const label = navigationLabel();
  document.title = `${label} · ${brandName()}`;
  if (announce) {
    const status = (appEl as HTMLElement).querySelector<HTMLElement>("#navigation-status");
    if (status) {
      status.textContent = "";
      requestAnimationFrame(() => {
        status.textContent = `Navigated to ${label}.`;
      });
    }
  }
  if (moveFocus) requestAnimationFrame(() => appState.mainEl?.focus({ preventScroll: true }));
}

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app");

const narrowViewport = window.matchMedia("(max-width: 860px)");
let sidebarOpen = !narrowViewport.matches;

const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_DEFAULT_W = 280;
const SIDEBAR_W_KEY = "webui:sidebar-w";

function savedSidebarWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  return Number.isFinite(saved) && saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W
    ? Math.round(saved)
    : SIDEBAR_DEFAULT_W;
}

function syncSidebarResizeValue(width: number): void {
  const handle = (appEl as HTMLElement).querySelector<HTMLElement>(".sidebar-resize-handle");
  handle?.setAttribute("aria-valuenow", String(Math.round(width)));
  handle?.setAttribute("aria-valuetext", `${Math.round(width)} pixels wide`);
}

function applySidebarWidth(width: number, persist: boolean): number {
  const next = Math.round(Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, width)));
  document.documentElement.style.setProperty("--sidebar-w", `${next}px`);
  syncSidebarResizeValue(next);
  if (persist) localStorage.setItem(SIDEBAR_W_KEY, String(next));
  return next;
}

function applySavedSidebarWidth(): void {
  const width = savedSidebarWidth();
  if (width !== SIDEBAR_DEFAULT_W) document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
}

function startSidebarResize(e: PointerEvent): void {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const sidebar = (appEl as HTMLElement).querySelector<HTMLElement>(".sidebar");
  if (!sidebar) return;
  const startW = sidebar.getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
  let w = startW;
  const onMove = (ev: PointerEvent) => {
    w = applySidebarWidth(startW + (ev.clientX - startX), false);
  };
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("lostpointercapture", onUp);
    document.body.classList.remove("resizing-sidebar");
    applySidebarWidth(w, true);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("lostpointercapture", onUp);
}

function resetSidebarWidth(): void {
  document.documentElement.style.removeProperty("--sidebar-w");
  localStorage.removeItem(SIDEBAR_W_KEY);
  syncSidebarResizeValue(SIDEBAR_DEFAULT_W);
}

function resizeSidebarWithKeyboard(e: KeyboardEvent): void {
  const step = e.shiftKey ? 40 : 10;
  const current = savedSidebarWidth();
  let next: number | null = null;
  if (e.key === "ArrowLeft") next = current - step;
  else if (e.key === "ArrowRight") next = current + step;
  else if (e.key === "Home") next = SIDEBAR_MIN_W;
  else if (e.key === "End") next = SIDEBAR_MAX_W;
  if (next === null) return;
  e.preventDefault();
  applySidebarWidth(next, true);
}

function syncThemeToggleAccessibility(): void {
  const toggle = (appEl as HTMLElement).querySelector<HTMLElement>("theme-toggle");
  const button = toggle?.querySelector<HTMLButtonElement>("button");
  if (!toggle || !button) return;
  const update = () => {
    const theme = localStorage.getItem("theme") ?? "system";
    const label = `Change color theme. Current setting: ${theme}.`;
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  update();
  if (toggle.dataset.accessibleThemeToggle === "true") return;
  toggle.dataset.accessibleThemeToggle = "true";
  button.addEventListener("click", () => requestAnimationFrame(update));
}

const NAV_WORKSPACE_KEY = "web-ui:nav-workspace";

function loadNavOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function saveNavOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    void 0;
  }
}

let navWorkspaceOpen = loadNavOpen(NAV_WORKSPACE_KEY);

function toggleNavWorkspace(): void {
  navWorkspaceOpen = !navWorkspaceOpen;
  saveNavOpen(NAV_WORKSPACE_KEY, navWorkspaceOpen);
  renderSidebarTop();
}

const ICON = {
  newChat: Plus,
  chats: MessageSquare,
  contexts: Folder,
  files: Files,
  keychain: KeyRound,
  deploys: Rocket,
  crons: Clock,
  memory: Brain,
  skills: Box,
};

export async function signOut(): Promise<void> {
  const portal = authMode === "portal";
  if (!portal) {
    try {
      await api("/signout", { method: "POST" });
    } catch {
      void 0;
    }
  }
  appState.me = null;
  clearAllDrafts();
  exitSplitIfActive();
  mainConversation().resetChatState();
  resetSessionsState();
  appState.currentView = "chats";
  clearSkillsCache();
  resetMemoryState();
  resetContextsState();
  resetKeychainState();
  mainConversation().composer.resetComposer();
  if (!portal) {
    renderAuthGate({ kind: "dev" });
    return;
  }
  let endedSession: boolean;
  try {
    const r = await fetch("/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    endedSession = r.ok;
  } catch {
    endedSession = false;
  }
  if (!endedSession) {
    renderAuthGate({ kind: "portal" });
    return;
  }
  clearPortalAttempt();
  location.href = "/";
}

export async function exitImpersonation(): Promise<void> {
  try {
    await fetch("/auth/impersonate/stop", { method: "POST", headers: { accept: "application/json" } });
  } catch {
    void 0;
  }
  window.location.href = ADMIN_HOME_URL;
}

function impersonationBanner(by: string) {
  return html`
    <div class="top-banner" role="status">
      <span>Viewing the assistant as <b>${appState.me?.user ?? ""}</b> — you are <b>${by}</b></span>
      <button class="top-banner-action" type="button" @click=${exitImpersonation}>Exit impersonation</button>
    </div>
  `;
}

function devBanner(user: string) {
  return html`
    <div class="top-banner dev" role="status">
      <span><b>Dev mode</b> — no identity provider, signed in as ${user}</span>
      <button class="top-banner-action" type="button" @click=${signOut}>Sign out</button>
    </div>
  `;
}

function gateShell(body: unknown) {
  return html`
    <main class="signin" id="main" tabindex="-1">
      <div class="signin-panel">
        <div class="signin-brand">
          ${brandMark()}<span>${brandName()}</span>
          ${authMode === "dev" ? html`<span class="dev-chip">DEV</span>` : nothing}
        </div>
        ${body}
      </div>
    </main>
  `;
}

const PORTAL_ATTEMPT_KEY = "qm.portal.signin.attempt";
const PORTAL_ATTEMPT_WINDOW_MS = 20_000;

function portalAttemptedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(PORTAL_ATTEMPT_KEY) ?? "");
    return Number.isFinite(at) && Date.now() - at < PORTAL_ATTEMPT_WINDOW_MS;
  } catch {
    return false;
  }
}

function signInWithPortal(): void {
  try {
    sessionStorage.setItem(PORTAL_ATTEMPT_KEY, String(Date.now()));
  } catch {
    void 0;
  }
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function clearPortalAttempt(): void {
  try {
    sessionStorage.removeItem(PORTAL_ATTEMPT_KEY);
  } catch {
    void 0;
  }
}

function portalGate() {
  if (portalAttemptedRecently())
    return gateShell(html`
      <h1>Sign in through the portal</h1>
      <p class="signin-body">
        This surface is reached through the portal, and signing in there didn't produce a session for it. Open the
        portal address directly rather than this one.
      </p>
      <div class="hint">
        If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.
      </div>
    `);
  return gateShell(html`
    <h1>Your session ended</h1>
    <p class="signin-body">You've been signed out. Sign in again and you'll come back to this page.</p>
    <button class="btn primary" type="button" @click=${signInWithPortal}>Sign in</button>
  `);
}

function deniedGate() {
  return gateShell(html`
    <h1>You don't have access</h1>
    <p class="signin-body">
      Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.
    </p>
    <button class="btn" type="button" @click=${signOut}>Sign out</button>
    ${
      authMode === "dev"
        ? html`<div class="hint">This instance lists its principals in <b>WEB_UI_PRINCIPALS</b>.</div>`
        : nothing
    }
  `);
}

function retryBoot(): void {
  void bootSafely();
}

function unreachableGate() {
  return gateShell(html`
    <h1>We couldn't reach the assistant</h1>
    <p class="signin-body">The service didn't respond. This is usually temporary.</p>
    <button class="btn primary" type="button" @click=${retryBoot}>Try again</button>
    <div class="hint">If this keeps happening, the core service may be down.</div>
  `);
}

async function submitDevSignin(user: string): Promise<void> {
  renderAuthGate({ kind: "dev", value: user, pending: true });
  try {
    await api("/signin", { method: "POST", body: JSON.stringify({ user }) });
  } catch (err) {
    renderAuthGate({ kind: "dev", value: user, error: errMessage(err, "Sign-in failed.") });
    return;
  }
  await bootSafely();
}

function devGate(gate: { value?: string; error?: string; pending?: boolean }) {
  return gateShell(html`
    <form
      @submit=${(e: Event) => {
        e.preventDefault();
        if (gate.pending) return;
        const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement | null;
        const user = input?.value.trim();
        if (user) void submitDevSignin(user);
      }}
    >
      <h1>Dev sign-in</h1>
      <p class="signin-body">
        No identity provider is configured, so this instance trusts a local cookie. Set
        <b>CORE_SIGNING_SECRET</b> and run the portal to use real sign-in.
      </p>
      <label for="dev-principal">Principal</label>
      <input
        id="dev-principal"
        name="principal"
        type="text"
        inputmode="email"
        autocomplete="username"
        spellcheck="false"
        required
        autofocus
        placeholder="you@org.com"
        .value=${gate.value ?? ""}
        ?disabled=${gate.pending === true}
      />
      <button class="btn primary" type="submit" ?disabled=${gate.pending === true}>
        ${gate.pending ? "Signing in…" : "Continue"}
      </button>
      ${gate.error ? html`<div class="hint error" role="alert">${gate.error}</div>` : nothing}
    </form>
  `);
}

export type AuthGate =
  | { kind: "portal" }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "dev"; value?: string; error?: string; pending?: boolean };

function authGateTitle(gate: AuthGate): string {
  if (gate.kind === "denied") return "Access denied";
  if (gate.kind === "unreachable") return "Assistant unavailable";
  if (gate.kind === "dev") return "Dev sign-in";
  return portalAttemptedRecently() ? "Sign in through the portal" : "Your session ended";
}

export function renderAuthGate(gate: AuthGate): void {
  shellMounted = false;
  restoreActiveModalBackgrounds();
  document.title = `${authGateTitle(gate)} · ${brandName()}`;
  const body = (() => {
    switch (gate.kind) {
      case "portal":
        return portalGate();
      case "denied":
        return deniedGate();
      case "unreachable":
        return unreachableGate();
      default:
        return devGate(gate);
    }
  })();
  render(body, appEl as HTMLElement);
  appState.mainEl = (appEl as HTMLElement).querySelector("#main");
}

function gateFor(mode: AuthMode, reason: "unauthenticated" | "not_allowed" | undefined): AuthGate {
  if (reason === "not_allowed") return { kind: "denied" };
  return mode === "dev" ? { kind: "dev" } : { kind: "portal" };
}

export function mountShell(): void {
  applySavedSidebarWidth();
  const impersonatedBy = appState.me?.impersonatedBy ?? null;
  let banner: TemplateResult | null = null;
  if (impersonatedBy) banner = impersonationBanner(impersonatedBy);
  else if (authMode === "dev") banner = devBanner(appState.me?.user ?? "");
  render(
    html`
      ${banner ?? nothing}
      <div class="layout ${sidebarOpen ? "" : "sidebar-closed"} ${banner ? "bannered" : ""}">
        <aside class="sidebar" aria-label="Navigation" @keydown=${onSidebarKeydown}>
          <div class="brand">
            <div class="brand-lockup">${brandMark()}<span class="brand-name">${brandName()}</span></div>
            <button
              class="icon-btn subtle sidebar-toggle sidebar-collapse-toggle"
              type="button"
              title="Hide sidebar"
              aria-label="Hide sidebar"
              @click=${toggleSidebar}
            >
              ${icon(PanelLeft, 17)}
            </button>
          </div>
          <div id="sidebar-top"></div>
          <div class="list" id="sidebar-body"></div>
          <div class="sidebar-footer">
            <div class="user-pill" title=${appState.me?.user ?? ""}>
              <span class="avatar">${initials(appState.me?.user ?? "?")}</span>
              <span class="user-name">${appState.me?.user ?? ""}</span>
            </div>
            <a class="icon-btn subtle" href=${ADMIN_HOME_URL} title="Back to admin" aria-label="Back to admin"
              >${icon(ArrowLeft, 17)}</a
            >
            <theme-toggle .includeSystem=${true} title="Color scheme: light / dark / system"></theme-toggle>
            <button class="icon-btn subtle" title="Sign out" aria-label="Sign out" @click=${signOut}>
              ${icon(LogOut, 17)}
            </button>
          </div>
        </aside>
        <button class="sidebar-scrim" type="button" aria-label="Close sidebar" @click=${toggleSidebar}></button>
        <div class="sr-only" id="navigation-status" role="status" aria-live="polite" aria-atomic="true"></div>
        <div
          class="sidebar-resize-handle"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin=${SIDEBAR_MIN_W}
          aria-valuemax=${SIDEBAR_MAX_W}
          aria-valuenow=${savedSidebarWidth()}
          aria-valuetext=${`${savedSidebarWidth()} pixels wide`}
          title="Drag or use arrow keys to resize · double-click to reset"
          @pointerdown=${startSidebarResize}
          @keydown=${resizeSidebarWithKeyboard}
          @dblclick=${resetSidebarWidth}
        ></div>
        <main class="main" id="main" tabindex="-1">
          <h1 class="sr-only">Chats</h1>
          <div class="empty">Pick a conversation, or start a new chat.</div>
        </main>
      </div>
    `,
    appEl as HTMLElement,
  );
  appState.topEl = (appEl as HTMLElement).querySelector("#sidebar-top");
  appState.listEl = (appEl as HTMLElement).querySelector("#sidebar-body");
  appState.mainEl = (appEl as HTMLElement).querySelector("#main");
  renderSidebarTop();
  updateSidebarToggleLabels();
  syncSidebarAccessibility(false);
  requestAnimationFrame(syncThemeToggleAccessibility);
  updateNavigationPresentation();
  shellMounted = true;
}

export function renderSidebarTop(): void {
  if (!appState.topEl) return;
  const navRow = (v: View, glyph: IconNode, label: string) =>
    html`<button
      class="navrow ${appState.currentView === v ? "active" : ""}"
      type="button"
      data-view=${v}
      title=${label}
      aria-current=${appState.currentView === v ? "page" : nothing}
    >
      ${icon(glyph, 17)}<span>${label}</span>
    </button>`;
  const navGroup = (id: string, title: string, open: boolean, toggle: () => void, rows: TemplateResult) => html`
    <button
      class="nav-section-toggle"
      type="button"
      aria-expanded=${open ? "true" : "false"}
      aria-controls=${id}
      title=${open ? `Hide ${title}` : `Show ${title}`}
      @click=${toggle}
    >
      <span>${title}</span>
      <span class="nav-section-chevron">${icon(ChevronDown, 14)}</span>
    </button>
    <div id=${id} class="nav-group ${open ? "" : "collapsed"}" aria-hidden=${open ? "false" : "true"} ?inert=${!open}>
      <div class="nav-group-inner">${rows}</div>
    </div>
  `;
  render(
    html`
      <button
        class="new-chat"
        title=${splitState.active ? "New session" : "New chat"}
        @click=${() => {
          closeSidebarOnNarrowView();
          if (!addBlankPane()) mainConversation().newChat();
        }}
      >
        ${icon(ICON.newChat, 17)}<span>${splitState.active ? "New session" : "New chat"}</span>
      </button>
      <nav class="nav" @click=${onNavClick}>
        ${navGroup(
          "nav-workspace",
          "Browse",
          navWorkspaceOpen,
          toggleNavWorkspace,
          html`
            ${navRow("contexts", ICON.contexts, "Projects")} ${navRow("chats", ICON.chats, "Chats")}
            ${navRow("files", ICON.files, "Files")} ${navRow("crons", ICON.crons, "Crons")}
            ${navRow("keychain", ICON.keychain, "Keychain")} ${navRow("deploys", ICON.deploys, "Apps")}
            ${navRow("memory", ICON.memory, "Memory")} ${navRow("skills", ICON.skills, "Skills")}
          `,
        )}
      </nav>
      ${
        appState.currentView === "chats"
          ? html`
              <div class="section-label recents-label">
                <span>Sessions</span>
                <button
                  class="web-only-toggle ${sessionsState.webOnly ? "on" : ""}"
                  type="button"
                  role="switch"
                  aria-checked=${sessionsState.webOnly ? "true" : "false"}
                  title=${sessionsState.webOnly ? "Showing web chats only" : "Hide non-web conversations"}
                  @click=${toggleWebOnly}
                >
                  <span>Web only</span><span class="mini-switch"><span class="mini-knob"></span></span>
                </button>
              </div>
            `
          : ""
      }
    `,
    appState.topEl,
  );
}

function onNavClick(e: Event): void {
  const target = e.target as Element | null;
  const row = target?.closest<HTMLButtonElement>(".navrow[data-view]");
  const view = row?.dataset.view;
  if (isView(view)) {
    switchView(view);
    closeSidebarOnNarrowView();
  }
}

export function switchView(v: View, historyMode: NavigationHistoryMode = "push", announceNavigation = true): void {
  prepareViewTransition(v);
  sessionsState.openingKey = null;
  closeSidebarOnNarrowView();
  const conversation = mainConversation();
  const chatState = conversation.state;
  if (appState.currentView === v) {
    if (
      v === "chats" &&
      navigationScreen(v, splitState.active, chatState.threadRef, chatState.sessionId) === "conversation"
    ) {
      appState.viewRenderSeq++;
      conversation.teardown();
      conversation.composer.resetComposer();
      syncUrlFromState(historyMode);
      void renderChatsPage();
      renderList();
      updateNavigationPresentation(announceNavigation, announceNavigation);
      return;
    }
    refreshActiveView(v);
    return;
  }
  appState.currentView = v;
  appState.viewRenderSeq++;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  if (v !== "chats") {
    mainConversation().teardown();
    mainConversation().composer.resetComposer();
  }
  renderSidebarTop();
  syncUrlFromState(historyMode);
  if (v !== "chats" && appState.listEl) render(nothing, appState.listEl);
  switch (v) {
    case "chats":
      if (splitState.active) drawCanvas();
      else void renderChatsPage();
      renderList();
      break;
    case "crons":
      resetActiveCron();
      void renderCronsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
  }
  updateNavigationPresentation(announceNavigation, announceNavigation);
}

export function prepareViewTransition(nextView: View): void {
  if (appState.currentView !== nextView) {
    if (appState.currentView === "crons") resetActiveCron();
    if (appState.currentView === "memory") dismissMemoryConfirmation();
  }
  restoreActiveModalBackgrounds();
}

function refreshActiveView(v: View): void {
  switch (v) {
    case "chats":
      if (splitState.active) void refreshSessions({ silent: true, refreshContexts: true });
      else void renderChatsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      clearConnectorNotice();
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
  }
}

export function showMainEmpty(text: string): void {
  exitSplitIfActive();
  mainConversation().state.host = null;
  if (appState.mainEl)
    appState.mainEl.replaceChildren(
      Object.assign(document.createElement("div"), { className: "empty", textContent: text }),
    );
}

function toggleSidebar(): void {
  setSidebarOpen(!sidebarOpen);
}

export function closeSidebarOnNarrowView(): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  setSidebarOpen(false, false);
  requestAnimationFrame(() => appState.mainEl?.focus({ preventScroll: true }));
}

narrowViewport.addEventListener("change", (event) => {
  if (event.matches && sidebarOpen) setSidebarOpen(false, false);
  else syncSidebarAccessibility(false);
});

function setSidebarOpen(open: boolean, moveFocus = true): void {
  sidebarOpen = open;
  (appEl as HTMLElement).querySelector(".layout")?.classList.toggle("sidebar-closed", !sidebarOpen);
  updateSidebarToggleLabels();
  syncSidebarAccessibility(moveFocus);
}

function syncSidebarAccessibility(moveFocus: boolean): void {
  const root = appEl as HTMLElement;
  const sidebar = root.querySelector<HTMLElement>(".sidebar");
  const main = root.querySelector<HTMLElement>(".main");
  const scrim = root.querySelector<HTMLButtonElement>(".sidebar-scrim");
  const modal = narrowViewport.matches && sidebarOpen;
  if (!sidebar || !main || !scrim) return;
  main.inert = modal;
  sidebar.setAttribute("role", modal ? "dialog" : "navigation");
  if (modal) sidebar.setAttribute("aria-modal", "true");
  else sidebar.removeAttribute("aria-modal");
  scrim.hidden = !modal;
  if (!moveFocus || !narrowViewport.matches) return;
  requestAnimationFrame(() => sidebar.querySelector<HTMLElement>(".sidebar-collapse-toggle")?.focus());
}

function onSidebarKeydown(event: KeyboardEvent): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  if (event.key === "Escape" && event.defaultPrevented) return;
  if (event.key === "Escape" && closeOpenSessionMenu()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  trapDialogFocus(event, () => setSidebarOpen(false));
}

function updateSidebarToggleLabels(): void {
  const collapseLabel = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  (appEl as HTMLElement).querySelectorAll<HTMLButtonElement>(".sidebar-toggle").forEach((btn) => {
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
    btn.setAttribute("title", collapseLabel);
    btn.setAttribute("aria-label", collapseLabel);
  });
}

export function renderPane(
  title: string,
  status: string,
  onRefresh: () => void,
  cards: unknown,
  controls: unknown = "",
): void {
  if (!appState.mainEl) return;
  const refreshLabel = `Refresh ${title.toLowerCase()}`;
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <h1 class="pane-title">${title}</h1>
        <div class="list-page-actions">
          ${controls}
          <button
            class="pane-refresh"
            type="button"
            aria-label=${refreshLabel}
            title=${refreshLabel}
            @click=${onRefresh}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${status ? html`<div class="status">${status}</div>` : ""}
      <div class="grid">${cards}</div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export function replacePanePreservingFocus(host: HTMLElement): void {
  if (!appState.mainEl) return;
  replaceChildrenPreservingFocus(appState.mainEl, host);
}

window.addEventListener("popstate", () => {
  if (appState.currentView !== "crons") return;
  const { view, item } = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (view !== "crons") return;
  routeCronsHistory(item);
});

window.addEventListener("focus", () => {
  if (!appState.me) return;
  if (appState.currentView === "contexts") void renderContexts();
  else if (appState.currentView === "chats") void refreshSessions({ silent: true, refreshContexts: true });
});

let routeRestoreSeq = 0;

export function cancelPendingRouteRestore(): void {
  routeRestoreSeq++;
}

function currentNavigationLocation(): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function storedNavigationState(value: unknown): QmNavigationState | null {
  if (!value || typeof value !== "object" || (value as { qm?: unknown }).qm !== true) return null;
  return value as QmNavigationState;
}

async function restoreRouteFromLocation(): Promise<void> {
  if (!appState.me) return;
  const conversation = mainConversation();
  const seq = ++routeRestoreSeq;
  const expectedLocation = currentNavigationLocation();
  const params = new URLSearchParams(location.search);
  const parsed = parseDeepLink(UI_BASE, location.pathname, location.search);
  const stored = storedNavigationState(history.state);
  if (stored?.screen === "split") {
    prepareViewTransition("chats");
    appState.viewRenderSeq++;
    conversation.teardown();
    conversation.composer.resetComposer();
    appState.currentView = "chats";
    splitState.active = true;
    if (!mountRestoredCanvas()) {
      splitState.active = false;
      switchView("chats", "none", false);
    }
    renderSidebarTop();
    renderList();
    updateNavigationPresentation(true, true);
    return;
  }
  if (parsed.view === "app-edit") {
    prepareAppEditView();
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) openAppEditChat(slug, "none", true);
    else {
      showMainEmpty("This edit link is missing a valid app name.");
      updateNavigationPresentation(true, true);
    }
    return;
  }
  if (isView(parsed.view) && parsed.view !== "chats") {
    if (parsed.view === "contexts") {
      switchView("contexts", "none", false);
      selectContext(params.get("scope") ?? stored?.contextScope ?? null, "none");
    } else {
      switchView(parsed.view, "none", true);
    }
    return;
  }
  if (stored?.screen === "list") {
    exitSplitIfActive();
    switchView("chats", "none", true);
    return;
  }
  const sessionId = parsed.session ?? stored?.sessionId ?? null;
  if (sessionId) {
    exitSplitIfActive();
    switchView("chats", "none", false);
    let match = sessionsState.list.find((session) => session.id === sessionId);
    if (!match) {
      await refreshSessions({ silent: true });
      if (seq !== routeRestoreSeq || expectedLocation !== currentNavigationLocation()) return;
      match = sessionsState.list.find((session) => session.id === sessionId);
    }
    if (match) await openSession(match, undefined, "none", true);
    else {
      showMainEmpty("That conversation wasn't found, or you don't have access to it.");
      updateNavigationPresentation(true, true);
    }
    return;
  }
  if (stored?.screen === "conversation" && stored.threadRef) {
    exitSplitIfActive();
    switchView("chats", "none", false);
    conversation.mountContinuable(stored.threadRef, null, stored.scopeId, [], stored.contextName, "none", true);
    renderList();
    return;
  }
  exitSplitIfActive();
  switchView("chats", "none", true);
}

window.addEventListener("popstate", () => void restoreRouteFromLocation());

function warmDeferredChunks(): void {
  const warm = (): void => void import("@earendil-works/pi-web-ui").catch(() => {});
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(warm);
  else setTimeout(warm, 1500);
}

function openAppEditChat(slug: string, historyMode: NavigationHistoryMode = "none", announceNavigation = false): void {
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:app-edit:${slug}`;
  const existing = sessionsState.list.find((s) => s.threadRef === threadRef);
  if (existing) {
    void openSession(existing, undefined, historyMode, announceNavigation);
    return;
  }
  if (!storedDraft(threadRef)) saveDraft(threadRef, `Update my deployed app "${slug}": `);
  mainConversation().mountContinuable(threadRef, null, null, [], null, historyMode, announceNavigation);
  renderList();
}

function prepareAppEditView(): void {
  prepareViewTransition("chats");
  sessionsState.openingKey = null;
  exitSplitIfActive();
  appState.viewRenderSeq++;
  const conversation = mainConversation();
  conversation.teardown();
  conversation.composer.resetComposer();
  appState.currentView = "chats";
  renderSidebarTop();
}

export async function bootSafely(): Promise<void> {
  try {
    await boot();
  } catch (e) {
    if (shellMounted) swallow("web-ui: boot", e);
    else renderAuthGate({ kind: "unreachable" });
  }
}

export async function boot(): Promise<void> {
  let r: Response;
  try {
    r = await fetch(withBase("/me"));
  } catch {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  if (r.status === 401) {
    const body = (await r.json().catch(() => ({}))) as SigninRequired;
    authMode = body.mode ?? "portal";
    renderAuthGate(gateFor(authMode, body.reason));
    return;
  }
  if (!r.ok) {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  resetKeychainState();
  appState.me = (await r.json()) as Me;
  authMode = appState.me.mode ?? "portal";
  clearPortalAttempt();
  const personalScope = `personal:${appState.me.user}`;
  const runtimeConfig = await fetchRuntimeConfig(personalScope);
  if (runtimeConfig) {
    applyRuntimeOptions(
      personalScope,
      runtimeConfig.approvedHarnesses,
      runtimeConfig.modelsByHarness,
      runtimeConfig.effective,
      runtimeConfig.modelCatalog,
    );
    seedRuntimeConfig(personalScope, runtimeConfig);
  }
  resyncModelSelection();
  mountShell();
  ensureDeliveryStream();
  warmDeferredChunks();
  loadPersistedSplit();

  const params = new URLSearchParams(location.search);
  const {
    view: wanted,
    session: wantedSession,
    item: wantedItem,
  } = parseDeepLink(UI_BASE, location.pathname, location.search);
  const connectedProvider = params.get("status") === "connected" ? params.get("connector") : null;
  if (connectedProvider) markConnectorConnected(connectedProvider);
  const viewIntent = isView(wanted) && wanted !== "chats";
  const entriesPrefetch =
    wantedSession && !viewIntent ? fetchTranscript(wantedSession, { tailTurns: TAIL_TURNS }).catch(() => null) : null;

  const bareEntry = !viewIntent && !wantedSession && wanted !== "app-edit" && !connectedProvider;
  if (bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas();

  await refreshSessions({ showLoading: true });

  if (wanted === "app-edit") {
    prepareAppEditView();
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) {
      openAppEditChat(slug, "none", false);
      return;
    }
    showMainEmpty("This edit link is missing a valid app name.");
    return;
  }

  if (wanted === "keychain") {
    const provider = params.get("connector");
    const status = params.get("status");
    if (provider && status) noteConnectorResult(provider, status);
    switchView("keychain", "replace", false);
  } else if (viewIntent) {
    if (wanted === "contexts" || wanted === "files" || wanted === "deploys") {
      const scope =
        params.get("scope") ?? (wantedItem ? resolveProjectScope(await ensureContexts(), wantedItem) : null);
      if (scope) contextsState.selected = scope;
    }
    if (wanted === "crons" && wantedItem) openCronById(wantedItem);
    switchView(wanted as View);
  } else if (wantedSession) {
    const match = sessionsState.list.find((s) => s.id === wantedSession);
    if (match) {
      exitSplitIfActive();
      await openSession(match, entriesPrefetch ?? undefined, "replace", false);
    } else if (mountRestoredCanvas()) {
      canvasToast("That conversation wasn't found, or you don't have access to it.");
      syncUrlFromState("replace");
    } else {
      showMainEmpty("That conversation wasn't found, or you don't have access to it.");
      renderList();
    }
  } else if (connectedProvider && sessionsState.list.length) {
    const recent = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0]!;
    exitSplitIfActive();
    await openSession(recent);
  } else if (!mountRestoredCanvas() && !mainConversation().state.threadRef) {
    mainConversation().newChat();
  }
}
