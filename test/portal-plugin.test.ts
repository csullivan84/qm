import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { signRequest } from "../src/auth/source-auth.ts";
import { canonicalPayload } from "../plugins/chassis/src/source-auth-sign.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { proxyToSurface, requestPort } from "../plugins/portal/src/proxy.ts";
import { createAdminService, parseAdminGrants } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { scopeId } from "../src/types.ts";

test("portal signs /d/ ingress with the principal as the canonical tail (core-verifiable)", () => {
  const secret = "portal-source-auth-secret";
  const path = "/d/dep-1/assets/app.js?q=a+b%2Fc&n=1";
  const principal = "U00000001";
  const headers = signedHeaders(secret, "GET", path, "", principal);
  const ts = Number(headers["x-timestamp"]);
  assert.equal(headers["x-signature"], signRequest(secret, ts, canonicalPayload("GET", path, principal)));
});

test("portal proxy omits empty URL ports so http.request uses protocol defaults", () => {
  assert.equal(requestPort(new URL("http://qm-web-ui.flycast")), undefined);
  assert.equal(requestPort(new URL("https://qm-web-ui.flycast")), undefined);
  assert.equal(requestPort(new URL("http://qm-web-ui.flycast:8080")), "8080");
});

test("portal surface proxy preserves idempotency keys required by Admin mutations", async () => {
  let receivedKey: string | undefined;
  const upstream = createServer((req, res) => {
    receivedKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const proxy = createServer((req, res) => {
    proxyToSurface(req, res, {
      upstreamBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      forwardPath: "/api/backups/runs",
      search: "",
      cookieName: "admin",
      principal: "admin-one",
    });
  });
  try {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/admin/api/backups/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "manual-proof" },
      body: '{"purpose":"manual"}',
    });
    assert.equal(response.status, 200);
    assert.equal(receivedKey, "manual-proof");
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});

test("parseAdminGrants: unset keeps the seeded defaults (returns undefined)", () => {
  assert.equal(parseAdminGrants(undefined, "default-org"), undefined);
});

test("parseAdminGrants: parses org_admin grants and skips malformed / removed-role entries", () => {
  const grants = parseAdminGrants(
    "U1:org_admin, U2:team_admin:team-eng, bad, U3:notarole, U5:org_admin",
    "default-org",
  );
  assert.deepEqual(grants, [
    { principalId: "U1", scopeId: scopeId("org", "default-org"), role: "org_admin" },
    { principalId: "U5", scopeId: scopeId("org", "default-org"), role: "org_admin" },
  ]);
  assert.deepEqual(parseAdminGrants("", "default-org"), []);
});

test("ADMIN_GRANTS-seeded admins resolve and authorize org-wide; non-admins do not", async () => {
  const store = createAdminGrantStore(createMemoryAdminGrantPersistence(), {
    seed: parseAdminGrants("U1:org_admin", "default-org"),
  });
  const svc = createAdminService(store);
  const u1 = svc.resolveActor("U1@default-org");
  const u2 = svc.resolveActor("U2@default-org");
  assert.ok(u1 && u2);
  assert.equal(await svc.canAdminister(u1, scopeId("org", "default-org")), true);
  assert.equal(await svc.canAdminister(u1, scopeId("channel", "eng")), true);
  assert.equal(await svc.canAdminister(u2, scopeId("org", "default-org")), false);
  assert.equal(
    await svc.canAdminister(svc.resolveActor("admin-alice@default-org")!, scopeId("org", "default-org")),
    false,
  );
});
