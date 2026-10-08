import type { LearningCategory, NewLearningRecord } from "./learning-types.js";
import {
  OUTCOME_DOMAINS,
  OUTCOME_RESULTS,
  type ObservedOutcome,
  type OutcomeContext,
  type OutcomeDomain,
  type OutcomeResult,
} from "./outcome-types.js";

const PATTERN_PREFIX = "muse-outcome-pattern:v1:";

const INITIAL_CONFIDENCE: Record<OutcomeResult, number> = {
  success: 0.3,
  failure: 0.3,
  neutral: 0.2,
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

interface NormalizedOutcomeContext {
  domain: OutcomeDomain;
  eventType: string;
  description: string;
  characteristics: string[];
}

export function extractCandidatePattern(
  outcome: ObservedOutcome,
): NewLearningRecord & { outcome: OutcomeResult } {
  const result = normalizeOutcomeResult(outcome.outcome);
  return {
    category: categoryFor(outcome.domain, result),
    pattern: buildOutcomePattern(outcome),
    evidence: normalizeText(outcome.evidence, "evidence"),
    outcome: result,
    confidence: INITIAL_CONFIDENCE[result],
    observations: 1,
  };
}

export function buildOutcomePattern(context: OutcomeContext): string {
  const normalized = normalizeContext(context);
  return `${PATTERN_PREFIX}${JSON.stringify(normalized)}`;
}

export function patternSimilarity(leftPattern: string, rightPattern: string): number {
  const left = parsePattern(leftPattern);
  const right = parsePattern(rightPattern);

  if (left && right) {
    if (left.domain !== right.domain) return 0;

    const eventTypeScore = jaccard(
      tokenize(left.eventType),
      tokenize(right.eventType),
    );
    if (eventTypeScore < 0.5) return 0;

    const descriptionScore = jaccard(
      tokenize(left.description),
      tokenize(right.description),
    );
    const characteristicScore =
      left.characteristics.length > 0 && right.characteristics.length > 0
        ? jaccard(
            new Set(
              left.characteristics.flatMap((feature) => [...tokenize(feature)]),
            ),
            new Set(
              right.characteristics.flatMap((feature) => [...tokenize(feature)]),
            ),
          )
        : 0;

    return (
      eventTypeScore * 0.5 +
      descriptionScore * 0.3 +
      characteristicScore * 0.2
    );
  }

  return jaccard(tokenize(patternText(left, leftPattern)), tokenize(patternText(right, rightPattern)));
}

function normalizeContext(context: OutcomeContext): NormalizedOutcomeContext {
  const domain = normalizeDomain(context.domain);
  const eventType = normalizeText(context.eventType, "event type");
  const description = normalizeText(context.description, "description");
  const characteristics = normalizeCharacteristics(context.characteristics);
  return { domain, eventType, description, characteristics };
}

function normalizeCharacteristics(
  characteristics: OutcomeContext["characteristics"],
): string[] {
  if (!characteristics) return [];

  if (Array.isArray(characteristics)) {
    return [...new Set(characteristics.map((item) => normalizeText(item, "characteristic")))]
      .sort();
  }

  return Object.entries(characteristics)
    .map(([key, value]) => {
      const normalizedKey = normalizeText(key, "characteristic name");
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`Characteristic "${normalizedKey}" must be text, a number, or a boolean.`);
      }
      const normalizedValue =
        typeof value === "string" ? normalizeText(value, "characteristic value") : String(value);
      return `${normalizedKey}=${normalizedValue}`;
    })
    .sort();
}

function normalizeDomain(value: unknown): OutcomeDomain {
  if (
    typeof value !== "string" ||
    !OUTCOME_DOMAINS.includes(value.toLowerCase() as OutcomeDomain)
  ) {
    throw new Error(`Outcome domain must be one of: ${OUTCOME_DOMAINS.join(", ")}.`);
  }
  return value.toLowerCase() as OutcomeDomain;
}

function normalizeOutcomeResult(value: unknown): OutcomeResult {
  if (
    typeof value !== "string" ||
    !OUTCOME_RESULTS.includes(value.toLowerCase() as OutcomeResult)
  ) {
    throw new Error(`Outcome must be one of: ${OUTCOME_RESULTS.join(", ")}.`);
  }
  return value.toLowerCase() as OutcomeResult;
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Outcome ${field} cannot be empty.`);
  }
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function categoryFor(
  domain: OutcomeDomain,
  result: OutcomeResult,
): LearningCategory {
  if (result === "success") return "SUCCESS_PATTERN";
  if (result === "failure") return "FAILURE_PATTERN";
  return domain === "opportunity" ? "OPPORTUNITY_PATTERN" : "CONTENT_PATTERN";
}

function parsePattern(value: string): NormalizedOutcomeContext | undefined {
  if (!value.startsWith(PATTERN_PREFIX)) return undefined;

  try {
    const parsed: unknown = JSON.parse(value.slice(PATTERN_PREFIX.length));
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.domain !== "string" ||
      !OUTCOME_DOMAINS.includes(parsed.domain as OutcomeDomain) ||
      typeof parsed.eventType !== "string" ||
      typeof parsed.description !== "string" ||
      !Array.isArray(parsed.characteristics) ||
      !parsed.characteristics.every((item) => typeof item === "string")
    ) {
      return undefined;
    }
    return {
      domain: parsed.domain as OutcomeDomain,
      eventType: parsed.eventType,
      description: parsed.description,
      characteristics: parsed.characteristics,
    };
  } catch {
    return undefined;
  }
}

function patternText(
  parsed: NormalizedOutcomeContext | undefined,
  fallback: string,
): string {
  return parsed
    ? [
        parsed.domain,
        parsed.eventType,
        parsed.description,
        ...parsed.characteristics,
      ].join(" ")
    : fallback;
}

function tokenize(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (token) => !STOP_WORDS.has(token),
    ),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
