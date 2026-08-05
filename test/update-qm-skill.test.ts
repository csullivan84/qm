import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(new URL("../.codex/skills/update-qm/SKILL.md", import.meta.url), "utf8");

test("the update skill makes the parent remote fetch-only", () => {
  assert.match(skill, /git remote add upstream https:\/\/github\.com\/yc-software\/qm\.git/);
  assert.match(skill, /git remote set-url upstream https:\/\/github\.com\/yc-software\/qm\.git/);
  assert.match(skill, /git config --unset-all remote\.upstream\.pushurl \|\| true/);
  assert.match(skill, /git remote set-url --add --push upstream DISABLED/);
  assert.doesNotMatch(skill, /git remote add upstream git@github\.com/);
  assert.doesNotMatch(skill, /^git push(?:[ \t]+\S+)*[ \t]+upstream(?:[ \t]|$)/m);
});
