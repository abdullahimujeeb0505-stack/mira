import type { OpportunityOutcome } from "../outcome-model.js";

export const TRACKING_CATEGORIES = [
  "WL_APPLICATION",
  "AIRDROP",
  "BOUNTY",
  "CAMPAIGN",
  "QUEST",
  "COMPETITION",
  "GRANT",
  "CONTENT",
  "PUBLIC_MINT",
  "PRODUCT_LAUNCH",
  "OTHER",
] as const;

export type TrackingCategory = (typeof TRACKING_CATEGORIES)[number];

export const TRACKING_STATUSES = [
  "DISCOVERED",
  "INTERESTED",
  "APPLIED",
  "SUBMITTED",
  "PENDING",
  "CHECKER_ANNOUNCED",
  "ELIGIBLE",
  "INELIGIBLE",
  "WON",
  "LOST",
  "COMPLETED",
  "EXPIRED",
  "UNKNOWN",
  "CLOSED",
  "ARCHIVED",
] as const;

export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export interface TrackingEvidence {
  description?: string;
  url?: string;
  source?: string;
  observedAt?: string;
}

export interface TrackingStatusChange {
  previousStatus: TrackingStatus | null;
  status: TrackingStatus;
  at: string;
  evidence: TrackingEvidence[];
}

export interface WalletAddressReference {
  chain: string;
  address: string;
  label?: string;
}

export interface TrackedOpportunity {
  id: string;
  /** Link back to the provider-independent discovered-opportunity record. */
  sourceOpportunityId?: string;
  title: string;
  description?: string;
  category: TrackingCategory;
  project?: string;
  sourceName?: string;
  sourceUrl: string | null;
  status: TrackingStatus;
  createdAt: string;
  updatedAt: string;
  applicationDate?: string;
  submissionDate?: string;
  deadline?: string;
  launchDate?: string;
  expectedResultDate?: string;
  notes?: string;
  nextAction?: string;
  nextActionDueAt?: string;
  walletAddressReferences: WalletAddressReference[];
  statusHistory: TrackingStatusChange[];
  outcomes: OpportunityOutcome[];
}

export interface NewTrackedOpportunity {
  sourceOpportunityId?: string;
  title: string;
  description?: string;
  category: TrackingCategory;
  project?: string;
  sourceName?: string;
  sourceUrl?: string | null;
  deadline?: string | null;
  launchDate?: string | null;
  expectedResultDate?: string | null;
  notes?: string;
  nextAction?: string;
  nextActionDueAt?: string | null;
  walletAddressReferences?: WalletAddressReference[];
}

export interface TrackedOpportunityChanges {
  title?: string;
  description?: string | null;
  category?: TrackingCategory;
  project?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  applicationDate?: string | null;
  submissionDate?: string | null;
  deadline?: string | null;
  launchDate?: string | null;
  expectedResultDate?: string | null;
  notes?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  walletAddressReferences?: WalletAddressReference[];
}

export interface TrackingFilters {
  status?: TrackingStatus;
  category?: TrackingCategory;
}

export interface TrackingRepository {
  list(filters?: TrackingFilters): Promise<TrackedOpportunity[]>;
  get(id: string): Promise<TrackedOpportunity | undefined>;
  create(record: TrackedOpportunity): Promise<TrackedOpportunity>;
  replace(record: TrackedOpportunity): Promise<TrackedOpportunity | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface TrackingAddResult {
  record: TrackedOpportunity;
  created: boolean;
}

export interface TrackingStatusOptions {
  at?: string;
  evidence?: TrackingEvidence[];
}

export interface TrackingOutcomeInput {
  outcome: "success" | "failure" | "neutral" | "unknown";
  description: string;
  evidence: TrackingEvidence[];
  occurredAt?: string;
}

export function isTrackingCategory(value: string): value is TrackingCategory {
  return TRACKING_CATEGORIES.includes(value.toUpperCase() as TrackingCategory);
}

export function isTrackingStatus(value: string): value is TrackingStatus {
  return TRACKING_STATUSES.includes(value.toUpperCase() as TrackingStatus);
}

export function parseTrackingCategory(
  value: string,
): TrackingCategory | undefined {
  const normalized = value.trim().toUpperCase();
  return isTrackingCategory(normalized) ? normalized : undefined;
}

export function parseTrackingStatus(value: string): TrackingStatus | undefined {
  const normalized = value.trim().toUpperCase();
  return isTrackingStatus(normalized) ? normalized : undefined;
}
