# QM

QM is an independently maintained downstream of
[yc-software/qm](https://github.com/yc-software/qm), a multiplayer agent runtime for
work on the web, in Slack, and on a self-hosted Matrix homeserver.

This repository focuses on accessible operation, practical Slack-parity Matrix support,
durable administration, deterministic recovery, PostgreSQL 18, and a small-team
self-hosting path. Product-specific applications and deployment identities belong in
separate private downstream repositories.

Clone the public repository with:

```bash
git clone https://github.com/csullivan84/qm.git
cd qm
```

## What QM does

Each person and shared room receives scoped memory, files, credentials, permissions,
schedules, web apps, and a durable sandbox. People can work independently or collaborate
with the same agent through Slack, Matrix, and the web UI.

Pi, OpenCode, Codex, and Claude Code use the same core interfaces, so a deployment can
change harnesses and models without replacing its identity, policy, storage, or surface
architecture.

Core capabilities include:

- Personal and shared scopes with isolated state and permissions.
- Slack, Matrix, and web surfaces over the same identity and configuration.
- Organization administration, security postures, harnesses, and models.
- Scope-owned skills with controlled sharing and organization promotion.
- Internal web applications published to selected people.
- Scheduled and watched background work.

## Downstream enhancements

- **Matrix as a first-class surface.** Homeserver, room, and user allowlists fail closed;
  Matrix identities map explicitly to QM principals; private-room policy is checked before
  plaintext is handled.
- **Slack-parity Matrix operations.** Matrix receives in-place progress edits, stages
  validated files through QM's blob authority, follows selected threads, projects targeted
  reactions, and supports actor-bound exact approval actions.
- **Admin-managed Matrix.** Admin stores the token write-only and controls the homeserver,
  rooms, users, files, thread following, reactions, and allowed approval modes without a
  core restart. Failed replacements preserve the previous working configuration.
- **Durable Matrix coordination.** Shared cursors, leases, identity mappings, and operator
  settings survive restarts and coordinate multiple core instances.
- **Deterministic B2 Recovery.** A separate non-agent worker captures PostgreSQL, encrypts
  self-contained recovery points, pins verification and restore to object version IDs, and
  reports evidence-based protection conditions. Non-reusable configuration incarnations
  prevent a deleted and recreated destination from inheriting old validation, kits, jobs,
  drills, or worker heartbeats. Generations are reserved before destination inspection by a
  durable counter, and incarnation-aware configurations use a namespace disjoint from
  supported legacy records. Upload success alone never means Protected.
- **PostgreSQL 18.4 baseline.** Bundled database paths pin PostgreSQL 18.4 by immutable image
  digest, use the PostgreSQL 18 volume root, and refuse an unsafe in-place start over an
  older major-version data directory.
- **Screen-reader accessibility.** Web and portal behavior improves landmarks, route focus,
  dialog naming, reply-state announcements, conversation labels, and keyboard operation.
- **Current runtime stack.** The downstream requires Node 26.5.1 or newer and npm 12.0.2 or
  newer, with reproducible container builds.

The first Recovery upgrade from a release without configuration incarnations is a
stop-the-world compatibility boundary. Stop every older core and backup worker, wait for
their work to drain, and then configure Recovery with the new release. Mixed-version
Recovery writes are not supported across that boundary.

## Matrix boundary

Matrix support connects one controlled homeserver and accepts only explicitly allowed
private rooms and users. It handles plaintext messages, progress edits, validated
attachments, thread continuation, reactions, and exact approvals. End-to-end encrypted
rooms are rejected rather than handled incompletely.

Matrix configuration may come from deployment settings or durable Admin configuration.
Secret reads reveal only presence and source metadata; they never return the access token.
Matrix and Slack share QM identity and policy while retaining their protocol-specific
behavior.

## Recovery and PostgreSQL boundary

Recovery covers the QM database and explicitly allowlisted deployment inputs. External
Matrix state, Slack, identity providers, email, model providers, and object-storage account
data remain out of scope.

The worker uses exact object version IDs for discovery, verification, download, and
restore. Multiple matching versions or delete markers fail closed as ambiguous. Admin
reports Protected only after a fresh verified recovery point, an acknowledged offline kit,
a current worker, passing destination policy, and a successful isolated restore drill.
The current `qm-backup/v1` implementation is deliberately memory-bounded and rejects a
recovery archive larger than 16 MiB before upload. The worker requires a memory limit of
at least 256 MiB; deployments with larger protected inputs must not enable Recovery until
a streaming archive format is available.

PostgreSQL major upgrades use logical dump and restore. Never attach a PostgreSQL 16 data
directory directly to PostgreSQL 18. Keep the previous volume as a rollback artifact until
the restored PostgreSQL 18 deployment passes recorded schema, row, organization,
timestamp, and application-health checks.

The B2 integration path has been exercised end to end in an isolated engineering run:
connect, upload, capture the returned version ID, rediscover that version, verify,
download, decrypt, and restore into PostgreSQL 18.4. That proves the path under test; it is
not a claim that any particular deployment is continuously protected.

## Architecture

Every turn runs through a central headless core. PostgreSQL holds user data, session
history, and durable control state. The agent's `execute` tool runs commands in a scope's
isolated persistent sandbox. Web UI, Admin, Auth, and Portal are optional HTTP plugins;
Slack and Matrix are supervised surfaces using the same identity and policy layer.

Slack is an optional in-process plugin that core starts and supervises through Bolt. The
core API and server-side plugins use Fastify, while the web UI is built with Vite and Lit.

The optional backup worker is deterministic infrastructure. It has narrowly scoped access
to PostgreSQL and recovery inputs, receives no container socket, and does not depend on a
model provider or conversation. `npm run backup:predeploy-gate` fails closed when freshness,
checksum, worker, privacy, scope, least privilege, encryption, lifecycle, or restore proof
is missing.

## Security

QM acts with the identity, credentials, and permissions of the person using it, and audits
its work. An organization selects one security posture that narrower scopes may only
tighten:

- **Strict:** each consequential harness tool call pauses for human approval.
- **Auto:** provenance-labelled external content is screened before reaching the model.
- **Dangerous:** content screening and per-tool pauses are disabled, while hard command
  denials still apply.

The predeclared command policy applies in every posture. See [`SECURITY.md`](./SECURITY.md)
for the threat model, operator assumptions, and known limitations.

## Install and verify

Node 26.5.1 and npm 12.0.2 are required.

```bash
npm ci
npm run typecheck
npm test
```

Copy [`.env.example`](./.env.example) to a private environment file, configure the desired
surfaces and harnesses, then run `npm start`. The deployment-directory contract is in
[`deployment.md`](./deployment.md).

## Sync committed source to a remote host

With SSH configured and a clean branch checked out:

```bash
QM_REMOTE_HOST=deploy.example.net npm run sync:remote
```

The command pushes the current branch to `origin`, updates a bare mirror on the selected
host, and materializes an immutable exact-commit checkout. It refuses dirty worktrees,
remote mismatches, unsafe paths, and occupied checkout paths. Container builds and service
restarts remain separate deliberate steps.

The remote mirror and build root default to `/srv/qm/source.git` and `/srv/qm/builds`.
Operators can override them with `QM_REMOTE_MIRROR`, `QM_REMOTE_BUILD_ROOT`, and
`QM_REMOTE_BRANCH`. `QM_PUBLIC_REPO_URL` can select a different read URL.

## Repository relationship

`origin` is the only write target. The `upstream` remote exists solely to fetch or pull
updates from `yc-software/qm`. This project does not push upstream, submit patches, open or
comment on upstream issues or pull requests, participate in upstream discussions or
workflows, or otherwise use upstream as a collaboration channel.

All development, review, security work, branches, releases, and local divergence stay in
this repository. [`AGENTS.md`](./AGENTS.md) is the authoritative instruction for automated
contributors.

## Going deeper

- [`docs/getting-started.md`](./docs/getting-started.md) - first run, end to end
- [`cli/README.md`](./cli/README.md) - CLI and deployment-directory contract
- [`docs/deploy-directory.md`](./docs/deploy-directory.md) - deployment details
- [`.env.example`](./.env.example) - runtime configuration
- [`plugins/`](./plugins) - Slack, Matrix, web, Admin, Portal, and other surfaces

## License

QM derives from `yc-software/qm` and retains its license and copyright notices. Except
where otherwise noted, QM is available under the [MIT License](./LICENSE).
