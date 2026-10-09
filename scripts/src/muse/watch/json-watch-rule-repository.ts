import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NewWatchRule,
  WatchRule,
  WatchRuleChanges,
  WatchRuleRepository,
  WatchTargetType,
} from "./watch-types.js";
import { isWatchTargetType } from "./watch-types.js";
import {
  isOpportunityType,
  type OpportunityType,
} from "../opportunities/opportunity-types.js";

const DEFAULT_FILE_PATH = fileURLToPath(
  new URL("../../../data/muse-watch-rules.json", import.meta.url),
);

export class JsonWatchRuleRepository implements WatchRuleRepository {
  constructor(
    private readonly filePath =
      process.env.MUSE_WATCH_RULES_PATH ?? DEFAULT_FILE_PATH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<WatchRule[]> {
    return (await this.readAll()).sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }

  async get(id: string): Promise<WatchRule | undefined> {
    return (await this.readAll()).find((rule) => rule.id === id);
  }

  async create(input: NewWatchRule): Promise<WatchRule> {
    const rules = await this.readAll();
    const timestamp = this.now().toISOString();
    const rule = normalizeWatchRule({
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      enabled: input.enabled ?? true,
    });
    rules.push(rule);
    await this.writeAll(rules);
    return rule;
  }

  async update(
    id: string,
    changes: WatchRuleChanges,
  ): Promise<WatchRule | undefined> {
    const rules = await this.readAll();
    const index = rules.findIndex((rule) => rule.id === id);
    if (index < 0) return undefined;

    const current = rules[index];
    if (!current) return undefined;
    const updated = normalizeWatchRule({
      ...current,
      ...changes,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    });
    rules[index] = updated;
    await this.writeAll(rules);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const rules = await this.readAll();
    const remaining = rules.filter((rule) => rule.id !== id);
    if (remaining.length === rules.length) return false;
    await this.writeAll(remaining);
    return true;
  }

  private async readAll(): Promise<WatchRule[]> {
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
      throw new Error(`Muse watch-rule store is not valid JSON: ${this.filePath}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Muse watch-rule store has an invalid format: ${this.filePath}`);
    }
    return parsed.map(normalizeWatchRule);
  }

  private async writeAll(rules: WatchRule[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeWatchRule(value: unknown): WatchRule {
  if (!isRecord(value)) throw new Error("Watch rule must be an object.");

  const targetType = normalizeTargetType(value.targetType);
  const target = normalizeText(value.target, "target");
  const sources = normalizeStringList(value.sources ?? [], "source");
  const keywords = normalizeStringList(value.keywords ?? [], "keyword");
  const opportunityTypes = normalizeOpportunityTypes(value.opportunityTypes ?? []);
  const exclusions = normalizeStringList(value.exclusions ?? [], "exclusion");
  const enabled = value.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error("Watch rule enabled must be a boolean.");
  }

  const id = normalizeText(value.id, "id");
  const createdAt = normalizeTimestamp(value.createdAt, "createdAt");
  const updatedAt = normalizeTimestamp(value.updatedAt, "updatedAt");
  const priority =
    value.priority === undefined
      ? undefined
      : normalizePriority(value.priority);

  return {
    id,
    targetType,
    target,
    sources,
    keywords,
    opportunityTypes,
    exclusions,
    ...(priority !== undefined ? { priority } : {}),
    enabled,
    createdAt,
    updatedAt,
  };
}

function normalizeTargetType(value: unknown): WatchTargetType {
  if (typeof value !== "string" || !isWatchTargetType(value)) {
    throw new Error("Watch rule targetType is not supported.");
  }
  return value.toUpperCase() as WatchTargetType;
}

function normalizeOpportunityTypes(value: unknown): OpportunityType[] {
  if (!Array.isArray(value)) {
    throw new Error("Watch rule opportunityTypes must be an array.");
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string" || !isOpportunityType(item)) {
      throw new Error("Watch rule contains an unsupported opportunity type.");
    }
    return item.toUpperCase() as OpportunityType;
  });
  return [...new Set(normalized)];
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Watch rule ${field}s must be an array.`);
  }
  const normalized = value.map((item) => normalizeText(item, field));
  const seen = new Set<string>();
  return normalized.filter((item) => {
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePriority(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error("Watch rule priority must be an integer from 0 to 100.");
  }
  return value;
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Watch rule ${field} cannot be empty.`);
  }
  return value.trim();
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Watch rule ${field} must be a valid timestamp.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
