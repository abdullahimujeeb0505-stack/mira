import { systemRuntime, type SchedulerRuntime } from "./runtime.js";
import type { SourceIngestionService } from "./source-ingestion-service.js";
import type { SourceRepository, SourceRunResult } from "./source-types.js";

export class SourceScheduler {
  private readonly runtime: SchedulerRuntime;
  private readonly timers = new Map<string, unknown>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private started = false;

  constructor(
    private readonly repository: SourceRepository,
    private readonly ingestionService: SourceIngestionService,
    runtime: SchedulerRuntime = systemRuntime,
  ) {
    this.runtime = runtime;
  }

  async runOnce(): Promise<SourceRunResult[]> {
    const sources = await this.repository.listSources();
    return Promise.all(
      sources.map(async (source) => {
        try {
          return await this.ingestionService.runSource(source.id);
        } catch (error) {
          return {
            sourceId: source.id,
            status: "FAILED" as const,
            attempts: 0,
            retrieved: 0,
            processed: 0,
            duplicates: 0,
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`.slice(0, 500)
                : "Source run failed.",
          };
        }
      }),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const sources = await this.repository.listSources();
    for (const source of sources) {
      if (source.enabled) this.schedule(source.id, 0);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.timers.values()) {
      this.runtime.clearTimeout(timer);
    }
    this.timers.clear();
    await Promise.all([...this.activeRuns.values()]);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.activeRuns.values()]);
  }

  private schedule(sourceId: string, delayMs: number): void {
    if (!this.started) return;
    const current = this.timers.get(sourceId);
    if (current !== undefined) this.runtime.clearTimeout(current);
    const timer = this.runtime.setTimeout(() => {
      this.timers.delete(sourceId);
      if (this.started) this.launchScheduledRun(sourceId);
    }, delayMs);
    this.timers.set(sourceId, timer);
  }

  private launchScheduledRun(sourceId: string): void {
    const active = (async () => {
      try {
        await this.ingestionService.runSource(sourceId);
      } catch {
        // runSource normally returns a failure result; scheduler ticks must stay isolated.
      } finally {
        this.activeRuns.delete(sourceId);
        await this.scheduleNext(sourceId);
      }
    })();
    this.activeRuns.set(sourceId, active);
  }

  private async scheduleNext(sourceId: string): Promise<void> {
    if (!this.started) return;
    try {
      const source = await this.repository.getSource(sourceId);
      if (source?.enabled) this.schedule(sourceId, source.pollIntervalMs);
    } catch {
      // A storage error must not create an unhandled rejection or stop other sources.
    }
  }
}
