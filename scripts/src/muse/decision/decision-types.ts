import type { LearningRecord } from "../learning/learning-types.js";
import type { OutcomeContext } from "../learning/outcome-types.js";

export const DECISION_LEVELS = ["IGNORE", "SAVE", "SURFACE", "URGENT"] as const;

export type DecisionLevel = (typeof DECISION_LEVELS)[number];

export const DECISION_THRESHOLDS = {
  urgent: { minimumRelevance: 40, minimumUrgency: 90 },
  surface: { minimumRelevance: 65 },
  save: { minimumRelevance: 30 },
} as const;

export interface DecisionEvent extends OutcomeContext {
  title?: string;
  deadlineAt?: string;
  /** Optional caller estimate on a 0–100 scale. */
  potentialValue?: number;
}

export interface DecisionResult {
  level: DecisionLevel;
  relevanceScore: number;
  urgencyScore: number;
  potentialValueScore: number;
  /** Confidence is reported on a 0–100 scale. */
  confidence: number;
  recommendedAction: string;
  shouldNotifyUser: boolean;
  reasons: string[];
  relevantLearnedPatterns: LearningRecord[];
}

export interface DecisionServiceOptions {
  now?: () => Date;
}
