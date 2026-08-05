import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const callbacks: string[] = [];
const core = createServer((req, res) => {
  callbacks.push(req.url ?? "");
  const failed = new URL(req.url ?? "/", "http://core.test").searchParams.has("error");
  res.writeHead(failed ? 400 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: !failed }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.CORE_API_URL = coreUrl;
process.env.WEB_UI_PUBLIC_URL = "https://qm.example.test";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("connector callback redirects to the keychain route after success", async () => {
  const response = await fetch(`${base}/v1/connectors/oauth/google/callback?code=fixture`, { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://qm.example.test/?view=keychain&connector=google&status=connected",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
  assert.equal(callbacks.at(-1), "/v1/connectors/oauth/google/callback?code=fixture");
});

test("connector callback redirects to an error status when core rejects it", async () => {
  const response = await fetch(`${base}/connectors/oauth/slack/callback?error=denied`, { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://qm.example.test/?view=keychain&connector=slack&status=error");
});
