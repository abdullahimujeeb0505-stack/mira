import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LearningCategory,
  LearningRecord,
  LearningRecordUpdate,
  LearningRepository,
  NewLearningRecord,
} from "./learning-types.js";
import { isLearningCategory } from "./learning-types.js";

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../data/muse-learning.json", import.meta.url),
);

export class JsonLearningRepository implements LearningRepository {
  private readonly filePath: string;

  constructor(
    filePath = process.env.MUSE_LEARNING_PATH ?? DEFAULT_FILE_PATH,
  ) {
    this.filePath = filePath;
  }

  async list(category?: LearningCategory): Promise<LearningRecord[]> {
    const records = await this.readAll();
    return records
      .filter((record) => !category || record.category === category)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<LearningRecord | undefined> {
    return (await this.readAll()).find((record) => record.id === id);
  }

  async create(input: NewLearningRecord): Promise<LearningRecord> {
    const records = await this.readAll();
    const fields = normalizeNewLearningRecord(input);
    const timestamp = new Date().toISOString();
    const record: LearningRecord = {
      id: randomUUID(),
      ...fields,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    records.push(record);
    await this.writeAll(records);
    return record;
  }

  async update(
    id: string,
    changes: LearningRecordUpdate,
  ): Promise<LearningRecord | undefined> {
    const records = await this.readAll();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;

    const current = records[index];
    if (!current) return undefined;

    const updated = normalizeLearningRecord({
      ...current,
      category: changes.category ?? current.category,
      pattern: changes.pattern ?? current.pattern,
      evidence: changes.evidence ?? current.evidence,
      outcome: changes.outcome ?? current.outcome,
      confidence: changes.confidence ?? current.confidence,
      observations: changes.observations ?? current.observations,
      updatedAt: new Date().toISOString(),
    });

    records[index] = updated;
    await this.writeAll(records);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const records = await this.readAll();
    const remaining = records.filter((record) => record.id !== id);
    if (remaining.length === records.length) return false;

    await this.writeAll(remaining);
    return true;
  }

  private async readAll(): Promise<LearningRecord[]> {
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
      throw new Error(`Muse learning store is not valid JSON: ${this.filePath}`);
    }

    if (!Array.isArray(parsed) || !parsed.every(isLearningRecord)) {
      throw new Error(`Muse learning store has an invalid format: ${this.filePath}`);
    }

    return parsed;
  }

  private async writeAll(records: LearningRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeNewLearningRecord(
  input: NewLearningRecord,
): Omit<LearningRecord, "id" | "createdAt" | "updatedAt"> {
  return {
    category: normalizeCategory(input.category),
    pattern: normalizeText(input.pattern, "pattern"),
    evidence: normalizeText(input.evidence, "evidence"),
    outcome: normalizeText(input.outcome, "outcome"),
    confidence: normalizeConfidence(input.confidence),
    observations: normalizeObservations(input.observations ?? 1),
  };
}

function normalizeLearningRecord(value: unknown): LearningRecord {
  if (!isRecord(value)) {
    throw new Error("Learning record must be an object.");
  }

  const category = normalizeCategory(value.category);
  const pattern = normalizeText(value.pattern, "pattern");
  const evidence = normalizeText(value.evidence, "evidence");
  const outcome = normalizeText(value.outcome, "outcome");
  const confidence = normalizeConfidence(value.confidence);
  const observations = normalizeObservations(value.observations);
  const id = normalizeText(value.id, "id");
  const createdAt = normalizeTimestamp(value.createdAt, "createdAt");
  const updatedAt = normalizeTimestamp(value.updatedAt, "updatedAt");

  return {
    id,
    category,
    pattern,
    evidence,
    outcome,
    confidence,
    observations,
    createdAt,
    updatedAt,
  };
}

function normalizeCategory(value: unknown): LearningCategory {
  if (typeof value !== "string" || !isLearningCategory(value)) {
    throw new Error("Learning category is not supported.");
  }
  return value.toUpperCase() as LearningCategory;
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Learning ${field} cannot be empty.`);
  }
  return value.trim();
}

function normalizeConfidence(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("Learning confidence must be a number from 0 to 1.");
  }
  return value;
}

function normalizeObservations(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error("Learning observations must be a positive integer.");
  }
  return value;
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`Learning ${field} must be a valid timestamp.`);
  }
  return value;
}

function isLearningRecord(value: unknown): value is LearningRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.category === "string" &&
    isLearningCategory(value.category) &&
    typeof value.pattern === "string" &&
    value.pattern.trim().length > 0 &&
    typeof value.evidence === "string" &&
    value.evidence.trim().length > 0 &&
    typeof value.outcome === "string" &&
    value.outcome.trim().length > 0 &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.observations === "number" &&
    Number.isSafeInteger(value.observations) &&
    value.observations >= 1 &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.updatedAt))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
