import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("slash commands expose valid multiline list-autocomplete semantics", () => {
  assert.doesNotMatch(composer, /<textarea[\s\S]{0,200}?role="combobox"/);
  assert.match(composer, /aria-autocomplete="list"/);
  assert.doesNotMatch(composer, /aria-expanded=\$\{slash\.open/);
  assert.match(composer, /aria-controls=\$\{slash\.open \? "slash-command-listbox" : nothing\}/);
  assert.match(composer, /aria-activedescendant=/);
  assert.match(composer, /id="slash-command-listbox" role="listbox"/);
  assert.match(composer, /`slash-command-option-\$\{index\}`/);
  assert.match(composer, /role="option"/);
  assert.match(composer, /id="slash-command-status" role="status" aria-live="polite" aria-atomic="true"/);
});

test("theme and sidebar sizing controls have accessible names, values, and keyboard behavior", () => {
  assert.match(shell, /Change color theme\. Current setting:/);
  assert.match(shell, /role="separator"\s+tabindex="0"/);
  assert.match(shell, /aria-valuemin=\$\{SIDEBAR_MIN_W\}/);
  assert.match(shell, /aria-valuemax=\$\{SIDEBAR_MAX_W\}/);
  assert.match(shell, /@keydown=\$\{resizeSidebarWithKeyboard\}/);
  assert.match(shell, /e\.key === "ArrowLeft"/);
  assert.match(shell, /e\.key === "ArrowRight"/);
  assert.match(shell, /e\.key === "Home"/);
  assert.match(shell, /e\.key === "End"/);
});

test("background activity uses native sibling buttons instead of nested interactive spans", () => {
  assert.match(sessions, /<button\s+class="bg-chip background-status-button"\s+type="button"/);
  assert.match(sessions, /<\/button>\s+\$\{backgroundStatusButton\(s\)\}/);
  assert.doesNotMatch(sessions, /class="bg-chip"\s+role="button"/);
});

test("connector callbacks use an HTTP redirect without meta refresh", () => {
  assert.match(server, /res\.writeHead\(303, \{ location: `\$\{PUBLIC_URL\}\/\?\$\{q\}`/);
  assert.doesNotMatch(server, /http-equiv="refresh"/i);
  assert.doesNotMatch(server, /callbackHtml/);
});
