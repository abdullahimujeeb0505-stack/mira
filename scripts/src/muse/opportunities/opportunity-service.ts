import { randomUUID } from "node:crypto";
import type {
  DecisionEvent,
  DecisionResult,
} from "../decision/decision-types.js";
import type { DecisionService } from "../decision/decision-service.js";
import type {
  OutcomeCharacteristics,
} from "../learning/outcome-types.js";
import type {
  Opportunity,
  OpportunityEvent,
  OpportunityRepository,
  OpportunityStatus,
  OpportunityType,
  NormalizedOpportunity,
} from "./opportunity-types.js";
import { OPPORTUNITY_TYPES, outcomeDomainForOpportunity } from "./opportunity-types.js";

export interface OpportunityEvaluation {
  opportunity: Opportunity;
  decision: DecisionResult;
  saved: boolean;
  duplicate: boolean;
}

export interface OpportunityServiceOptions {
  now?: () => Date;
}

type DecisionEvaluator = Pick<DecisionService, "evaluate">;

export class OpportunityService {
  private readonly now: () => Date;
  private serialQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly decisionService: DecisionEvaluator,
    private readonly repository: OpportunityRepository,
    options: OpportunityServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  evaluate(
    input: NormalizedOpportunity,
    context: { watchRuleMatch?: { ruleCount: number; priority?: number } } = {},
  ): Promise<OpportunityEvaluation> {
    const operation = this.serialQueue.then(() => this.evaluateInOrder(input, context));
    this.serialQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async evaluateInOrder(
    input: NormalizedOpportunity,
    context: { watchRuleMatch?: { ruleCount: number; priority?: number } },
  ): Promise<OpportunityEvaluation> {
    const event = normalizeOpportunityInput(input, this.now());
    const candidate: Opportunity = {
      ...event,
      id: input.id?.trim() || randomUUID(),
      status: "IGNORED",
    };
    const decisionEvent = toDecisionEvent(candidate);
    if (context.watchRuleMatch) {
      decisionEvent.watchRuleMatchCount = context.watchRuleMatch.ruleCount;
    }
    const decision = await this.decisionService.evaluate(decisionEvent);
    candidate.status = statusForDecision(decision);

    const duplicate = (await this.repository.list()).find((existing) =>
      isDuplicate(existing, candidate),
    );
    if (duplicate) {
      return { opportunity: duplicate, decision, saved: true, duplicate: true };
    }

    if (decision.level === "IGNORE") {
      return { opportunity: candidate, decision, saved: false, duplicate: false };
    }

    const saved = await this.repository.create(candidate);
    return { opportunity: saved, decision, saved: true, duplicate: false };
  }
}

function normalizeOpportunityInput(
  input: NormalizedOpportunity,
  now: Date,
): OpportunityEvent {
  const title = normalizeRequiredText(input.title, "title");
  const description = normalizeRequiredText(input.description, "description");
  const source = normalizeRequiredText(input.source, "source");
  const opportunityType = normalizeOpportunityType(input.opportunityType);
  const sourceUrl = normalizeOptionalUrl(input.sourceUrl);
  const detectedAt = normalizeDate(input.detectedAt ?? now.toISOString(), "detectedAt");
  const deadline = input.deadline === null
    ? null
    : normalizeDate(input.deadline, "deadline");
  const characteristics = normalizeCharacteristics(input.characteristics);
  const requirements = input.requirements.map((requirement) =>
    normalizeRequiredText(requirement, "requirement"),
  );

  return {
    title,
    description,
    source,
    sourceUrl,
    detectedAt,
    deadline,
    opportunityType,
    characteristics,
    requirements,
  };
}

function normalizeOpportunityType(value: unknown): OpportunityType {
  if (
    typeof value !== "string" ||
    !OPPORTUNITY_TYPES.includes(value.toUpperCase() as OpportunityType)
  ) {
    throw new Error(`Opportunity type must be one of: ${OPPORTUNITY_TYPES.join(", ")}.`);
  }
  return value.toUpperCase() as OpportunityType;
}

function normalizeCharacteristics(
  value: OutcomeCharacteristics,
): OutcomeCharacteristics {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRequiredText(item, "characteristic"));
  }

  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeRequiredText(key, "characteristic name");
    if (
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      (typeof item !== "number" || !Number.isFinite(item))
    ) {
      throw new Error(`Characteristic "${normalizedKey}" must be text, a finite number, or a boolean.`);
    }
    normalized[normalizedKey] =
      typeof item === "string" ? normalizeRequiredText(item, "characteristic value") : item;
  }
  return normalized;
}

function normalizeOptionalUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Opportunity sourceUrl must be an absolute HTTP or HTTPS URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Opportunity sourceUrl must be an absolute HTTP or HTTPS URL.");
  }
  return url.toString();
}

function normalizeDate(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Opportunity ${field} must be a valid date.`);
  }
  return date.toISOString();
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Opportunity ${field} cannot be empty.`);
  }
  return value.trim();
}

function toDecisionEvent(opportunity: Opportunity): DecisionEvent {
  const characteristics = characteristicsAsText(opportunity.characteristics);
  const value = numericCharacteristic(
    opportunity.characteristics,
    ["potentialvalue", "valuescore", "potential_value"],
  );
  const requirements = opportunity.requirements.length
    ? ` Requirements: ${opportunity.requirements.join("; ")}.`
    : "";

  return {
    title: opportunity.title,
    domain: outcomeDomainForOpportunity(opportunity.opportunityType),
    eventType: opportunity.opportunityType,
    description: `${opportunity.title}. ${opportunity.description}.${requirements}`,
    characteristics: [...characteristics, ...opportunity.requirements],
    deadlineAt: opportunity.deadline ?? undefined,
    ...(value !== undefined ? { potentialValue: value } : {}),
  };
}

function characteristicsAsText(
  characteristics: OutcomeCharacteristics,
): string[] {
  if (Array.isArray(characteristics)) return [...characteristics];
  return Object.entries(characteristics).flatMap(([key, value]) => [
    key,
    String(value),
  ]);
}

function numericCharacteristic(
  characteristics: OutcomeCharacteristics,
  names: string[],
): number | undefined {
  if (Array.isArray(characteristics)) return undefined;
  const expected = new Set(names);
  for (const [key, value] of Object.entries(characteristics)) {
    if (expected.has(key.toLowerCase()) && typeof value === "number") {
      return Math.max(0, Math.min(100, value));
    }
  }
  return undefined;
}

function statusForDecision(decision: DecisionResult): OpportunityStatus {
  switch (decision.level) {
    case "URGENT":
      return "URGENT";
    case "SURFACE":
      return "SURFACED";
    case "SAVE":
      return "SAVED";
    case "IGNORE":
      return "IGNORED";
  }
}

function isDuplicate(existing: Opportunity, candidate: Opportunity): boolean {
  const existingUrl = canonicalizeUrl(existing.sourceUrl);
  const candidateUrl = canonicalizeUrl(candidate.sourceUrl);
  if (existingUrl && candidateUrl && existingUrl === candidateUrl) return true;

  return (
    normalizeIdentityText(existing.title) === normalizeIdentityText(candidate.title) &&
    existing.opportunityType === candidate.opportunityType &&
    normalizeIdentityText(existing.source) === normalizeIdentityText(candidate.source)
  );
}

function canonicalizeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith("utm_") ||
      ["fbclid", "gclid", "mc_cid", "mc_eid", "ref"].includes(normalized)
    ) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

function normalizeIdentityText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
