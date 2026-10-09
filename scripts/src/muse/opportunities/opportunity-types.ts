import type { OutcomeCharacteristics, OutcomeDomain } from "../learning/outcome-types.js";

export const OPPORTUNITY_TYPES = [
  "WL",
  "FREE_MINT",
  "AIRDROP",
  "CAMPAIGN",
  "COMPETITION",
  "GRANT",
  "CONTENT",
  "PRODUCT_LAUNCH",
  "OTHER",
] as const;

export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = [
  "SAVED",
  "SURFACED",
  "URGENT",
  "IGNORED",
  "ACTED_ON",
  "CLOSED",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * Provider-neutral information about a discovered opportunity.
 * `source` is a display/attribution label, not a provider adapter.
 */
export interface OpportunityEvent {
  title: string;
  description: string;
  source: string;
  sourceUrl: string | null;
  detectedAt: string;
  deadline: string | null;
  opportunityType: OpportunityType;
  characteristics: OutcomeCharacteristics;
  requirements: string[];
}

export interface Opportunity extends OpportunityEvent {
  id: string;
  status: OpportunityStatus;
}

export type NormalizedOpportunity = OpportunityEvent & {
  id?: string;
  detectedAt?: string;
};

export type OpportunityUpdate = Partial<Omit<Opportunity, "id">>;

export interface OpportunityRepository {
  list(): Promise<Opportunity[]>;
  get(id: string): Promise<Opportunity | undefined>;
  create(opportunity: Opportunity): Promise<Opportunity>;
  update(
    id: string,
    changes: OpportunityUpdate,
  ): Promise<Opportunity | undefined>;
  delete(id: string): Promise<boolean>;
}

export function isOpportunityType(value: string): value is OpportunityType {
  return OPPORTUNITY_TYPES.includes(value.toUpperCase() as OpportunityType);
}

export function isOpportunityStatus(value: string): value is OpportunityStatus {
  return OPPORTUNITY_STATUSES.includes(value.toUpperCase() as OpportunityStatus);
}

export function outcomeDomainForOpportunity(
  opportunityType: OpportunityType,
): OutcomeDomain {
  return opportunityType === "CONTENT" ? "content" : "opportunity";
}
