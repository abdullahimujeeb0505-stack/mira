import type { OpportunityType } from "../opportunities/opportunity-types.js";
import type { WatchUpdate } from "../watch/watch-types.js";

export interface SourceUpdate {
  /** Stable update key within sourceId, used for repeat-delivery deduplication. */
  id: string;
  /** Stable identifier of the configured source. */
  sourceId: string;
  /** Provider-neutral source classification such as "feed" or "website". */
  sourceType: string;
  sourceUrl: string | null;
  title: string;
  /** Untrusted source text or summary. It is data only and is never executed. */
  text: string;
  publishedAt: string | null;
  retrievedAt: string;
}

export interface SourceConfiguration {
  id: string;
  adapterType: string;
  sourceType: string;
  sourceUrl: string;
  pollIntervalMs: number;
  timeoutMs: number;
  defaultOpportunityType?: OpportunityType;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewSourceConfiguration {
  id: string;
  adapterType: string;
  sourceType: string;
  sourceUrl: string;
  pollIntervalMs: number;
  timeoutMs?: number;
  defaultOpportunityType?: OpportunityType;
  enabled?: boolean;
}

export type SourceConfigurationChanges = Partial<
  Omit<NewSourceConfiguration, "id">
>;

export type SourceErrorKind =
  | "FETCH"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "UPDATE";

export interface SourceErrorRecord {
  at: string;
  kind: SourceErrorKind;
  message: string;
  attempts: number;
  retryAt?: string;
}

export interface SourceState {
  sourceId: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: SourceErrorRecord | null;
  consecutiveFailures: number;
  lastAttemptCount: number;
  rateLimitedUntil: string | null;
  seenUpdateIds: string[];
  lastRetrievedCount: number;
  lastProcessedCount: number;
  lastDuplicateCount: number;
  updatedAt: string;
}

export interface SourceRepository {
  listSources(): Promise<SourceConfiguration[]>;
  getSource(id: string): Promise<SourceConfiguration | undefined>;
  createSource(input: NewSourceConfiguration): Promise<SourceConfiguration>;
  updateSource(
    id: string,
    changes: SourceConfigurationChanges,
  ): Promise<SourceConfiguration | undefined>;
  removeSource(id: string): Promise<boolean>;
  getState(sourceId: string): Promise<SourceState | undefined>;
  saveState(state: SourceState): Promise<SourceState>;
}

export interface SourceFetchContext {
  signal: AbortSignal;
  retrievedAt: string;
}

export interface SourceAdapter {
  /** Stable adapter key used by SourceConfiguration.adapterType. */
  readonly type: string;
  fetchUpdates(
    source: SourceConfiguration,
    context: SourceFetchContext,
  ): Promise<SourceUpdate[]>;
}

export interface SourceUpdateMapper {
  toWatchUpdate(
    update: SourceUpdate,
    source: SourceConfiguration,
  ): WatchUpdate;
}

export type SourceRunStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED";

export interface SourceRunResult {
  sourceId: string;
  status: SourceRunStatus;
  attempts: number;
  retrieved: number;
  processed: number;
  duplicates: number;
  error?: string;
  retryAt?: string;
}
