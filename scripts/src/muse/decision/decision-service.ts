import type {
  LearningCategory,
  LearningRecord,
} from "../learning/learning-types.js";
import type { LearningService } from "../learning/learning-service.js";
import {
  buildOutcomePattern,
  patternSimilarity,
} from "../learning/pattern-extractor.js";
import type { MemoryCategory, MemoryRecord, MemoryRepository } from "../memory/memory-types.js";
import type {
  DecisionEvent,
  DecisionLevel,
  DecisionResult,
  DecisionServiceOptions,
} from "./decision-types.js";
import { DECISION_THRESHOLDS } from "./decision-types.js";

const BASE_RELEVANCE = 15;
const MINIMUM_MEMORY_MATCH = 0.2;
const RELEVANT_LEARNING_CATEGORIES = new Set<LearningCategory>([
  "SUCCESS_PATTERN",
  "FAILURE_PATTERN",
  "OPPORTUNITY_PATTERN",
  "CONTENT_PATTERN",
]);

const MEMORY_WEIGHTS: Partial<Record<MemoryCategory, number>> = {
  USER: 25,
  ACTIVE: 30,
  WATCHING: 70,
  HISTORY: 20,
  CONTENT: 20,
};

const STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "i",
  "im",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "our",
  "the",
  "to",
  "with",
  "we",
]);

const SUCCESS_HISTORY_SIGNALS =
  /\b(success(?:ful)?|worked|won|accepted|replied|closed|converted|raised|achieved|increased)\b/i;
const FAILURE_HISTORY_SIGNALS =
  /\b(fail(?:ed|ure)?|unsuccessful|declined|rejected|lost|stalled|missed|no response)\b/i;

interface MemoryMatch {
  record: MemoryRecord;
  strength: number;
}

interface LearningMatch {
  record: LearningRecord;
  similarity: number;
}

export class DecisionService {
  private readonly now: () => Date;

  constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly learningService: LearningService,
    options: DecisionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async evaluate(event: DecisionEvent): Promise<DecisionResult> {
    validateEvent(event);
    const eventTokens = tokenize(eventText(event));
    const memoryMatches = await this.findRelevantMemories(event, eventTokens);
    const learnedPatterns = await this.findRelevantPatterns(event);

    const reasons: string[] = [];
    let relevance = BASE_RELEVANCE;
    let confidence = 25;

    for (const match of memoryMatches) {
      const contribution = memoryContribution(match, event);
      if (contribution === 0) continue;
      relevance += contribution;
      confidence += Math.round(match.strength * 10);
      reasons.push(formatMemoryReason(match, contribution));
    }

    for (const match of learnedPatterns) {
      const contribution = learningContribution(match);
      if (contribution === 0) continue;
      relevance += contribution;
      confidence += Math.round(match.record.confidence * match.similarity * 15);
      reasons.push(formatLearningReason(match.record, contribution));
    }

    const currentTime = this.now();
    const urgencyScore = calculateUrgency(event.deadlineAt, currentTime);
    const potentialValueScore = calculatePotentialValue(event, learnedPatterns);
    if (event.potentialValue !== undefined) {
      confidence += 5;
      reasons.push(`provided potential value estimate is ${roundScore(event.potentialValue)}/100`);
    }
    if (event.deadlineAt) confidence += 5;
    appendDeadlineReason(reasons, event.deadlineAt, currentTime);

    const relevanceScore = roundScore(Math.max(0, Math.min(100, relevance)));
    confidence = roundScore(Math.min(100, confidence));
    const level = chooseLevel(relevanceScore, urgencyScore);

    return {
      level,
      relevanceScore,
      urgencyScore,
      potentialValueScore,
      confidence,
      recommendedAction: recommendedActionFor(level),
      shouldNotifyUser: level === "SURFACE" || level === "URGENT",
      reasons:
        reasons.length > 0
          ? reasons
          : ["No saved context or learned pattern matched this event."],
      relevantLearnedPatterns: learnedPatterns
        .filter((match) => learningContribution(match) !== 0)
        .map((match) => match.record),
    };
  }

  private async findRelevantMemories(
    event: DecisionEvent,
    eventTokens: Set<string>,
  ): Promise<MemoryMatch[]> {
    const categories: MemoryCategory[] = [
      "USER",
      "ACTIVE",
      "WATCHING",
      "HISTORY",
      ...(event.domain === "content" ? ["CONTENT" as const] : []),
    ];
    const groups = await Promise.all(
      categories.map((category) => this.memoryRepository.list(category)),
    );
    const bestByCategory = new Map<MemoryCategory, MemoryMatch>();

    for (const record of groups.flat()) {
      const weight = MEMORY_WEIGHTS[record.category] ?? 0;
      if (weight === 0) continue;
      const strength = memoryMatchStrength(eventTokens, record.content);
      if (strength < MINIMUM_MEMORY_MATCH) continue;

      const existing = bestByCategory.get(record.category);
      if (!existing || strength > existing.strength) {
        bestByCategory.set(record.category, { record, strength });
      }
    }

    return [...bestByCategory.values()];
  }

  private async findRelevantPatterns(
    event: DecisionEvent,
  ): Promise<LearningMatch[]> {
    const records = await this.learningService.retrieveRelevant(
      event,
      Number.MAX_SAFE_INTEGER,
    );
    return records
      .filter((record) => RELEVANT_LEARNING_CATEGORIES.has(record.category))
      .map((record) => ({
        record,
        similarity: patternSimilarity(
          buildOutcomePattern(event),
          record.pattern,
        ),
      }))
      .filter(
        ({ record, similarity }) =>
          record.confidence > 0 && similarity > 0,
      );
  }

}

function validateEvent(event: DecisionEvent): void {
  if (event.potentialValue !== undefined) {
    if (
      !Number.isFinite(event.potentialValue) ||
      event.potentialValue < 0 ||
      event.potentialValue > 100
    ) {
      throw new Error("Potential value must be a number from 0 to 100.");
    }
  }
  if (event.deadlineAt && Number.isNaN(Date.parse(event.deadlineAt))) {
    throw new Error("Event deadline must be a valid date.");
  }
}

function eventText(event: DecisionEvent): string {
  const title = event.title ?? "";
  const characteristics = event.characteristics;
  const characteristicText = Array.isArray(characteristics)
    ? characteristics.join(" ")
    : Object.entries(characteristics ?? {})
        .flatMap(([key, value]) => [key, String(value)])
        .join(" ");
  return `${title} ${event.domain} ${event.eventType} ${event.description} ${characteristicText}`;
}

function memoryMatchStrength(
  eventTokens: Set<string>,
  memoryContent: string,
): number {
  const memoryTokens = tokenize(memoryContent);
  if (eventTokens.size === 0 || memoryTokens.size === 0) return 0;
  let shared = 0;
  for (const token of memoryTokens) {
    if (eventTokens.has(token)) shared += 1;
  }
  return shared / Math.min(eventTokens.size, memoryTokens.size);
}

function memoryContribution(match: MemoryMatch, event: DecisionEvent): number {
  if (match.record.category === "CONTENT" && event.domain !== "content") return 0;
  const baseWeight = MEMORY_WEIGHTS[match.record.category] ?? 0;
  if (match.record.category !== "HISTORY") {
    return roundScore(baseWeight * match.strength);
  }

  const hasSuccess = SUCCESS_HISTORY_SIGNALS.test(match.record.content);
  const hasFailure = FAILURE_HISTORY_SIGNALS.test(match.record.content);
  if (hasFailure && !hasSuccess) {
    return -roundScore(baseWeight * match.strength);
  }
  return roundScore(baseWeight * match.strength * (hasSuccess ? 1 : 0.5));
}

function learningContribution(match: LearningMatch): number {
  const weightByCategory: Record<
    "SUCCESS_PATTERN" | "FAILURE_PATTERN" | "OPPORTUNITY_PATTERN" | "CONTENT_PATTERN",
    number
  > = {
    SUCCESS_PATTERN: 30,
    FAILURE_PATTERN: -30,
    OPPORTUNITY_PATTERN: 10,
    CONTENT_PATTERN: 10,
  };
  const weight = weightByCategory[match.record.category as keyof typeof weightByCategory];
  return roundScore(weight * match.record.confidence * match.similarity);
}

function calculateUrgency(deadlineAt: string | undefined, now: Date): number {
  if (!deadlineAt) return 10;
  const hoursUntilDeadline = (Date.parse(deadlineAt) - now.getTime()) / 3_600_000;
  if (hoursUntilDeadline <= 0) return 100;
  if (hoursUntilDeadline <= 24) return 95;
  if (hoursUntilDeadline <= 72) return 85;
  if (hoursUntilDeadline <= 168) return 65;
  if (hoursUntilDeadline <= 336) return 40;
  return 20;
}

function calculatePotentialValue(
  event: DecisionEvent,
  learnedPatterns: LearningMatch[],
): number {
  if (event.potentialValue !== undefined) return roundScore(event.potentialValue);

  let value = event.domain === "opportunity" ? 55 : 50;
  for (const match of learnedPatterns) {
    if (match.record.category === "SUCCESS_PATTERN") {
      value += 10 * match.record.confidence * match.similarity;
    } else if (match.record.category === "FAILURE_PATTERN") {
      value -= 10 * match.record.confidence * match.similarity;
    }
  }
  return roundScore(Math.max(0, Math.min(100, value)));
}

function chooseLevel(relevance: number, urgency: number): DecisionLevel {
  if (
    urgency >= DECISION_THRESHOLDS.urgent.minimumUrgency &&
    relevance >= DECISION_THRESHOLDS.urgent.minimumRelevance
  ) {
    return "URGENT";
  }
  if (relevance >= DECISION_THRESHOLDS.surface.minimumRelevance) {
    return "SURFACE";
  }
  if (relevance >= DECISION_THRESHOLDS.save.minimumRelevance) return "SAVE";
  return "IGNORE";
}

function recommendedActionFor(level: DecisionLevel): string {
  switch (level) {
    case "URGENT":
      return "Notify the user now; the deadline is imminent.";
    case "SURFACE":
      return "Notify the user with a concise summary.";
    case "SAVE":
      return "Save this for later review.";
    case "IGNORE":
      return "No action recommended.";
  }
}

function formatMemoryReason(match: MemoryMatch, contribution: number): string {
  const labels: Record<MemoryCategory, string> = {
    USER: "matches a saved user preference",
    ACTIVE: "matches an active goal",
    WATCHING: "matches a watched project",
    CONTENT: "matches saved content context",
    HISTORY: "matches a historical outcome",
  };
  const sign = contribution < 0 ? "-" : "+";
  return `${labels[match.record.category]} (${sign}${Math.abs(contribution)} relevance): "${truncate(match.record.content)}"`;
}

function formatLearningReason(
  record: LearningRecord,
  contribution: number,
): string {
  const labelByCategory: Record<string, string> = {
    SUCCESS_PATTERN: "previous successful pattern",
    FAILURE_PATTERN: "previous failure pattern",
    OPPORTUNITY_PATTERN: "learned opportunity pattern",
    CONTENT_PATTERN: "learned content pattern",
  };
  const sign = contribution < 0 ? "-" : "+";
  return `matches a ${labelByCategory[record.category]} (${sign}${Math.abs(contribution)} relevance).`;
}

function appendDeadlineReason(
  reasons: string[],
  deadlineAt: string | undefined,
  now: Date,
): void {
  if (!deadlineAt) return;
  const hoursUntilDeadline = (Date.parse(deadlineAt) - now.getTime()) / 3_600_000;
  if (hoursUntilDeadline <= 0) reasons.push("deadline has passed.");
  else if (hoursUntilDeadline <= 24) reasons.push("deadline is within 24 hours.");
  else if (hoursUntilDeadline <= 168) reasons.push("deadline is approaching.");
  else if (hoursUntilDeadline <= 336) reasons.push("deadline is within two weeks.");
}

function tokenize(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (token) => !STOP_WORDS.has(token),
    ),
  );
}

function truncate(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function roundScore(value: number): number {
  return Math.round(value);
}

export function formatDecision(result: DecisionResult): string {
  const reasons =
    result.reasons.length > 0
      ? result.reasons.join("; ")
      : "no matching reasons";
  return `${result.level} Relevance: ${result.relevanceScore} Reasons: ${reasons}`;
}
