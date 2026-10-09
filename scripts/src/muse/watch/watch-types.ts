import type {
  OpportunityEvaluation,
} from "../opportunities/opportunity-service.js";
import type {
  NormalizedOpportunity,
  OpportunityType,
} from "../opportunities/opportunity-types.js";

export const WATCH_TARGET_TYPES = [
  "TRUSTED_ACCOUNT",
  "PROJECT",
  "WEBSITE",
  "ANNOUNCEMENT_CHANNEL",
  "KEYWORD",
  "OPPORTUNITY",
] as const;

export type WatchTargetType = (typeof WATCH_TARGET_TYPES)[number];

export interface WatchRule {
  id: string;
  targetType: WatchTargetType;
  target: string;
  sources: string[];
  keywords: string[];
  opportunityTypes: OpportunityType[];
  exclusions: string[];
  priority?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewWatchRule {
  targetType: WatchTargetType;
  target: string;
  sources?: string[];
  keywords?: string[];
  opportunityTypes?: OpportunityType[];
  exclusions?: string[];
  priority?: number;
  enabled?: boolean;
}

export type WatchRuleChanges = Partial<NewWatchRule>;

export interface WatchRuleRepository {
  list(): Promise<WatchRule[]>;
  get(id: string): Promise<WatchRule | undefined>;
  create(input: NewWatchRule): Promise<WatchRule>;
  update(id: string, changes: WatchRuleChanges): Promise<WatchRule | undefined>;
  delete(id: string): Promise<boolean>;
}

/**
 * Normalized identity hints supplied by an upstream adapter. This module
 * defines the contract only; it does not fetch or resolve these identities.
 */
export interface WatchEntityHints {
  trustedAccounts?: string[];
  projects?: string[];
  websites?: string[];
  announcementChannels?: string[];
}

export interface WatchUpdate {
  opportunity: NormalizedOpportunity;
  entities?: WatchEntityHints;
}

export interface WatchProcessingResult {
  matchedRules: WatchRule[];
  effectivePriority?: number;
  /** Null when no enabled rule matched the supplied update. */
  evaluation: OpportunityEvaluation | null;
}

export function isWatchTargetType(value: string): value is WatchTargetType {
  return WATCH_TARGET_TYPES.includes(value.toUpperCase() as WatchTargetType);
}
