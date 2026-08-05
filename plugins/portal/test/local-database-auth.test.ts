import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const fixturePassword = "fixture-local-password";
const sessions = new Map<string, string>();
const claims = new Set<string>();
let nextToken = 0;

async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

const core = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://core.test");
    if (url.pathname === "/v1/surface-config") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ modelProviderConfigured: true }));
    }
    const body = await requestBody(req);
    if (url.pathname === "/v1/auth/broker/claim") {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const claimed = ids.find((id): id is string => typeof id === "string" && !claims.has(id));
      if (claimed) claims.add(claimed);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ claimed: claimed ?? null }));
    }
    if (url.pathname === "/v1/auth/local/login") {
      if (body.username === "outage") {
        res.writeHead(500, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "internal_error" }));
      }
      if (body.username !== "alice" || body.password !== fixturePassword) {
        res.writeHead(401, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "invalid_credentials" }));
      }
      const token = `opaque-session-${++nextToken}`;
      sessions.set(token, "alice");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ token, username: "alice", expiresAt: Date.now() + 3_600_000 }));
    }
    if (url.pathname === "/v1/auth/local/setup") {
      if (body.setupCode !== "fixture-setup-code") {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "local_auth_failed", message: "invalid or expired setup code" }));
      }
      const token = `opaque-session-${++nextToken}`;
      sessions.set(token, "new-user");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ token, username: "new-user", expiresAt: Date.now() + 3_600_000 }));
    }
    if (url.pathname === "/v1/auth/local/session") {
      const username = typeof body.token === "string" ? sessions.get(body.token) : undefined;
      if (!username) {
        res.writeHead(401, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "invalid_session" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ username, expiresAt: Date.now() + 3_600_000 }));
    }
    if (url.pathname === "/v1/auth/local/logout") {
      if (typeof body.token === "string") sessions.delete(body.token);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  })();
});
await new Promise<void>((resolve) => core.listen(0, resolve));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

const upstream = createServer((req, res) => {
  if (req.url === "/api/whoami") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: true }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise<void>((resolve) => upstream.listen(0, resolve));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const publicUrl = "http://localhost:18198";
process.env.NODE_ENV = "test";
process.env.PORTAL_AUTH_MODE = "local";
process.env.PORTAL_PUBLIC_URL = publicUrl;
process.env.PORTAL_SESSION_SECRET = "local-database-portal-secret";
process.env.CORE_SIGNING_SECRET = "local-database-core-secret";
process.env.PORTAL_IDENTITY_SECRET = "local-database-identity-secret";
process.env.PORTAL_LOCAL_AUTH_LOGIN_LIMIT_PER_USER = "3";
process.env.CORE_API_URL = coreUrl;
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;

const { bootChecks, server } = await import("../src/index.ts");
bootChecks();
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  core.close();
  upstream.close();
});

function sessionCookie(response: Response): { header: string; token: string } {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /portal_session=([^;]+)/.exec(setCookie);
  assert.ok(match, `portal session cookie missing: ${setCookie}`);
  return { header: `portal_session=${match[1]}`, token: decodeURIComponent(match[1]!) };
}

test("local mode renders username/password sign-in and keeps failed credentials out of the response", async () => {
  const page = await fetch(`${base}/auth/login?returnTo=%2Fadmin%2F`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.match(html, /<label for="login-username">Username<\/label>/);
  assert.match(html, /id="login-username"[^>]+autocomplete="username"/);
  assert.match(html, /<label for="login-password">Password<\/label>/);
  assert.match(html, /id="login-password"[^>]+autocomplete="current-password"/);
  assert.match(html, /aria-labelledby="t" aria-describedby="page-description"/);
  assert.match(html, /href="\/auth\/setup\?returnTo=%2Fadmin%2F"/);
  assert.doesNotMatch(html, /placeholder=/i);
  assert.doesNotMatch(html, /type="email"|openid|oauth/i);

  const setupPage = await fetch(`${base}/auth/setup?returnTo=%2Fmemory`);
  assert.equal(setupPage.status, 200);
  const setupHtml = await setupPage.text();
  assert.match(setupHtml, /<label for="setup-code">One-time setup code<\/label>/);
  assert.match(setupHtml, /id="setup-code"[^>]+autocomplete="one-time-code"/);
  assert.match(setupHtml, /<label for="setup-password">New password<\/label>/);
  assert.match(setupHtml, /id="setup-password"[^>]+aria-describedby="password-requirements"/);
  assert.match(setupHtml, /<label for="setup-password-confirmation">Confirm new password<\/label>/);
  assert.match(setupHtml, /id="setup-password-confirmation"[^>]+aria-describedby="password-requirements"/);
  assert.match(setupHtml, /id="password-requirements">Use 12 to 256 characters\.<\/p>/);
  assert.match(setupHtml, /aria-labelledby="t" aria-describedby="page-description"/);
  assert.match(setupHtml, /action="\/auth\/setup\?returnTo=%2Fmemory"/);
  assert.match(setupHtml, /name="returnTo" value="\/memory"/);
  assert.match(setupHtml, /href="\/auth\/login\?returnTo=%2Fmemory"/);
  assert.doesNotMatch(setupHtml, /placeholder=/i);

  const failed = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "alice", password: "fixture-wrong-password", returnTo: "/" }),
  });
  assert.equal(failed.status, 401);
  const failureHtml = await failed.text();
  assert.match(failureHtml, /Invalid username or password/);
  assert.match(failureHtml, /id="auth-error" role="alert" aria-live="assertive" aria-atomic="true"/);
  assert.match(failureHtml, /aria-describedby="page-description auth-error"/);
  assert.doesNotMatch(failureHtml, /fixture-wrong-password/);
  assert.equal(failed.headers.get("set-cookie"), null);

  const unavailable = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "outage", password: fixturePassword, returnTo: "/" }),
  });
  assert.equal(unavailable.status, 503);
  assert.match(await unavailable.text(), /temporarily unavailable/);

  const oversized = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "alice", password: "x".repeat(9_000), returnTo: "/" }),
  });
  assert.equal(oversized.status, 413);
});

test("invalid username spellings share one durable login-rate bucket", async () => {
  for (const username of ["!", "@@", "a b"]) {
    const failed = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password: fixturePassword, returnTo: "/" }),
    });
    assert.equal(failed.status, 401);
  }
  const limited = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "/", password: fixturePassword, returnTo: "/" }),
  });
  assert.equal(limited.status, 429);
});

test("a database session authenticates proxy access and logout revokes it", async () => {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "alice", password: fixturePassword, returnTo: "/" }),
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  const cookie = sessionCookie(login);
  assert.equal(sessions.get(cookie.token), "alice");

  const signedIn = await fetch(`${base}/`, { headers: { cookie: cookie.header } });
  assert.equal(signedIn.status, 200);
  const proxied = (await signedIn.json()) as { cookie: string };
  assert.equal(proxied.cookie, "webuiuser=alice");

  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: publicUrl, cookie: cookie.header },
    redirect: "manual",
  });
  assert.equal(logout.status, 200);
  assert.equal(sessions.has(cookie.token), false);
  assert.match(logout.headers.get("set-cookie") ?? "", /portal_session=;.*Max-Age=0/);

  const revoked = await fetch(`${base}/`, {
    headers: { cookie: cookie.header, accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(revoked.status, 302);
  assert.match(revoked.headers.get("location") ?? "", /^\/auth\/login/);
});

test("one-time setup establishes a database-backed session without exposing the password", async () => {
  const failed = await fetch(`${base}/auth/setup?returnTo=%2Fmemory`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      setupCode: "invalid-setup-code",
      password: fixturePassword,
      confirmPassword: fixturePassword,
      returnTo: "/memory",
    }),
  });
  assert.equal(failed.status, 400);
  const failureHtml = await failed.text();
  assert.match(failureHtml, /id="auth-error" role="alert" aria-live="assertive" aria-atomic="true"/);
  assert.match(failureHtml, /aria-describedby="page-description auth-error"/);
  assert.match(failureHtml, /id="setup-password"[^>]+aria-describedby="password-requirements"/);
  assert.match(failureHtml, /name="returnTo" value="\/memory"/);
  assert.match(failureHtml, /href="\/auth\/login\?returnTo=%2Fmemory"/);
  assert.doesNotMatch(failureHtml, /invalid-setup-code/);

  const setup = await fetch(`${base}/auth/setup?returnTo=%2Fmemory`, {
    method: "POST",
    headers: { origin: publicUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      setupCode: "fixture-setup-code",
      password: fixturePassword,
      confirmPassword: fixturePassword,
      returnTo: "/memory",
    }),
    redirect: "manual",
  });
  assert.equal(setup.status, 303);
  assert.equal(setup.headers.get("location"), "/memory");
  assert.doesNotMatch(await setup.text(), new RegExp(fixturePassword));
  const cookie = sessionCookie(setup);
  assert.equal(sessions.get(cookie.token), "new-user");
});

test("local setup rejects cross-origin return targets", async () => {
  const page = await fetch(`${base}/auth/setup?returnTo=${encodeURIComponent("https://evil.example/")}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="returnTo" value="\/"/);
  assert.match(html, /action="\/auth\/setup\?returnTo=%2F"/);
  assert.doesNotMatch(html, /evil\.example/);
});
