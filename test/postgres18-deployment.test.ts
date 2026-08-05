import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

test("all bundled PostgreSQL containers are immutable 18.4 images with the PostgreSQL 18 volume root", () => {
  const dev = source("scripts/dev/lib/postgres.ts");
  const docker = source("cli/src/backends/docker.ts");
  const ci = source(".github/workflows/cicd.yml");
  const expected = "postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a";

  assert.match(dev, new RegExp(expected));
  assert.match(docker, new RegExp(expected));
  assert.match(ci, new RegExp(expected));
  assert.doesNotMatch(`${dev}\n${docker}\n${ci}`, /postgres:16|\/var\/lib\/postgresql\/data/);
  assert.match(dev, /:\/var\/lib\/postgresql/);
  assert.match(docker, /:\/var\/lib\/postgresql/);
});

test("the independent recovery and backup images pin PostgreSQL 18.4 client tooling", () => {
  const dockerfile = source("deploy/recovery/Dockerfile");
  const worker = source("deploy/backup/Dockerfile");
  assert.match(dockerfile, /postgresql18-client=18\.4-r0/);
  assert.match(dockerfile, /pg_restore .*18\\\.4/);
  assert.match(dockerfile, /^FROM .*@sha256:[a-f0-9]{64}$/m);
  assert.match(worker, /postgresql18-client=18\.4-r0/);
  assert.match(worker, /ENTRYPOINT \["node", "\/app\/src\/backup\/worker-main\.ts"\]/);
  assert.match(worker, /^FROM .*@sha256:[a-f0-9]{64}$/m);
});
