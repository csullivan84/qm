export interface ReloadableSurfaceConfig<Config> {
  version: string;
  config: Config;
}

export function createSurfaceRuntimeReconciler<Config>(opts: {
  load: () => Promise<ReloadableSurfaceConfig<Config> | null>;
  startPlugin: (config: Config) => Promise<{ stop(): Promise<void>; done?: Promise<void> }>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  let active: {
    plugin: { stop(): Promise<void>; done?: Promise<void> };
    version: string;
    config: Config;
  } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let closing = false;

  const activate = (
    plugin: { stop(): Promise<void>; done?: Promise<void> },
    desired: ReloadableSurfaceConfig<Config>,
  ) => {
    const current = { plugin, version: desired.version, config: desired.config };
    active = current;
    plugin.done?.then(
      () => {
        if (active !== current) return;
        active = null;
        if (!closing) tick();
      },
      (error) => {
        if (active !== current) return;
        active = null;
        opts.onError?.(error);
        if (!closing) tick();
      },
    );
  };

  const reconcile = async (): Promise<void> => {
    const desired = await opts.load();
    if (!desired) {
      if (active) {
        await active.plugin.stop();
        active = null;
      }
      return;
    }
    if (desired.version === active?.version) return;
    const previous = active;
    if (previous) {
      await previous.plugin.stop();
      active = null;
    }
    try {
      const plugin = await opts.startPlugin(desired.config);
      activate(plugin, desired);
    } catch (error) {
      if (previous) {
        try {
          const plugin = await opts.startPlugin(previous.config);
          activate(plugin, previous);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Surface reload and rollback both failed", {
            cause: rollbackError,
          });
        }
      }
      throw error;
    }
  };

  const run = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const tick = (): void => {
    void run().catch((error) => opts.onError?.(error));
  };

  return {
    start() {
      closing = false;
      tick();
      timer = setInterval(tick, opts.intervalMs ?? 5_000);
      timer.unref();
    },
    reconcile: run,
    async stop() {
      closing = true;
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
      if (active) {
        await active.plugin.stop();
        active = null;
      }
    },
  };
}
