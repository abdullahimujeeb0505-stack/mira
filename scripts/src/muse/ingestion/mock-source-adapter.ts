import type {
  SourceAdapter,
  SourceConfiguration,
  SourceFetchContext,
  SourceUpdate,
} from "./source-types.js";

export type MockAdapterResponse = SourceUpdate[] | Error;

/**
 * In-memory adapter for deterministic tests and local demonstrations.
 * It performs no network requests.
 */
export class MockSourceAdapter implements SourceAdapter {
  readonly type = "mock";
  private readonly updatesBySource = new Map<string, SourceUpdate[]>();
  private readonly queuedResponses = new Map<string, MockAdapterResponse[]>();
  readonly callsBySource = new Map<string, number>();

  setUpdates(sourceId: string, updates: SourceUpdate[]): void {
    this.updatesBySource.set(sourceId, updates.map((update) => ({ ...update })));
  }

  enqueueResponse(sourceId: string, response: MockAdapterResponse): void {
    const queue = this.queuedResponses.get(sourceId) ?? [];
    queue.push(response);
    this.queuedResponses.set(sourceId, queue);
  }

  async fetchUpdates(
    source: SourceConfiguration,
    context: SourceFetchContext,
  ): Promise<SourceUpdate[]> {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("Source request was aborted.");
    }
    this.callsBySource.set(
      source.id,
      (this.callsBySource.get(source.id) ?? 0) + 1,
    );

    const queued = this.queuedResponses.get(source.id)?.shift();
    if (queued instanceof Error) throw queued;
    const updates = queued ?? this.updatesBySource.get(source.id) ?? [];
    return updates.map((update) => ({
      ...update,
      sourceId: source.id,
      sourceType: source.sourceType,
      retrievedAt: context.retrievedAt,
    }));
  }
}
