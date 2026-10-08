import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MemoryCategory,
  MemoryRecord,
  MemoryRepository,
  NewMemory,
} from "./memory-types.js";
import { isMemoryCategory } from "./memory-types.js";

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../data/muse-memory.json", import.meta.url),
);

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "how",
  "is",
  "it",
  "me",
  "my",
  "of",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "who",
  "with",
]);

export class JsonMemoryRepository implements MemoryRepository {
  private readonly filePath: string;

  constructor(filePath = process.env.MUSE_MEMORY_PATH ?? DEFAULT_FILE_PATH) {
    this.filePath = filePath;
  }

  async list(category?: MemoryCategory): Promise<MemoryRecord[]> {
    const records = await this.readAll();
    return records
      .filter((record) => !category || record.category === category)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(memory: NewMemory): Promise<MemoryRecord> {
    const records = await this.readAll();
    const timestamp = new Date().toISOString();
    const record: MemoryRecord = {
      id: randomUUID(),
      category: memory.category,
      content: memory.content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    records.push(record);
    await this.writeAll(records);
    return record;
  }

  async update(id: string, content: string): Promise<MemoryRecord | undefined> {
    const records = await this.readAll();
    const record = records.find((candidate) => candidate.id === id);
    if (!record) return undefined;

    record.content = content;
    record.updatedAt = new Date().toISOString();
    await this.writeAll(records);
    return record;
  }

  async delete(id: string): Promise<boolean> {
    const records = await this.readAll();
    const remaining = records.filter((record) => record.id !== id);
    if (remaining.length === records.length) return false;

    await this.writeAll(remaining);
    return true;
  }

  async search(query: string, limit = 5): Promise<MemoryRecord[]> {
    const terms = tokenize(query).filter((term) => !SEARCH_STOP_WORDS.has(term));
    if (terms.length === 0 || limit <= 0) return [];

    const records = await this.list();
    return records
      .map((record) => {
        const memoryTerms = new Set(tokenize(`${record.category} ${record.content}`));
        const score = terms.reduce(
          (total, term) => total + (memoryTerms.has(term) ? 1 : 0),
          0,
        );
        return { record, score };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.record.updatedAt.localeCompare(left.record.updatedAt),
      )
      .slice(0, limit)
      .map(({ record }) => record);
  }

  private async readAll(): Promise<MemoryRecord[]> {
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
      throw new Error(`Muse memory store is not valid JSON: ${this.filePath}`);
    }

    if (!Array.isArray(parsed) || !parsed.every(isMemoryRecord)) {
      throw new Error(`Muse memory store has an invalid format: ${this.filePath}`);
    }

    return parsed;
  }

  private async writeAll(records: MemoryRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.category === "string" &&
    isMemoryCategory(value.category) &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    !Number.isNaN(Date.parse(value.updatedAt))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9$.-]+/g) ?? [];
}
