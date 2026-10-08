export const OUTCOME_DOMAINS = ["opportunity", "content"] as const;

export type OutcomeDomain = (typeof OUTCOME_DOMAINS)[number];

export const OUTCOME_RESULTS = ["success", "failure", "neutral"] as const;

export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export type OutcomeCharacteristics =
  | readonly string[]
  | Readonly<Record<string, string | number | boolean>>;

export interface OutcomeContext {
  domain: OutcomeDomain;
  eventType: string;
  description: string;
  characteristics?: OutcomeCharacteristics;
}

export interface ObservedOutcome extends OutcomeContext {
  outcome: OutcomeResult;
  evidence: string;
}
