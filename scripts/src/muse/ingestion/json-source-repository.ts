import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOpportunityType,
  type OpportunityType,
} from "../opportunities/opportunity-types.js";
import type {
  NewSourceConfiguration,
  SourceConfiguration,
  SourceConfigurationChanges,
  SourceErrorKind,
  SourceErrorRecord,
  SourceRepository,
  SourceState,
} from "./source-types.js";

interface SourceStore {
  sources: SourceConfiguration[];
  states: SourceState[];
}

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../data/muse-sources.json", import.meta.url),
);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_SEEN_UPDATE_IDS = 5_000;

export class JsonSourceRepository implements SourceRepository {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath =
      process.env.MUSE_SOURCES_PATH ?? DEFAULT_FILE_PATH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listSources(): Promise<SourceConfiguration[]> {
    return (await this.readStore()).sources.sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  async getSource(id: string): Promise<SourceConfiguration | undefined> {
    return (await this.readStore()).sources.find((source) => source.id === id);
  }

  async createSource(
    input: NewSourceConfiguration,
  ): Promise<SourceConfiguration> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const timestamp = this.now().toISOString();
      const source = normalizeSourceConfiguration({
        ...input,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (store.sources.some((item) => item.id === source.id)) {
        throw new Error(`Source "${source.id}" is already configured.`);
      }
      store.sources.push(source);
      store.states.push(createInitialState(source.id, timestamp));
      await this.writeStore(store);
      return source;
    });
  }

  async updateSource(
    id: string,
    changes: SourceConfigurationChanges,
  ): Promise<SourceConfiguration | undefined> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const index = store.sources.findIndex((source) => source.id === id);
      if (index < 0) return undefined;
      const current = store.sources[index];
      if (!current) return undefined;
      const updated = normalizeSourceConfiguration({
        ...current,
        ...changes,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: this.now().toISOString(),
      });
      store.sources[index] = updated;
      await this.writeStore(store);
      return updated;
    });
  }

  async removeSource(id: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      const sources = store.sources.filter((source) => source.id !== id);
      if (sources.length === store.sources.length) return false;
      store.sources = sources;
      store.states = store.states.filter((state) => state.sourceId !== id);
      await this.writeStore(store);
      return true;
    });
  }

  async getState(sourceId: string): Promise<SourceState | undefined> {
    return (await this.readStore()).states.find(
      (state) => state.sourceId === sourceId,
    );
  }

  async saveState(state: SourceState): Promise<SourceState> {
    return this.withMutationLock(async () => {
      const store = await this.readStore();
      if (!store.sources.some((source) => source.id === state.sourceId)) {
        throw new Error(`Cannot save state for unconfigured source "${state.sourceId}".`);
      }
      const normalized = normalizeSourceState(state);
      const index = store.states.findIndex(
        (record) => record.sourceId === state.sourceId,
      );
      if (index < 0) store.states.push(normalized);
      else store.states[index] = normalized;
      await this.writeStore(store);
      return normalized;
    });
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readStore(): Promise<SourceStore> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { sources: [], states: [] };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Muse source store is not valid JSON: ${this.filePath}`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sources) || !Array.isArray(parsed.states)) {
      throw new Error(`Muse source store has an invalid format: ${this.filePath}`);
    }
    return {
      sources: parsed.sources.map(normalizeSourceConfiguration),
      states: parsed.states.map(normalizeSourceState),
    };
  }

  private async writeStore(store: SourceStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeSourceConfiguration(value: unknown): SourceConfiguration {
  if (!isRecord(value)) throw new Error("Source configuration must be an object.");
  const id = normalizeText(value.id, "source id");
  const adapterType = normalizeText(value.adapterType, "adapter type").toLowerCase();
  const sourceType = normalizeText(value.sourceType, "source type").toLowerCase();
  const sourceUrl = normalizeHttpUrl(value.sourceUrl, "source URL");
  const pollIntervalMs = normalizeInteger(
    value.pollIntervalMs,
    "poll interval",
    1_000,
    MAX_POLL_INTERVAL_MS,
  );
  const timeoutMs = normalizeInteger(
    value.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeout",
    1,
    MAX_TIMEOUT_MS,
  );
  const enabled = value.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error("Source enabled must be a boolean.");
  }
  const defaultOpportunityType =
    value.defaultOpportunityType === undefined
      ? undefined
      : normalizeOpportunityType(value.defaultOpportunityType);

  return {
    id,
    adapterType,
    sourceType,
    sourceUrl,
    pollIntervalMs,
    timeoutMs,
    ...(defaultOpportunityType ? { defaultOpportunityType } : {}),
    enabled,
    createdAt: normalizeTimestamp(value.createdAt, "source createdAt"),
    updatedAt: normalizeTimestamp(value.updatedAt, "source updatedAt"),
  };
}

function normalizeSourceState(value: unknown): SourceState {
  if (!isRecord(value)) throw new Error("Source state must be an object.");
  const lastCheckedAt = normalizeNullableTimestamp(value.lastCheckedAt, "lastCheckedAt");
  const lastSuccessAt = normalizeNullableTimestamp(value.lastSuccessAt, "lastSuccessAt");
  const rateLimitedUntil = normalizeNullableTimestamp(
    value.rateLimitedUntil,
    "rateLimitedUntil",
  );
  const lastError =
    value.lastError === null
      ? null
      : normalizeSourceError(value.lastError);
  const seenUpdateIds = value.seenUpdateIds;
  if (
    !Array.isArray(seenUpdateIds) ||
    !seenUpdateIds.every((id) => typeof id === "string" && id.length <= 512)
  ) {
    throw new Error("Source state seenUpdateIds must be an array of short strings.");
  }

  return {
    sourceId: normalizeText(value.sourceId, "source state sourceId"),
    lastCheckedAt,
    lastSuccessAt,
    lastError,
    consecutiveFailures: normalizeInteger(
      value.consecutiveFailures,
      "consecutive failures",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    lastAttemptCount: normalizeInteger(
      value.lastAttemptCount,
      "last attempt count",
      0,
      6,
    ),
    rateLimitedUntil,
    seenUpdateIds: [...new Set(seenUpdateIds)].slice(-MAX_SEEN_UPDATE_IDS),
    lastRetrievedCount: normalizeInteger(
      value.lastRetrievedCount,
      "last retrieved count",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    lastProcessedCount: normalizeInteger(
      value.lastProcessedCount,
      "last processed count",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    lastDuplicateCount: normalizeInteger(
      value.lastDuplicateCount,
      "last duplicate count",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    updatedAt: normalizeTimestamp(value.updatedAt, "source state updatedAt"),
  };
}

function normalizeSourceError(value: unknown): SourceErrorRecord {
  if (!isRecord(value)) throw new Error("Source error must be an object.");
  const kinds: SourceErrorKind[] = ["FETCH", "TIMEOUT", "RATE_LIMIT", "UPDATE"];
  if (typeof value.kind !== "string" || !kinds.includes(value.kind as SourceErrorKind)) {
    throw new Error("Source error kind is not supported.");
  }
  const retryAt =
    value.retryAt === undefined
      ? undefined
      : normalizeTimestamp(value.retryAt, "source error retryAt");
  return {
    at: normalizeTimestamp(value.at, "source error at"),
    kind: value.kind as SourceErrorKind,
    message: normalizeText(value.message, "source error message").slice(0, 500),
    attempts: normalizeInteger(value.attempts, "source error attempts", 0, 6),
    ...(retryAt ? { retryAt } : {}),
  };
}

function normalizeOpportunityType(value: unknown): OpportunityType {
  if (typeof value !== "string" || !isOpportunityType(value)) {
    throw new Error("Default opportunity type is not supported.");
  }
  return value.toUpperCase() as OpportunityType;
}

function normalizeHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be an absolute HTTP or HTTPS URL.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTP or HTTPS URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`${field} must be an HTTP or HTTPS URL without embedded credentials.`);
  }
  return url.toString();
}

function normalizeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Source ${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return value;
}

function normalizeNullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : normalizeTimestamp(value, field);
}

function createInitialState(sourceId: string, timestamp: string): SourceState {
  return {
    sourceId,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastAttemptCount: 0,
    rateLimitedUntil: null,
    seenUpdateIds: [],
    lastRetrievedCount: 0,
    lastProcessedCount: 0,
    lastDuplicateCount: 0,
    updatedAt: timestamp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
