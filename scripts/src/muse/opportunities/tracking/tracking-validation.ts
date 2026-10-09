import {
  OPPORTUNITY_OUTCOME_TYPES,
  type OpportunityOutcome,
} from "../outcome-model.js";
import type { Opportunity } from "../opportunity-types.js";
import {
  isTrackingCategory,
  isTrackingStatus,
  type NewTrackedOpportunity,
  type TrackedOpportunity,
  type TrackingEvidence,
  type TrackingStatus,
  type WalletAddressReference,
} from "./tracking-types.js";

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_NOTES_LENGTH = 20_000;
const MAX_WALLET_REFERENCES = 20;
const MAX_HISTORY_ENTRIES = 2_000;
const MAX_OUTCOMES = 2_000;

export function createTrackedOpportunityRecord(
  input: NewTrackedOpportunity,
  id: string,
  now: string,
): TrackedOpportunity {
  return normalizeTrackedOpportunity({
    ...input,
    id,
    sourceUrl: input.sourceUrl ?? null,
    status: "DISCOVERED",
    createdAt: now,
    updatedAt: now,
    walletAddressReferences: input.walletAddressReferences ?? [],
    statusHistory: [
      {
        previousStatus: null,
        status: "DISCOVERED",
        at: now,
        evidence: [],
      },
    ],
    outcomes: [],
  });
}

export function normalizeTrackedOpportunity(value: unknown): TrackedOpportunity {
  if (!isRecord(value)) throw new Error("Tracked opportunity must be an object.");
  const id = requiredText(value.id, "ID", 300);
  const status = normalizeStatus(value.status);
  const previousOptionalStatus = (input: unknown): TrackingStatus | null => {
    if (input === null) return null;
    return normalizeStatus(input);
  };
  const sourceUrl =
    value.sourceUrl === null || value.sourceUrl === undefined
      ? null
      : normalizeHttpUrl(value.sourceUrl, "source URL");
  const history = value.statusHistory;
  const outcomes = value.outcomes;
  const walletReferences = value.walletAddressReferences;
  if (
    !Array.isArray(history) ||
    history.length > MAX_HISTORY_ENTRIES ||
    !Array.isArray(outcomes) ||
    outcomes.length > MAX_OUTCOMES ||
    !Array.isArray(walletReferences) ||
    walletReferences.length > MAX_WALLET_REFERENCES
  ) {
    throw new Error("Tracked opportunity has invalid history, outcomes, or wallet references.");
  }

  const sourceOpportunityId = optionalText(value.sourceOpportunityId, "source opportunity ID", 300);
  const description = optionalText(value.description, "description", MAX_DESCRIPTION_LENGTH);
  const project = optionalText(value.project, "project", 300);
  const sourceName = optionalText(value.sourceName, "source name", 300);
  const applicationDate = optionalDate(value.applicationDate, "application date");
  const submissionDate = optionalDate(value.submissionDate, "submission date");
  const deadline = optionalDate(value.deadline, "deadline");
  const launchDate = optionalDate(value.launchDate, "launch date");
  const expectedResultDate = optionalDate(value.expectedResultDate, "expected result date");
  const notes = optionalText(value.notes, "notes", MAX_NOTES_LENGTH);
  const nextAction = optionalText(value.nextAction, "next action", 2_000);
  const nextActionDueAt = optionalDate(value.nextActionDueAt, "next action due date");

  const statusHistory = history.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.evidence)) {
      throw new Error("Tracked opportunity status history entry is invalid.");
    }
    return {
      previousStatus: previousOptionalStatus(entry.previousStatus),
      status: normalizeStatus(entry.status),
      at: normalizeDate(entry.at, "status history date"),
      evidence: entry.evidence.map(normalizeEvidence),
    };
  });
  if (
    statusHistory.length === 0 ||
    statusHistory[statusHistory.length - 1]?.status !== status
  ) {
    throw new Error("Tracked opportunity status history must end with its current status.");
  }
  const normalizedOutcomes = outcomes.map(normalizeOutcome);
  if (normalizedOutcomes.some((outcome) => outcome.opportunityId !== id)) {
    throw new Error("Tracked opportunity contains an outcome linked to another record.");
  }

  return {
    id,
    ...(sourceOpportunityId ? { sourceOpportunityId } : {}),
    title: requiredText(value.title, "title", MAX_TITLE_LENGTH),
    ...(description ? { description } : {}),
    category: normalizeCategory(value.category),
    ...(project ? { project } : {}),
    ...(sourceName ? { sourceName } : {}),
    sourceUrl,
    status,
    createdAt: normalizeDate(value.createdAt, "createdAt"),
    updatedAt: normalizeDate(value.updatedAt, "updatedAt"),
    ...(applicationDate ? { applicationDate } : {}),
    ...(submissionDate ? { submissionDate } : {}),
    ...(deadline ? { deadline } : {}),
    ...(launchDate ? { launchDate } : {}),
    ...(expectedResultDate ? { expectedResultDate } : {}),
    ...(notes ? { notes } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(nextActionDueAt ? { nextActionDueAt } : {}),
    walletAddressReferences: walletReferences.map(normalizeWalletReference),
    statusHistory,
    outcomes: normalizedOutcomes,
  };
}

export function normalizeTrackingEvidence(
  evidence: readonly TrackingEvidence[] | undefined,
): TrackingEvidence[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > 50) {
    throw new Error("Evidence must contain no more than 50 references.");
  }
  const normalized = evidence.map(normalizeEvidence);
  if (
    normalized.some(
      (item) => !item.description && !item.url,
    )
  ) {
    throw new Error("Each evidence reference needs a description or URL.");
  }
  return normalized;
}

export function normalizeTrackingStatus(value: unknown): TrackingStatus {
  return normalizeStatus(value);
}

export function normalizeDateInput(value: string | null | undefined, field: string): string | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  return normalizeDate(value, field);
}

export function assertSafeStoredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Tracked opportunity ${field} cannot be empty.`);
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw new Error(`Tracked opportunity ${field} is too long.`);
  }
  if (looksLikeSecretMaterial(trimmed)) {
    throw new Error(
      `Tracked opportunity ${field} looks like a credential, private key, or seed phrase; it was not stored.`,
    );
  }
  return trimmed;
}

export function categoryForOpportunity(
  opportunity: Opportunity,
): NewTrackedOpportunity["category"] {
  switch (opportunity.opportunityType) {
    case "WL":
      return "WL_APPLICATION";
    case "FREE_MINT":
      return "PUBLIC_MINT";
    case "AIRDROP":
    case "CAMPAIGN":
    case "COMPETITION":
    case "GRANT":
    case "CONTENT":
    case "PRODUCT_LAUNCH":
    case "OTHER":
      return opportunity.opportunityType;
  }
}

export function opportunityTypeForTrackingCategory(
  category: NewTrackedOpportunity["category"],
): Opportunity["opportunityType"] {
  switch (category) {
    case "WL_APPLICATION":
      return "WL";
    case "PUBLIC_MINT":
      return "FREE_MINT";
    case "AIRDROP":
    case "CAMPAIGN":
    case "COMPETITION":
    case "GRANT":
    case "CONTENT":
    case "PRODUCT_LAUNCH":
    case "OTHER":
      return category;
    case "QUEST":
      return "OTHER";
  }
}

function normalizeEvidence(value: unknown): TrackingEvidence {
  if (!isRecord(value)) throw new Error("Tracking evidence reference is invalid.");
  const description = optionalText(value.description, "evidence description", 2_000);
  const source = optionalText(value.source, "evidence source", 300);
  const url =
    value.url === undefined || value.url === null || value.url === ""
      ? undefined
      : normalizeHttpUrl(value.url, "evidence URL");
  const observedAt =
    value.observedAt === undefined || value.observedAt === null
      ? undefined
      : normalizeDate(value.observedAt, "evidence timestamp");
  if (!description && !url) {
    throw new Error("Tracking evidence needs a description or URL.");
  }
  return {
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(source ? { source } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

function normalizeWalletReference(value: unknown): WalletAddressReference {
  if (!isRecord(value)) throw new Error("Wallet address reference is invalid.");
  const chain = requiredText(value.chain, "wallet chain", 80).toLowerCase();
  const address = requiredText(value.address, "wallet address", 128);
  assertPublicWalletAddress(chain, address);
  const label = optionalText(value.label, "wallet label", 100);
  return {
    chain,
    address,
    ...(label ? { label } : {}),
  };
}

function assertPublicWalletAddress(chain: string, address: string): void {
  if (/\s/.test(address) || looksLikeSecretMaterial(address)) {
    throw new Error("Only a public wallet address may be stored; secrets and seed phrases are not accepted.");
  }

  const evmChains = new Set([
    "ethereum",
    "evm",
    "polygon",
    "arbitrum",
    "optimism",
    "base",
    "avalanche",
    "bsc",
    "bnb",
  ]);
  const isEvmAddress = /^0x[a-f\d]{40}$/i.test(address);
  const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  const isBitcoinAddress =
    /^(?:bc1|tb1)[ac-hj-np-z02-9]{11,71}$/i.test(address) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address);
  const isGenericBech32 = /^[a-z0-9]{1,20}1[ac-hj-np-z02-9]{20,90}$/i.test(address);
  const valid = evmChains.has(chain)
    ? isEvmAddress
    : chain === "solana"
      ? isSolanaAddress
      : chain === "bitcoin" || chain === "btc"
        ? isBitcoinAddress
        : isEvmAddress || isSolanaAddress || isBitcoinAddress || isGenericBech32;
  if (!valid) {
    throw new Error("Wallet reference must be a public EVM, Solana, Bitcoin, or Bech32 address.");
  }
}

function normalizeOutcome(value: unknown): OpportunityOutcome {
  if (!isRecord(value)) throw new Error("Tracked opportunity outcome is invalid.");
  const domain = value.domain;
  if (domain !== "opportunity" && domain !== "content") {
    throw new Error("Tracked opportunity outcome domain is not supported.");
  }
  if (
    typeof value.outcome !== "string" ||
    !OPPORTUNITY_OUTCOME_TYPES.includes(
      value.outcome as (typeof OPPORTUNITY_OUTCOME_TYPES)[number],
    )
  ) {
    throw new Error("Tracked opportunity outcome type is not supported.");
  }
  const characteristics = normalizeOutcomeCharacteristics(value.characteristics);
  return {
    id: requiredText(value.id, "outcome ID", 300),
    opportunityId: requiredText(value.opportunityId, "outcome opportunity ID", 300),
    domain,
    eventType: requiredText(value.eventType, "outcome event type", 100),
    description: assertSafeStoredText(
      requiredText(value.description, "outcome description", MAX_DESCRIPTION_LENGTH),
      "outcome description",
    ),
    characteristics,
    outcome: value.outcome as OpportunityOutcome["outcome"],
    evidence: assertSafeStoredText(
      requiredText(value.evidence, "outcome evidence", MAX_DESCRIPTION_LENGTH),
      "outcome evidence",
    ),
    occurredAt: normalizeDate(value.occurredAt, "outcome date"),
  };
}

function normalizeCategory(value: unknown): TrackedOpportunity["category"] {
  if (typeof value !== "string" || !isTrackingCategory(value)) {
    throw new Error("Tracked opportunity category is not supported.");
  }
  return value.toUpperCase() as TrackedOpportunity["category"];
}

function normalizeStatus(value: unknown): TrackingStatus {
  if (typeof value !== "string" || !isTrackingStatus(value)) {
    throw new Error("Tracked opportunity status is not supported.");
  }
  return value.toUpperCase() as TrackingStatus;
}

function normalizeHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Tracked opportunity ${field} must be an absolute HTTP or HTTPS URL.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Tracked opportunity ${field} must be an absolute HTTP or HTTPS URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`Tracked opportunity ${field} must be an HTTP or HTTPS URL without embedded credentials.`);
  }
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[_-]?key|key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|private[_-]?key)$/i.test(key)) {
      throw new Error(`Tracked opportunity ${field} cannot contain credential query parameters.`);
    }
  }
  if (
    /(?:api[_-]?key|access[_-]?token|authorization|token|secret|password|signature)=/i.test(
      url.hash,
    )
  ) {
    throw new Error(`Tracked opportunity ${field} cannot contain credential fragments.`);
  }
  return url.toString();
}

function requiredText(value: unknown, field: string, maxLength = 2_000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tracked opportunity ${field} cannot be empty.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`Tracked opportunity ${field} is too long.`);
  }
  return assertSafeStoredText(normalized, field);
}

function optionalText(
  value: unknown,
  field: string,
  maxLength = 2_000,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, field, maxLength);
}

function normalizeDate(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Tracked opportunity ${field} must be a valid date.`);
  }
  return new Date(value).toISOString();
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeDate(value, field);
}

function normalizeOutcomeCharacteristics(
  value: unknown,
): OpportunityOutcome["characteristics"] {
  if (Array.isArray(value)) {
    return value.map((item) => requiredText(item, "outcome characteristic", 2_000));
  }
  if (!isRecord(value)) {
    throw new Error("Tracked opportunity outcome characteristics are invalid.");
  }
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = requiredText(key, "outcome characteristic name", 100);
    if (typeof item === "string") {
      normalized[normalizedKey] = requiredText(item, "outcome characteristic", 2_000);
    } else if (typeof item === "boolean") {
      normalized[normalizedKey] = item;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      normalized[normalizedKey] = item;
    } else {
      throw new Error("Tracked opportunity outcome characteristic value is invalid.");
    }
  }
  return normalized;
}

function looksLikeSecretMaterial(value: string): boolean {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
    /(?:^|\b)0x[a-f\d]{64}(?:\b|$)/i.test(value) ||
    /(?:^|\b)[a-f\d]{64}(?:\b|$)/i.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/.test(
      value,
    ) ||
    /\b(?:my|our|the)\s+(?:seed[_ -]?phrase|recovery[_ -]?phrase|mnemonic|private[_ -]?key|secret[_ -]?key)\s*(?:is\s*)?[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b(?:api[_ -]?key|access[_ -]?token|password|secret|token)\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b(?:seed[_ -]?phrase|recovery[_ -]?phrase|mnemonic|private[_ -]?key|secret[_ -]?key)\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)
  ) {
    return true;
  }

  const words = value.trim().split(/\s+/);
  return (
    [12, 15, 18, 21, 24].includes(words.length) &&
    words.every((word) => /^[a-z]{2,12}$/.test(word))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
