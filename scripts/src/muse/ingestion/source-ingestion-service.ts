import { DefaultSourceUpdateMapper } from "./source-update-mapper.js";
import { systemRuntime, type SchedulerRuntime } from "./runtime.js";
import type { SourceRegistry } from "./source-registry.js";
import type { WatchService } from "../watch/watch-service.js";
import type {
  SourceAdapter,
  SourceConfiguration,
  SourceErrorKind,
  SourceRepository,
  SourceRunResult,
  SourceState,
  SourceUpdate,
  SourceUpdateMapper,
} from "./source-types.js";
import type { WatchUpdate } from "../watch/watch-types.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 4_000;
const DEFAULT_MAX_RATE_LIMIT_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_MAX_UPDATES_PER_FETCH = 500;
const MAX_RETRIES_LIMIT = 5;
const MAX_RECORDED_UPDATE_IDS = 5_000;
const MAX_UPDATE_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 1_000;
const MAX_TEXT_LENGTH = 20_000;

export interface SourceIngestionServiceOptions {
  runtime?: SchedulerRuntime;
  mapper?: SourceUpdateMapper;
  maxRetries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRateLimitDelayMs?: number;
  maxUpdatesPerFetch?: number;
}

export class SourceRateLimitError extends Error {
  constructor(
    message = "Source rate limit reached.",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SourceRateLimitError";
  }
}

export class SourceTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Source request timed out after ${timeoutMs}ms.`);
    this.name = "SourceTimeoutError";
  }
}

interface FetchOutcome {
  updates: SourceUpdate[];
  attempts: number;
}

interface FetchFailure {
  error: unknown;
  attempts: number;
  kind: SourceErrorKind;
  retryAt?: string;
}

export class SourceIngestionService {
  private readonly runtime: SchedulerRuntime;
  private readonly mapper: SourceUpdateMapper;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRateLimitDelayMs: number;
  private readonly maxUpdatesPerFetch: number;
  private readonly inFlightSources = new Set<string>();
  private updateProcessingQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: SourceRepository,
    private readonly registry: SourceRegistry,
    private readonly watchService: WatchService,
    options: SourceIngestionServiceOptions = {},
  ) {
    this.runtime = options.runtime ?? systemRuntime;
    this.mapper = options.mapper ?? new DefaultSourceUpdateMapper();
    this.maxRetries = boundedInteger(
      options.maxRetries ?? DEFAULT_MAX_RETRIES,
      0,
      MAX_RETRIES_LIMIT,
    );
    this.retryDelayMs = boundedInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      0,
      DEFAULT_MAX_RETRY_DELAY_MS,
    );
    this.maxRetryDelayMs = boundedInteger(
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      0,
      60_000,
    );
    this.maxRateLimitDelayMs = boundedInteger(
      options.maxRateLimitDelayMs ?? DEFAULT_MAX_RATE_LIMIT_DELAY_MS,
      1_000,
      24 * 60 * 60 * 1000,
    );
    this.maxUpdatesPerFetch = boundedInteger(
      options.maxUpdatesPerFetch ?? DEFAULT_MAX_UPDATES_PER_FETCH,
      1,
      5_000,
    );
  }

  async runSource(sourceId: string): Promise<SourceRunResult> {
    if (this.inFlightSources.has(sourceId)) {
      return skippedResult(sourceId, "A run for this source is already in progress.");
    }
    this.inFlightSources.add(sourceId);
    try {
      return await this.runSourceOnce(sourceId);
    } catch (error) {
      return {
        sourceId,
        status: "FAILED",
        attempts: 0,
        retrieved: 0,
        processed: 0,
        duplicates: 0,
        error: sanitizeError(error),
      };
    } finally {
      this.inFlightSources.delete(sourceId);
    }
  }

  async listConfiguredSources(): Promise<SourceConfiguration[]> {
    return this.repository.listSources();
  }

  private async runSourceOnce(sourceId: string): Promise<SourceRunResult> {
    const source = await this.repository.getSource(sourceId);
    if (!source) {
      return failedResult(sourceId, "Source is not configured.");
    }
    if (!source.enabled) {
      return skippedResult(sourceId, "Source is disabled.");
    }

    const adapter = this.registry.get(source.adapterType);
    if (!adapter) {
      return this.recordFailure(
        source,
        await this.loadState(source.id),
        new Error(`Adapter "${source.adapterType}" is not registered.`),
        "FETCH",
        0,
      );
    }
    if (!this.registry.isEnabled(source.adapterType)) {
      return skippedResult(sourceId, `Adapter "${source.adapterType}" is disabled.`);
    }

    const state = await this.loadState(source.id);
    if (
      state.rateLimitedUntil &&
      Date.parse(state.rateLimitedUntil) > this.runtime.now().getTime()
    ) {
      return {
        ...skippedResult(sourceId, "Rate-limit cooldown is active."),
        retryAt: state.rateLimitedUntil,
      };
    }

    const startedAt = this.runtime.now().toISOString();
    await this.repository.saveState({
      ...state,
      lastCheckedAt: startedAt,
      updatedAt: startedAt,
    });

    let fetched: FetchOutcome;
    try {
      fetched = await this.fetchWithRetries(adapter, source);
    } catch (failure) {
      const details = failure as FetchFailure;
      return this.recordFailure(
        source,
        state,
        details.error,
        details.kind,
        details.attempts,
        details.retryAt,
      );
    }

    if (fetched.updates.length > this.maxUpdatesPerFetch) {
      return this.recordFailure(
        source,
        state,
        new Error(
          `Adapter returned ${fetched.updates.length} updates; limit is ${this.maxUpdatesPerFetch}.`,
        ),
        "UPDATE",
        fetched.attempts,
      );
    }

    const retrievedAt = this.runtime.now().toISOString();
    const seen = new Set(state.seenUpdateIds);
    const updateErrors: unknown[] = [];
    let processed = 0;
    let duplicates = 0;
    for (const rawUpdate of fetched.updates) {
      try {
        const update = normalizeSourceUpdate(rawUpdate, source, retrievedAt);
        if (seen.has(update.id)) {
          duplicates += 1;
          continue;
        }

        const watchUpdate = this.mapper.toWatchUpdate(update, source);
        const result = await this.processWatchUpdate(watchUpdate);
        seen.add(update.id);
        processed += 1;
        if (result.evaluation?.duplicate) duplicates += 1;
      } catch (error) {
        updateErrors.push(error);
      }
    }

    const completedAt = this.runtime.now().toISOString();
    const nextState: SourceState = {
      ...state,
      lastCheckedAt: startedAt,
      lastAttemptCount: fetched.attempts,
      lastRetrievedCount: fetched.updates.length,
      lastProcessedCount: processed,
      lastDuplicateCount: duplicates,
      seenUpdateIds: [...seen].slice(-MAX_RECORDED_UPDATE_IDS),
      updatedAt: completedAt,
    };

    if (updateErrors.length > 0) {
      const firstError = updateErrors[0];
      const message = sanitizeError(firstError);
      await this.repository.saveState({
        ...nextState,
        consecutiveFailures: state.consecutiveFailures + 1,
        lastError: {
          at: completedAt,
          kind: "UPDATE",
          message,
          attempts: fetched.attempts,
        },
      });
      return {
        sourceId,
        status: processed > 0 || duplicates > 0 ? "PARTIAL" : "FAILED",
        attempts: fetched.attempts,
        retrieved: fetched.updates.length,
        processed,
        duplicates,
        error: message,
      };
    }

    await this.repository.saveState({
      ...nextState,
      lastSuccessAt: completedAt,
      lastError: null,
      consecutiveFailures: 0,
      rateLimitedUntil: null,
    });
    return {
      sourceId,
      status: "SUCCESS",
      attempts: fetched.attempts,
      retrieved: fetched.updates.length,
      processed,
      duplicates,
    };
  }

  private async loadState(sourceId: string): Promise<SourceState> {
    const state = await this.repository.getState(sourceId);
    if (!state) {
      throw new Error(`Source state is missing for "${sourceId}".`);
    }
    return state;
  }

  private processWatchUpdate(update: WatchUpdate) {
    const result = this.updateProcessingQueue.then(() =>
      this.watchService.processUpdate(update),
    );
    this.updateProcessingQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async fetchWithRetries(
    adapter: SourceAdapter,
    source: SourceConfiguration,
  ): Promise<FetchOutcome> {
    const maximumAttempts = this.maxRetries + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const updates = await this.fetchWithTimeout(adapter, source);
        if (!Array.isArray(updates)) {
          throw new Error("Adapter response must be an array of source updates.");
        }
        return { updates, attempts: attempt };
      } catch (error) {
        if (error instanceof SourceRateLimitError) {
          const retryDelay = Math.min(
            this.maxRateLimitDelayMs,
            Math.max(
              1_000,
              error.retryAfterMs ?? source.pollIntervalMs,
            ),
          );
          const retryAt = new Date(
            this.runtime.now().getTime() + retryDelay,
          ).toISOString();
          throw {
            error,
            attempts: attempt,
            kind: "RATE_LIMIT",
            retryAt,
          } satisfies FetchFailure;
        }

        lastError = error;
        if (attempt >= maximumAttempts) break;
        await this.runtime.sleep(
          Math.min(
            this.maxRetryDelayMs,
            this.retryDelayMs * 2 ** (attempt - 1),
          ),
        );
      }
    }

    throw {
      error: lastError,
      attempts: maximumAttempts,
      kind: lastError instanceof SourceTimeoutError ? "TIMEOUT" : "FETCH",
    } satisfies FetchFailure;
  }

  private async fetchWithTimeout(
    adapter: SourceAdapter,
    source: SourceConfiguration,
  ): Promise<SourceUpdate[]> {
    const controller = new AbortController();
    let timeoutHandle: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.runtime.setTimeout(() => {
        const error = new SourceTimeoutError(source.timeoutMs);
        controller.abort(error);
        reject(error);
      }, source.timeoutMs);
    });

    try {
      return await Promise.race([
        adapter.fetchUpdates(source, {
          signal: controller.signal,
          retrievedAt: this.runtime.now().toISOString(),
        }),
        timeout,
      ]);
    } finally {
      this.runtime.clearTimeout(timeoutHandle);
    }
  }

  private async recordFailure(
    source: SourceConfiguration,
    state: SourceState,
    error: unknown,
    kind: SourceErrorKind,
    attempts: number,
    retryAt?: string,
  ): Promise<SourceRunResult> {
    const now = this.runtime.now().toISOString();
    const message = sanitizeError(error);
    const rateLimitedUntil = kind === "RATE_LIMIT" ? retryAt ?? null : null;
    await this.repository.saveState({
      ...state,
      lastCheckedAt: now,
      lastAttemptCount: attempts,
      lastError: {
        at: now,
        kind,
        message,
        attempts,
        ...(retryAt ? { retryAt } : {}),
      },
      consecutiveFailures: state.consecutiveFailures + 1,
      rateLimitedUntil,
      lastRetrievedCount: 0,
      lastProcessedCount: 0,
      lastDuplicateCount: 0,
      updatedAt: now,
    });
    return {
      sourceId: source.id,
      status: "FAILED",
      attempts,
      retrieved: 0,
      processed: 0,
      duplicates: 0,
      error: message,
      ...(retryAt ? { retryAt } : {}),
    };
  }
}

function normalizeSourceUpdate(
  value: unknown,
  source: SourceConfiguration,
  retrievedAt: string,
): SourceUpdate {
  if (!isRecord(value)) throw new Error("Adapter returned a non-object update.");
  const id = normalizeText(value.id, "update id");
  if (id.length > MAX_UPDATE_ID_LENGTH) {
    throw new Error("Source update ID is too long.");
  }
  if (value.sourceId !== source.id) {
    throw new Error(`Adapter returned an update for unexpected source "${String(value.sourceId)}".`);
  }
  if (
    typeof value.sourceType !== "string" ||
    value.sourceType.toLowerCase() !== source.sourceType
  ) {
    throw new Error("Adapter returned an update with a mismatched source type.");
  }
  const title = normalizeText(value.title, "update title");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error("Source update title is too long.");
  }
  if (typeof value.text !== "string" || value.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Source update text must be a string of ${MAX_TEXT_LENGTH} characters or fewer.`);
  }
  const sourceUrl =
    value.sourceUrl === null
      ? null
      : normalizeUpdateUrl(value.sourceUrl);
  const publishedAt =
    value.publishedAt === null
      ? null
      : normalizeTimestamp(value.publishedAt, "publishedAt");
  return {
    id,
    sourceId: source.id,
    sourceType: source.sourceType,
    sourceUrl,
    title,
    text: value.text.trim(),
    publishedAt,
    retrievedAt,
  };
}

function normalizeUpdateUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Source update sourceUrl must be null or a URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Source update sourceUrl must be an absolute HTTP or HTTPS URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("Source update sourceUrl must be an HTTP or HTTPS URL without embedded credentials.");
  }
  return url.toString();
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Source update ${field} must be a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Source ${field} cannot be empty.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : "Unknown source error.";
  return message
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|password|authorization|signature)\b(\s*[:=]\s*)[^\s,;&]+/gi,
      "$1$2[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|signature)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .slice(0, 500);
}

function skippedResult(sourceId: string, error: string): SourceRunResult {
  return {
    sourceId,
    status: "SKIPPED",
    attempts: 0,
    retrieved: 0,
    processed: 0,
    duplicates: 0,
    error,
  };
}

function failedResult(sourceId: string, error: string): SourceRunResult {
  return {
    sourceId,
    status: "FAILED",
    attempts: 0,
    retrieved: 0,
    processed: 0,
    duplicates: 0,
    error,
  };
}
