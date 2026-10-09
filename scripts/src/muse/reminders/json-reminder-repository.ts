import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Reminder,
  ReminderFilters,
  ReminderRepository,
} from "./reminder-types.js";
import { normalizeReminder } from "./reminder-validation.js";

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../data/muse-reminders.json", import.meta.url),
);

export class JsonReminderRepository implements ReminderRepository {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath =
      process.env.MUSE_REMINDERS_PATH ?? DEFAULT_FILE_PATH,
  ) {}

  async list(filters: ReminderFilters = {}): Promise<Reminder[]> {
    return (await this.readAll())
      .filter((reminder) => !filters.status || reminder.status === filters.status)
      .filter((reminder) => !filters.type || reminder.type === filters.type)
      .filter(
        (reminder) =>
          !filters.trackingOpportunityId ||
          reminder.trackingOpportunityId === filters.trackingOpportunityId,
      )
      .filter((reminder) => !filters.origin || reminder.origin === filters.origin)
      .sort(
        (left, right) =>
          left.scheduledAt.localeCompare(right.scheduledAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async get(id: string): Promise<Reminder | undefined> {
    return (await this.readAll()).find((reminder) => reminder.id === id);
  }

  async findByDeduplicationKey(key: string): Promise<Reminder | undefined> {
    return (await this.readAll()).find(
      (reminder) => reminder.deduplicationKey === key,
    );
  }

  async create(reminder: Reminder): Promise<Reminder> {
    return this.withMutationLock(async () => {
      const reminders = await this.readAll();
      const normalized = normalizeReminder(reminder);
      if (reminders.some((item) => item.id === normalized.id)) {
        throw new Error("Reminder ID already exists.");
      }
      if (
        reminders.some(
          (item) => item.deduplicationKey === normalized.deduplicationKey,
        )
      ) {
        throw new Error("Reminder deduplication key already exists.");
      }
      reminders.push(normalized);
      await this.writeAll(reminders);
      return normalized;
    });
  }

  async replace(reminder: Reminder): Promise<Reminder | undefined> {
    return this.withMutationLock(async () => {
      const reminders = await this.readAll();
      const index = reminders.findIndex((item) => item.id === reminder.id);
      if (index < 0) return undefined;
      const normalized = normalizeReminder(reminder);
      if (
        reminders.some(
          (item) =>
            item.id !== normalized.id &&
            item.deduplicationKey === normalized.deduplicationKey,
        )
      ) {
        throw new Error("Reminder deduplication key already exists.");
      }
      reminders[index] = normalized;
      await this.writeAll(reminders);
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

  private async readAll(): Promise<Reminder[]> {
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
      throw new Error(`Muse reminder store is not valid JSON: ${this.filePath}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Muse reminder store has an invalid format: ${this.filePath}`);
    }
    const reminders = parsed.map(normalizeReminder);
    if (new Set(reminders.map((reminder) => reminder.id)).size !== reminders.length) {
      throw new Error("Muse reminder store contains duplicate IDs.");
    }
    if (
      new Set(reminders.map((reminder) => reminder.deduplicationKey)).size !==
      reminders.length
    ) {
      throw new Error("Muse reminder store contains duplicate deduplication keys.");
    }
    return reminders;
  }

  private async writeAll(reminders: Reminder[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(reminders, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
