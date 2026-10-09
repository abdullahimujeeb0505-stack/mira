import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTrackedOpportunity } from "./tracking-validation.js";
import type {
  TrackedOpportunity,
  TrackingFilters,
  TrackingRepository,
} from "./tracking-types.js";

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../../data/muse-tracked-opportunities.json", import.meta.url),
);

export class JsonTrackingRepository implements TrackingRepository {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath =
      process.env.MUSE_TRACKED_OPPORTUNITIES_PATH ?? DEFAULT_FILE_PATH,
  ) {}

  async list(filters: TrackingFilters = {}): Promise<TrackedOpportunity[]> {
    return (await this.readAll())
      .filter((record) => !filters.status || record.status === filters.status)
      .filter((record) => !filters.category || record.category === filters.category)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async get(id: string): Promise<TrackedOpportunity | undefined> {
    return (await this.readAll()).find((record) => record.id === id);
  }

  async create(record: TrackedOpportunity): Promise<TrackedOpportunity> {
    return this.withMutationLock(async () => {
      const records = await this.readAll();
      const normalized = normalizeTrackedOpportunity(record);
      if (records.some((item) => item.id === normalized.id)) {
        throw new Error("Tracked opportunity ID already exists.");
      }
      records.push(normalized);
      await this.writeAll(records);
      return normalized;
    });
  }

  async replace(record: TrackedOpportunity): Promise<TrackedOpportunity | undefined> {
    return this.withMutationLock(async () => {
      const records = await this.readAll();
      const index = records.findIndex((item) => item.id === record.id);
      if (index < 0) return undefined;
      const normalized = normalizeTrackedOpportunity(record);
      records[index] = normalized;
      await this.writeAll(records);
      return normalized;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      const records = await this.readAll();
      const remaining = records.filter((record) => record.id !== id);
      if (remaining.length === records.length) return false;
      await this.writeAll(remaining);
      return true;
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

  private async readAll(): Promise<TrackedOpportunity[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Muse tracked-opportunity store is not valid JSON: ${this.filePath}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Muse tracked-opportunity store has an invalid format: ${this.filePath}`);
    }
    const records = parsed.map(normalizeTrackedOpportunity);
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new Error("Muse tracked-opportunity store contains duplicate IDs.");
    }
    return records;
  }

  private async writeAll(records: TrackedOpportunity[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
