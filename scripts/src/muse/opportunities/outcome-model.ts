import { randomUUID } from "node:crypto";
import type { ObservedOutcome, OutcomeDomain } from "../learning/outcome-types.js";
import type { Opportunity } from "./opportunity-types.js";
import { outcomeDomainForOpportunity } from "./opportunity-types.js";

export const OPPORTUNITY_OUTCOME_TYPES = [
  "success",
  "failure",
  "neutral",
  "unknown",
] as const;

export type OpportunityOutcomeType =
  (typeof OPPORTUNITY_OUTCOME_TYPES)[number];

export interface OpportunityOutcome {
  id: string;
  opportunityId: string;
  domain: OutcomeDomain;
  eventType: string;
  description: string;
  characteristics: Opportunity["characteristics"];
  outcome: OpportunityOutcomeType;
  evidence: string;
  occurredAt: string;
}

export interface NewOpportunityOutcome {
  outcome: OpportunityOutcomeType;
  description: string;
  evidence: string;
  occurredAt: string;
}

export function createOpportunityOutcome(
  opportunity: Opportunity,
  observation: NewOpportunityOutcome,
): OpportunityOutcome {
  return {
    id: randomUUID(),
    opportunityId: opportunity.id,
    domain: outcomeDomainForOpportunity(opportunity.opportunityType),
    eventType: opportunity.opportunityType,
    description: requireText(observation.description, "description"),
    characteristics: opportunity.characteristics,
    outcome: observation.outcome,
    evidence: requireText(observation.evidence, "evidence"),
    occurredAt: normalizeTimestamp(observation.occurredAt),
  };
}

export function toLearningObservation(
  outcome: OpportunityOutcome,
): ObservedOutcome | undefined {
  if (outcome.outcome === "unknown") return undefined;
  return {
    domain: outcome.domain,
    eventType: outcome.eventType,
    description: outcome.description,
    characteristics: outcome.characteristics,
    outcome: outcome.outcome,
    evidence: outcome.evidence,
  };
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`Outcome ${field} cannot be empty.`);
  return value.trim();
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Outcome occurredAt must be a valid date.");
  }
  return timestamp.toISOString();
}
