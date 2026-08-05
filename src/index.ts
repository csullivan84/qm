import { baseModelProviders, configuredModelForHarness, loadConfig, providerKeysPresent } from "./config.ts";
import { buildApp, stopWithBackstop } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { errMessage } from "./util/errors.ts";
import { defaultModelForHarness, modelProviderAvailabilityFor } from "./model/pi-models.ts";
import { effectiveEgressEnforcement } from "./sandbox/sandbox.ts";
import { slackPluginConfigFromEnv, startSlackPlugin } from "./slack/index.ts";
import { matrixPluginConfigFromEnv, type MatrixPluginConfig } from "./matrix/config.ts";
import { startMatrixPlugin } from "./matrix/plugin.ts";
import { createSurfaceRuntimeReconciler } from "./surfaces/runtime.ts";

const config = loadConfig();

const built = buildApp(config);
const envMatrixAttempted = Object.keys(process.env).some((key) => key.startsWith("MATRIX_"));
let matrixConfig: ReturnType<typeof matrixPluginConfigFromEnv> = null;
let matrixEnvironmentState: "absent" | "configured" | "partial" = "absent";
try {
  matrixConfig = matrixPluginConfigFromEnv(process.env);
  if (matrixConfig) matrixEnvironmentState = "configured";
  else if (envMatrixAttempted) matrixEnvironmentState = "partial";
} catch (error) {
  matrixEnvironmentState = "partial";
  console.error(`[qm] Matrix environment configuration is invalid: ${errMessage(error)}`);
}
const envSlackConfig = slackPluginConfigFromEnv(process.env);
const slackConfig = envSlackConfig;
const envSlackAttempted = Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
let slackEnvironmentState: "absent" | "configured" | "partial" = "absent";
if (slackConfig) slackEnvironmentState = "configured";
else if (envSlackAttempted) slackEnvironmentState = "partial";
const server = createServer(built.app, {
  production: config.production,
  allowUnauthenticatedCore: config.allowUnauthenticatedCore,
  ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
  ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
  ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
  ...(config.requireSignedPortalIdentity ? { requireSignedPortalIdentity: true } : {}),
  ...(built.replayDedupe ? { replayDedupe: built.replayDedupe } : {}),
  localAuth: built.localAuth,
  config: built.config,
  baseModelDefault: defaultModelForHarness(
    config.harness,
    configuredModelForHarness(config, config.harness),
    baseModelProviders(config),
  ),
  modelProviders: modelProviderAvailabilityFor(config.harness, providerKeysPresent(config)),
  providerKeys: providerKeysPresent(config),
  modelCredentials: built.modelCredentials,
  ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
  harnessId: config.harness,
  connectorTokens: built.connectorTokens,
  slackInstallation: built.slackInstallation,
  slackEnvironmentState,
  matrixInstallation: built.matrixInstallation,
  matrixInstallationDurable: built.matrixInstallationDurable,
  matrixEnvironmentState,
  matrixSyncCursorPath: matrixConfig?.syncCursorPath ?? `${config.dataDir}/matrix-sync-cursor`,
  backup: built.backup,
  backupManagementDurable: built.backupManagementDurable,
  resolveClient: built.resolveClient,
  consentLinks: built.consentLinks,
  secretDrops: built.secretDrops,
  ...(built.fireDropResolution ? { fireDropResolution: built.fireDropResolution } : {}),
  ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
  ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
  admin: built.admin,
  rateLimiter: built.rateLimiter,
  acl: built.acl,
  credentialUsage: built.credentialUsage,
  deviceFlowCutover: built.deviceFlowCutover,
  egressAudit: built.egressAudit,
  sessions: built.sessions,
  auditLog: built.auditLog,
  errors: built.errors,
  metrics: built.metrics,
  crons: built.crons,
  brokeredServices: () => built.brokeredTools.map((tool) => tool.service),
  deploymentLayer: built.deploymentLayerStore,
  deployDialTimeoutMs: config.deployDialTimeoutMs,
  ...(config.awsDeploy.appsDomain ? { deployAppsDomain: config.awsDeploy.appsDomain } : {}),
  ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
  ...(config.deployAppsSessionSecret ? { deployAppsSessionSecret: config.deployAppsSessionSecret } : {}),
  ...(config.deployAppsLoginUrl ? { deployAppsLoginUrl: config.deployAppsLoginUrl } : {}),
  scheduler: built.scheduler,
  identity: built.identity,
  ...(built.keychain ? { keychain: built.keychain } : {}),
  serviceCreds: built.serviceCreds,
  deliveries: built.deliveries,
  ...(built.fireAskResolution ? { fireAskResolution: built.fireAskResolution } : {}),
  runs: built.runs,
  workspace: built.workspace,
  files: built.files,
  memory: built.memory,
  blobTransfer: built.blobTransfer,
  sandboxBackend: built.sandbox.profile.backend,
  egressDeclaredEnforcement: built.sandbox.profile.egressEnforcement ?? "none",
  egressEnforcement: effectiveEgressEnforcement(built.sandbox.profile, {
    signingSecret: config.signingSecret,
    apiBaseUrl: config.apiBaseUrl,
  }),
  sandbox: built.sandbox,
  advisoryLock: built.advisoryLock,
  ...(built.processes ? { processes: built.processes } : {}),
  ...(built.browserSessionStore ? { browserSessionStore: built.browserSessionStore } : {}),
  directory: built.directory,
  ...(built.ambientJudgments ? { ambientJudgments: built.ambientJudgments } : {}),
  ...(built.ackEmojiPicks ? { ackEmojiPicks: built.ackEmojiPicks } : {}),
  channelPolicy: built.channelPolicy,
  environments: built.environments,
  sandboxMigration: built.sandboxMigration,
});

await built.config.hydrate?.();
await built.identity.hydrate();
await built.localAuthReady;
await built.deploymentLayerReady;
built.deploymentLayerRefresh.start();
built.runtime.start();

server.listen(config.port, () => {
  console.log(
    `[qm] listening on :${config.port} (org=${config.orgId}, store=${config.sessionStore}, ` +
      `runStore=${config.runStore}, workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled})`,
  );
});

if (config.backgroundWorkEnabled) {
  built.scheduler.start(1000);
} else {
  console.log("[qm] background work disabled; scheduler and runtime loops will not start");
}

const slackRuntime = createSurfaceRuntimeReconciler({
  load: async () => {
    const status = await built.slackInstallation.status();
    const stored = await built.slackInstallation.get();
    if (stored) {
      const dynamic = slackPluginConfigFromEnv({
        ...process.env,
        SLACK_BOT_TOKEN: stored.botToken,
        SLACK_APP_TOKEN: stored.appToken,
      });
      return dynamic ? { version: stored.version, config: dynamic } : null;
    }
    if (status.managed) return null;
    if (slackConfig) return { version: "environment", config: slackConfig };
    return null;
  },
  startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
  onError: (error) => console.error(`[qm] slack plugin reconciliation failed: ${errMessage(error)}`),
});
slackRuntime.start();

const matrixRuntime = createSurfaceRuntimeReconciler<{
  plugin: MatrixPluginConfig;
  syncGeneration?: string;
  installationVersion?: string;
}>({
  load: async () => {
    const runtime = await built.matrixInstallation.runtime();
    if (runtime) {
      return {
        version: runtime.version,
        config: {
          plugin: runtime.config,
          syncGeneration: runtime.syncGeneration,
          installationVersion: runtime.version,
        },
      };
    }
    const status = await built.matrixInstallation.status();
    if (status.managed) return null;
    return matrixConfig ? { version: "environment", config: { plugin: matrixConfig } } : null;
  },
  startPlugin: (desired) =>
    startMatrixPlugin(
      desired.plugin,
      {
        turn: built.app.turn,
        ingestSurfaceEvents: built.app.ingestSurfaceEvents,
        readSurfaceMessages: built.app.readSurfaceMessages,
        getApproval: built.app.getApproval,
        stageBlob: built.slackCore.stageBlob,
        readBlob: built.slackCore.readBlob,
      },
      fetch,
      built.matrixSyncState,
      desired.syncGeneration,
      desired.installationVersion
        ? {
            acquire: (token, expiresAt) =>
              built.matrixInstallation.acquireProcessingLease(desired.installationVersion!, token, expiresAt),
            renew: (token, expiresAt) => built.matrixInstallation.renewProcessingLease(token, expiresAt),
            release: (token) => built.matrixInstallation.releaseProcessingLease(token),
          }
        : undefined,
    ),
  onError: (error) => console.error(`[qm] matrix plugin reconciliation failed: ${errMessage(error)}`),
});
matrixRuntime.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  built.scheduler.stop();
  built.deploymentLayerRefresh.stop();
  server.close();
  server.closeIdleConnections();
  stopWithBackstop(
    {
      start: () => built.runtime.start(),
      releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
      stop: async () => {
        const stopped = await Promise.allSettled([slackRuntime.stop(), matrixRuntime.stop(), built.runtime.stop()]);
        const failures = stopped.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "surface shutdown failed",
          );
      },
    },
    config.shutdownDrainMs,
    "qm",
    () => server.closeAllConnections(),
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
