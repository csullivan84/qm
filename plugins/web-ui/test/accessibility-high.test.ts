import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const crons = readFileSync(new URL("../src/crons.ts", import.meta.url), "utf8");
const deploys = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
const memory = readFileSync(new URL("../src/memory.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const dialogFocus = readFileSync(new URL("../src/dialog-focus.ts", import.meta.url), "utf8");

test("the application exposes one main landmark and meaningful route or conversation headings", () => {
  assert.match(shell, /<main class="main" id="main" tabindex="-1">/);
  assert.doesNotMatch(shell, /<section class="main"/);
  assert.match(chat, /<h1 class="sr-only conversation-title" tabindex="-1">\$\{activeConversationTitle\(\)\}<\/h1>/);
  assert.match(chat, /<h1 class="chat-title" tabindex="-1">/);
  assert.match(crons, /<h1 tabindex="-1">\$\{cronTitle\(c\)\}<\/h1>/);
  assert.match(crons, /<h1 tabindex="-1">New cron<\/h1>/);
  assert.match(deploys, /<h1 tabindex="-1">\$\{deploymentTitle\(d\)\}<\/h1>/);
  assert.match(split, /heading\.textContent = "Conversations"/);
  assert.match(shell, /<main class="signin" id="main" tabindex="-1">/);
  assert.match(shell, /document\.title = `\$\{authGateTitle\(gate\)\} · \$\{brandName\(\)\}`/);
});

test("collapsed Browse destinations are hidden from assistive technology and keyboard focus", () => {
  assert.match(shell, /aria-hidden=\$\{open \? "false" : "true"\}/);
  assert.match(shell, /\?inert=\$\{!open\}/);
});

test("cron dialogs trap focus, close with Escape, inert their background, and restore their opener", () => {
  assert.match(crons, /trapDialogFocus\(event, \(\) => closeCronDialog\(c\)\)/);
  assert.match(crons, /focusDialogCancel\(document\)/);
  assert.match(crons, /setCronDialogBackgroundInert\(true\)/);
  assert.match(crons, /syncModalBackground\(cronModalBackground, backdrop\)/);
  assert.match(crons, /restoreDialogFocus\(\s*focus\.opener/);
  assert.match(crons, /\) \?\? appState\.mainEl,/);
  assert.match(crons, /data-dialog-cancel/);
  assert.match(crons, /<label>\s+<span>Describe the cron<\/span>\s+<textarea/);
});

test("pasted-text dialog traps focus, inerts chat content, and restores its attachment control", () => {
  assert.match(composer, /trapDialogFocus\(event, \(\) => closePasteView\(agent\)\)/);
  assert.match(composer, /paste-dialog-text"\)\?\.focus\(\)/);
  assert.match(composer, /function syncPasteDialogAccessibility/);
  assert.match(composer, /\n {4}syncPasteDialogAccessibility,/);
  assert.match(composer, /syncModalBackground\(pasteModalBackground, backdrop\)/);
  assert.match(composer, /restoreDialogFocus\(opener/);
  assert.match(composer, /data-paste-id=\$\{a\.id\}/);
  assert.match(composer, /<label class="paste-dialog-label" for="paste-dialog-text">Pasted text content<\/label>/);
  assert.match(composer, /id="paste-dialog-text"\s+class="paste-dialog-text"/);
  assert.match(chat, /ctx\.composer\.syncPasteDialogAccessibility\(\)/);
});

test("memory confirmations are complete modal alert dialogs", () => {
  assert.match(memory, /role="alertdialog"\s+aria-modal="true"/);
  assert.match(memory, /class="memory-text"[\s\S]{0,120}?aria-label="Memory notebook"/);
  assert.match(memory, /aria-describedby="memory-confirm-description"/);
  assert.match(memory, /\?inert=\$\{Boolean\(memoryConfirmation\)\}/);
  assert.match(memory, /syncModalBackground\(/);
  assert.match(memory, /trapDialogFocus\(event, closeMemoryConfirmation\)/);
  assert.match(memory, /focusDialogCancel\(host\)/);
  assert.match(memory, /restoreMemoryConfirmationFocus/);
  assert.match(memory, /\) \?\? appState\.mainEl,/);
  assert.match(dialogFocus, /while \(current\.parentElement/);
  assert.match(dialogFocus, /sibling.*\.inert = true/);
});

test("leaving a modal route restores global background accessibility", () => {
  assert.match(shell, /export function prepareViewTransition\(nextView: View\)/);
  assert.match(shell, /appState\.currentView === "crons"\) resetActiveCron\(\)/);
  assert.match(shell, /appState\.currentView === "memory"\) dismissMemoryConfirmation\(\)/);
  assert.match(shell, /restoreActiveModalBackgrounds\(\)/);
  assert.match(shell, /export function switchView\([\s\S]*?prepareViewTransition\(v\)/);
  assert.match(chat, /function newChat\([\s\S]*?prepareViewTransition\("chats"\)/);
});
