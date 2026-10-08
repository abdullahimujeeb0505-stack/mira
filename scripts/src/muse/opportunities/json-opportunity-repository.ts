import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Opportunity,
  OpportunityRepository,
  OpportunityUpdate,
} from "./opportunity-types.js";
import { isOpportunityStatus, isOpportunityType } from "./opportunity-types.js";

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../data/muse-opportunities.json", import.meta.url),
);

export class JsonOpportunityRepository implements OpportunityRepository {
  private readonly filePath: string;

  constructor(
    filePath = process.env.MUSE_OPPORTUNITIES_PATH ?? DEFAULT_FILE_PATH,
  ) {
    this.filePath = filePath;
  }

  async list(): Promise<Opportunity[]> {
    return (await this.readAll()).sort(
      (left, right) => right.detectedAt.localeCompare(left.detectedAt),
    );
  }

  async get(id: string): Promise<Opportunity | undefined> {
    return (await this.readAll()).find((opportunity) => opportunity.id === id);
  }

  async create(opportunity: Opportunity): Promise<Opportunity> {
    const records = await this.readAll();
    const normalized = normalizeOpportunityRecord(opportunity);
    if (records.some((record) => record.id === normalized.id)) {
      throw new Error(`Opportunity ID already exists: ${normalized.id}`);
    }
    records.push(normalized);
    await this.writeAll(records);
    return normalized;
  }

  async update(
    id: string,
    changes: OpportunityUpdate,
  ): Promise<Opportunity | undefined> {
    const records = await this.readAll();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;

    const current = records[index];
    if (!current) return undefined;
    const updated = normalizeOpportunityRecord({
      ...current,
      ...changes,
      id: current.id,
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

  private async readAll(): Promise<Opportunity[]> {
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
      throw new Error(`Muse opportunity store is not valid JSON: ${this.filePath}`);
    }

    if (!Array.isArray(parsed) || !parsed.every(isOpportunity)) {
      throw new Error(`Muse opportunity store has an invalid format: ${this.filePath}`);
    }
    return parsed;
  }

  private async writeAll(records: Opportunity[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeOpportunityRecord(value: Opportunity): Opportunity {
  if (!isOpportunity(value)) {
    throw new Error("Opportunity record has an invalid format.");
  }
  return value;
}

function isOpportunity(value: unknown): value is Opportunity {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.description) &&
    isNonEmptyString(value.source) &&
    isNullableUrl(value.sourceUrl) &&
    isValidDate(value.detectedAt) &&
    isNullableDate(value.deadline) &&
    typeof value.opportunityType === "string" &&
    isOpportunityType(value.opportunityType) &&
    isCharacteristics(value.characteristics) &&
    Array.isArray(value.requirements) &&
    value.requirements.every(isNonEmptyString) &&
    typeof value.status === "string" &&
    isOpportunityStatus(value.status)
  );
}

function isCharacteristics(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isNonEmptyString);
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (item) =>
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)),
  );
}

function isNullableUrl(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isNullableDate(value: unknown): boolean {
  return value === null || isValidDate(value);
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
