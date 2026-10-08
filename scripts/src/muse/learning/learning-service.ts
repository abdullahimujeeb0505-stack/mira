import type {
  LearningRecord,
  LearningRepository,
} from "./learning-types.js";
import {
  buildOutcomePattern,
  extractCandidatePattern,
  patternSimilarity,
} from "./pattern-extractor.js";
import type {
  ObservedOutcome,
  OutcomeContext,
  OutcomeResult,
} from "./outcome-types.js";

const MINIMUM_PATTERN_SIMILARITY = 0.55;
const CONFIDENCE_STEP = 0.1;
const DEFAULT_RETRIEVAL_LIMIT = 5;

export class LearningService {
  constructor(private readonly repository: LearningRepository) {}

  async recordOutcome(outcome: ObservedOutcome): Promise<LearningRecord> {
    const candidate = extractCandidatePattern(outcome);
    const existing = await this.findBestMatch(candidate.pattern);
    if (!existing) return this.repository.create(candidate);

    const updated = await this.repository.update(existing.record.id, {
      category: candidate.category,
      evidence: `${existing.record.evidence}\n[${candidate.outcome}] ${candidate.evidence}`,
      outcome: candidate.outcome,
      confidence: adjustConfidence(
        existing.record.confidence,
        existing.record.outcome,
        candidate.outcome,
      ),
      observations: existing.record.observations + 1,
    });

    return updated ?? this.repository.create(candidate);
  }

  async retrieveRelevant(
    context: OutcomeContext,
    limit = DEFAULT_RETRIEVAL_LIMIT,
  ): Promise<LearningRecord[]> {
    const pattern = buildOutcomePattern(context);
    const normalizedLimit = Math.floor(limit);
    if (!Number.isFinite(limit) || normalizedLimit <= 0) return [];

    const records = await this.repository.list();
    return records
      .map((record) => ({
        record,
        similarity: patternSimilarity(pattern, record.pattern),
      }))
      .filter(
        ({ record, similarity }) =>
          record.confidence > 0 && similarity >= MINIMUM_PATTERN_SIMILARITY,
      )
      .sort(
        (left, right) =>
          right.similarity - left.similarity ||
          right.record.confidence - left.record.confidence ||
          right.record.updatedAt.localeCompare(left.record.updatedAt) ||
          left.record.id.localeCompare(right.record.id),
      )
      .slice(0, normalizedLimit)
      .map(({ record }) => record);
  }

  private async findBestMatch(
    pattern: string,
  ): Promise<{ record: LearningRecord; similarity: number } | undefined> {
    const records = await this.repository.list();
    return records
      .map((record) => ({
        record,
        similarity: patternSimilarity(pattern, record.pattern),
      }))
      .filter(({ similarity }) => similarity >= MINIMUM_PATTERN_SIMILARITY)
      .sort(
        (left, right) =>
          right.similarity - left.similarity ||
          right.record.confidence - left.record.confidence ||
          right.record.updatedAt.localeCompare(left.record.updatedAt) ||
          left.record.id.localeCompare(right.record.id),
      )[0];
  }
}

function adjustConfidence(
  current: number,
  previousOutcome: string,
  nextOutcome: OutcomeResult,
): number {
  if (nextOutcome === "neutral") return current;

  const normalizedPrevious = previousOutcome.toLowerCase();
  if (normalizedPrevious === "neutral") return current;

  const delta =
    normalizedPrevious === nextOutcome ? CONFIDENCE_STEP : -CONFIDENCE_STEP;
  return Math.round(Math.max(0, Math.min(1, current + delta)) * 100) / 100;
}
