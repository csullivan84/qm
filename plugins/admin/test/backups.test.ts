import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const calls: Array<{ method: string; url: string; actor: string | null; idempotencyKey: string | null }> = [];
const core = createServer((req: IncomingMessage, res) => {
  calls.push({
    method: req.method ?? "",
    url: req.url ?? "",
    actor: (req.headers["x-admin-actor"] as string) ?? null,
    idempotencyKey: (req.headers["idempotency-key"] as string) ?? null,
  });
  req.resume();
  if (req.url === "/v1/admin/backups/recovery-kit") {
    res.writeHead(200, {
      "content-type": "application/vnd.qm.recovery-kit+age",
      "cache-control": "no-store",
      "x-qm-recovery-kit-fingerprint": "age-sha256:proof",
    });
    res.end("encrypted-kit");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-backup-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const headers = { cookie: "admin=U-admin", "content-type": "application/json" };
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function destinationPolicyResult(
  response: Record<string, unknown>,
  lockRequired = false,
): { message: string; kind: string; alert: boolean } {
  const start = html.indexOf("      function recoveryDestinationPolicyResult");
  const end = html.indexOf('      $("recovery-test-destination")', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  return new Function(`${source}; return recoveryDestinationPolicyResult;`)()(response, lockRequired) as {
    message: string;
    kind: string;
    alert: boolean;
  };
}

test.after(() => {
  server.close();
  core.close();
});

test("Recovery reads and writes are source-authenticated and idempotency keys reach the core", async () => {
  const status = await fetch(`${base}/api/backups/status`, { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(calls.at(-1), {
    method: "GET",
    url: "/v1/admin/backups/status",
    actor: "U-admin@acme",
    idempotencyKey: null,
  });

  const run = await fetch(`${base}/api/backups/runs`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "manual-proof" },
    body: JSON.stringify({ purpose: "manual" }),
  });
  assert.equal(run.status, 200);
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    url: "/v1/admin/backups/runs",
    actor: "U-admin@acme",
    idempotencyKey: "manual-proof",
  });
});

test("one-time recovery-kit responses preserve their binary type, no-store policy, and fingerprint", async () => {
  const response = await fetch(`${base}/api/backups/recovery-kit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ passphrase: "correct horse battery staple" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.qm.recovery-kit+age");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-qm-recovery-kit-fingerprint"), "age-sha256:proof");
  assert.equal(await response.text(), "encrypted-kit");
});

test("Recovery proxy routes reject signed-out requests before the core", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/backups/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/backups/runs`, { method: "POST", body: "{}" })).status, 401);
  assert.equal(calls.length, before);
});

test("Recovery destination testing announces bounded unnecessary capabilities as a Degraded warning", () => {
  const result = destinationPolicyResult({
    ok: true,
    data: {
      reachable: "pass",
      private: "pass",
      bucketScoped: "pass",
      leastPrivilege: "unavailable",
      serverSideEncryption: "pass",
      lifecycle: "pass",
      objectLock: "pass",
      unnecessaryCapabilities: ["writeBuckets", `hostile-${"x".repeat(5000)}`, ...Array(10).fill("extra")],
    },
  });
  assert.equal(result.kind, "warn");
  assert.equal(result.alert, true);
  assert.match(result.message, /credential has unnecessary capabilities/);
  assert.match(result.message, /Protection remains Degraded until the key is replaced/);
  assert.match(result.message, /and more/);
  assert.ok(result.message.length < 600);
});

test("Recovery destination testing fails closed on missing or malformed least-privilege evidence", () => {
  const otherwisePassing = {
    reachable: "pass",
    private: "pass",
    bucketScoped: "pass",
    serverSideEncryption: "pass",
    lifecycle: "pass",
    objectLock: "pass",
  };
  for (const leastPrivilege of [undefined, "unknown", true]) {
    const result = destinationPolicyResult({
      ok: true,
      data: { ...otherwisePassing, ...(leastPrivilege === undefined ? {} : { leastPrivilege }) },
    });
    assert.equal(result.kind, "err");
    assert.equal(result.alert, true);
    assert.match(result.message, /least-privilege evidence was missing or invalid/);
  }
});
