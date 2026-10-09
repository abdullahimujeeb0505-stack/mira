import { randomUUID } from "node:crypto";
import { LearningService } from "../../learning/learning-service.js";
import type { ObservedOutcome, OutcomeResult } from "../../learning/outcome-types.js";
import type { Opportunity } from "../opportunity-types.js";
import {
  createOpportunityOutcome,
  toLearningObservation,
  type NewOpportunityOutcome,
  type OpportunityOutcome,
} from "../outcome-model.js";
import type {
  NewTrackedOpportunity,
  TrackedOpportunity,
  TrackedOpportunityChanges,
  TrackingAddResult,
  TrackingEvidence,
  TrackingFilters,
  TrackingOutcomeInput,
  TrackingRepository,
  TrackingStatus,
  TrackingStatusOptions,
} from "./tracking-types.js";
import {
  assertSafeStoredText,
  categoryForOpportunity,
  createTrackedOpportunityRecord,
  normalizeDateInput,
  normalizeTrackingEvidence,
  normalizeTrackingStatus,
  normalizeTrackedOpportunity,
  opportunityTypeForTrackingCategory,
} from "./tracking-validation.js";

const EVIDENCE_REQUIRED_STATUSES = new Set<TrackingStatus>([
  "ELIGIBLE",
  "INELIGIBLE",
  "WON",
  "LOST",
]);

const TERMINAL_STATUSES = new Set<TrackingStatus>([
  "WON",
  "LOST",
  "INELIGIBLE",
  "COMPLETED",
  "EXPIRED",
  "CLOSED",
  "ARCHIVED",
]);

type LearningOutcomeRecorder = Pick<LearningService, "recordOutcome">;

export interface OpportunityTrackingServiceOptions {
  now?: () => Date;
}

export class OpportunityTrackingService {
  private readonly now: () => Date;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: TrackingRepository,
    private readonly learningService: LearningOutcomeRecorder,
    options: OpportunityTrackingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  add(input: NewTrackedOpportunity): Promise<TrackingAddResult> {
    return this.runSerially(async () => {
      const now = this.now().toISOString();
      const candidate = createTrackedOpportunityRecord(input, randomUUID(), now);
      const duplicate = await this.findDuplicate(candidate);
      if (duplicate) return { record: duplicate, created: false };
      const record = await this.repository.create(candidate);
      return { record, created: true };
    });
  }

  addFromOpportunity(opportunity: Opportunity): Promise<TrackingAddResult> {
    const characteristics = opportunity.characteristics;
    const characteristicRecord = characteristics as Readonly<Record<string, unknown>>;
    const project =
      !Array.isArray(characteristics) &&
      typeof characteristicRecord.project === "string"
        ? characteristicRecord.project
        : undefined;

    return this.add({
      sourceOpportunityId: opportunity.id,
      title: opportunity.title,
      description: opportunity.description,
      category: categoryForOpportunity(opportunity),
      ...(project ? { project } : {}),
      sourceName: opportunity.source,
      sourceUrl: opportunity.sourceUrl,
      deadline: opportunity.deadline,
    });
  }

  list(filters: TrackingFilters = {}): Promise<TrackedOpportunity[]> {
    return this.repository.list(filters);
  }

  get(id: string): Promise<TrackedOpportunity | undefined> {
    return this.repository.get(requireId(id));
  }

  update(
    id: string,
    changes: TrackedOpportunityChanges,
  ): Promise<TrackedOpportunity | undefined> {
    return this.runSerially(() => this.updateInOrder(id, changes));
  }

  markApplied(
    id: string,
    at?: string,
    evidence: TrackingEvidence[] = [],
  ): Promise<TrackedOpportunity> {
    return this.runSerially(async () => {
      const timestamp = normalizeDateInput(at ?? this.now().toISOString(), "application date");
      if (!timestamp) throw new Error("Application date is required.");
      const updated = await this.transitionInOrder(
        id,
        "APPLIED",
        { at: timestamp, evidence },
        { applicationDate: timestamp },
      );
      return updated;
    });
  }

  markSubmitted(
    id: string,
    at?: string,
    evidence: TrackingEvidence[] = [],
  ): Promise<TrackedOpportunity> {
    return this.runSerially(async () => {
      const timestamp = normalizeDateInput(at ?? this.now().toISOString(), "submission date");
      if (!timestamp) throw new Error("Submission date is required.");
      return this.transitionInOrder(
        id,
        "SUBMITTED",
        { at: timestamp, evidence },
        { submissionDate: timestamp },
      );
    });
  }

  setStatus(
    id: string,
    status: TrackingStatus,
    options: TrackingStatusOptions = {},
  ): Promise<TrackedOpportunity> {
    return this.runSerially(() => this.transitionInOrder(id, status, options));
  }

  recordEligibilityResult(
    id: string,
    result: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN",
    evidence: TrackingEvidence[],
    at?: string,
  ): Promise<TrackedOpportunity> {
    return this.runSerially(() =>
      this.recordStatusOutcomeInOrder(
        id,
        result,
        result === "ELIGIBLE" ? "success" : result === "INELIGIBLE" ? "failure" : "unknown",
        `Eligibility check result: ${result.toLowerCase()}.`,
        evidence,
        at,
      ),
    );
  }

  recordCompetitionResult(
    id: string,
    result: "WON" | "LOST" | "PENDING" | "UNKNOWN",
    evidence: TrackingEvidence[],
    at?: string,
  ): Promise<TrackedOpportunity> {
    const outcome: OutcomeResult | "unknown" =
      result === "WON" ? "success" : result === "LOST" ? "failure" : "unknown";
    return this.runSerially(() =>
      this.recordStatusOutcomeInOrder(
        id,
        result,
        outcome,
        `Competition result: ${result.toLowerCase()}.`,
        evidence,
        at,
      ),
    );
  }

  recordOutcome(
    id: string,
    input: TrackingOutcomeInput,
  ): Promise<TrackedOpportunity> {
    return this.runSerially(async () => {
      if (!["success", "failure", "neutral", "unknown"].includes(input.outcome)) {
        throw new Error("Outcome must be success, failure, neutral, or unknown.");
      }
      const current = await this.requireRecord(id);
      const occurredAt = normalizeDateInput(
        input.occurredAt ?? this.now().toISOString(),
        "outcome date",
      );
      if (!occurredAt) throw new Error("Outcome date is required.");
      const evidence = requireEvidence(input.evidence);
      const description = assertSafeStoredText(input.description, "outcome description");
      const outcome = makeOutcome(current, {
        outcome: input.outcome,
        description,
        evidence: serializeEvidence(evidence),
        occurredAt,
      });

      await this.learnFromOutcome(outcome);
      return this.saveWithOutcome(current, outcome, current.statusHistory);
    });
  }

  addNote(id: string, note: string): Promise<TrackedOpportunity> {
    return this.runSerially(async () => {
      const current = await this.requireRecord(id);
      const normalized = assertSafeStoredText(note, "note");
      const notes = current.notes ? `${current.notes}\n${normalized}` : normalized;
      const result = await this.updateInOrder(id, { notes });
      if (!result) throw new Error("Tracked opportunity was not found.");
      return result;
    });
  }

  setNextAction(
    id: string,
    action: string,
    dueAt?: string | null,
  ): Promise<TrackedOpportunity> {
    return this.runSerially(async () => {
      const result = await this.updateInOrder(id, {
        nextAction: action,
        nextActionDueAt: dueAt,
      });
      if (!result) throw new Error("Tracked opportunity was not found.");
      return result;
    });
  }

  close(id: string, options: TrackingStatusOptions = {}): Promise<TrackedOpportunity> {
    return this.setStatus(id, "CLOSED", options);
  }

  archive(id: string, options: TrackingStatusOptions = {}): Promise<TrackedOpportunity> {
    return this.setStatus(id, "ARCHIVED", options);
  }

  reopen(
    id: string,
    status: "DISCOVERED" | "INTERESTED" | "APPLIED" | "SUBMITTED" | "PENDING" = "DISCOVERED",
    options: TrackingStatusOptions = {},
  ): Promise<TrackedOpportunity> {
    return this.runSerially(async () => {
      const current = await this.requireRecord(id);
      if (current.status !== "CLOSED" && current.status !== "ARCHIVED") {
        throw new Error("Only closed or archived opportunities can be reopened.");
      }
      return this.transitionInOrder(id, status, options);
    });
  }

  delete(id: string): Promise<boolean> {
    return this.runSerially(() => this.repository.delete(requireId(id)));
  }

  async listUpcoming(
    withinDays = 7,
    referenceTime: Date = this.now(),
  ): Promise<TrackedOpportunity[]> {
    const days = normalizeDays(withinDays);
    const start = referenceTime.getTime();
    const end = start + days * 24 * 60 * 60 * 1000;
    const records = await this.repository.list();
    return records
      .filter((record) => !TERMINAL_STATUSES.has(record.status))
      .map((record) => ({
        record,
        dueAt: nextDueAt(record, start, end),
      }))
      .filter(
        (item): item is { record: TrackedOpportunity; dueAt: number } =>
          item.dueAt !== undefined,
      )
      .sort(
        (left, right) =>
          left.dueAt - right.dueAt || left.record.id.localeCompare(right.record.id),
      )
      .map(({ record }) => record);
  }

  async listOverdue(referenceTime: Date = this.now()): Promise<TrackedOpportunity[]> {
    const now = referenceTime.getTime();
    const records = await this.repository.list();
    return records
      .filter((record) => !TERMINAL_STATUSES.has(record.status))
      .filter((record) =>
        [record.deadline, record.nextActionDueAt].some(
          (date) => date !== undefined && Date.parse(date) < now,
        ),
      )
      .sort((left, right) =>
        earliestDate(left, ["deadline", "nextActionDueAt"]).localeCompare(
          earliestDate(right, ["deadline", "nextActionDueAt"]),
        ),
      );
  }

  private runSerially<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async updateInOrder(
    id: string,
    changes: TrackedOpportunityChanges,
  ): Promise<TrackedOpportunity | undefined> {
    const normalizedId = requireId(id);
    const current = await this.repository.get(normalizedId);
    if (!current) return undefined;
    const updated = normalizeTrackedOpportunity({
      ...current,
      ...changes,
      id: current.id,
      sourceOpportunityId: current.sourceOpportunityId,
      status: current.status,
      statusHistory: current.statusHistory,
      outcomes: current.outcomes,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    });
    await this.assertNoDuplicate(updated, current.id);
    return this.repository.replace(updated);
  }

  private async transitionInOrder(
    id: string,
    status: TrackingStatus,
    options: TrackingStatusOptions,
    changes: TrackedOpportunityChanges = {},
  ): Promise<TrackedOpportunity> {
    const current = await this.requireRecord(id);
    const nextStatus = normalizeTrackingStatus(status);
    const at =
      normalizeDateInput(options.at ?? this.now().toISOString(), "status timestamp") ??
      this.now().toISOString();
    const evidence = normalizeTrackingEvidence(options.evidence);
    ensureEvidenceForStatus(nextStatus, evidence);

    let outcome: OpportunityOutcome | undefined;
    const outcomeType = outcomeForStatus(nextStatus);
    if (outcomeType) {
      outcome = makeOutcome(current, {
        outcome: outcomeType,
        description: `Tracked opportunity status set to ${nextStatus.toLowerCase()}.`,
        evidence: serializeEvidence(evidence),
        occurredAt: at,
      });
      await this.learnFromOutcome(outcome);
    }

    const history = [
      ...current.statusHistory,
      {
        previousStatus: current.status,
        status: nextStatus,
        at,
        evidence,
      },
    ];
    const updated = normalizeTrackedOpportunity({
      ...current,
      ...changes,
      status: nextStatus,
      statusHistory: history,
      outcomes: outcome ? [...current.outcomes, outcome] : current.outcomes,
      updatedAt: this.now().toISOString(),
    });
    const saved = await this.repository.replace(updated);
    if (!saved) throw new Error("Tracked opportunity was not found.");
    return saved;
  }

  private async recordStatusOutcomeInOrder(
    id: string,
    status: TrackingStatus,
    outcomeType: OutcomeResult | "unknown",
    description: string,
    evidenceInput: TrackingEvidence[],
    at?: string,
  ): Promise<TrackedOpportunity> {
    const current = await this.requireRecord(id);
    const normalizedStatus = normalizeTrackingStatus(status);
    const evidence = requireEvidence(evidenceInput);
    const occurredAt =
      normalizeDateInput(at ?? this.now().toISOString(), "outcome date") ??
      this.now().toISOString();
    const outcome = makeOutcome(current, {
      outcome: outcomeType,
      description,
      evidence: serializeEvidence(evidence),
      occurredAt,
    });
    await this.learnFromOutcome(outcome);
    const history = [
      ...current.statusHistory,
      {
        previousStatus: current.status,
        status: normalizedStatus,
        at: occurredAt,
        evidence,
      },
    ];
    return this.saveWithOutcome(
      { ...current, status },
      outcome,
      history,
    );
  }

  private async saveWithOutcome(
    current: TrackedOpportunity,
    outcome: OpportunityOutcome,
    history: TrackedOpportunity["statusHistory"],
  ): Promise<TrackedOpportunity> {
    const updated = normalizeTrackedOpportunity({
      ...current,
      statusHistory: history,
      outcomes: [...current.outcomes, outcome],
      updatedAt: this.now().toISOString(),
    });
    const saved = await this.repository.replace(updated);
    if (!saved) throw new Error("Tracked opportunity was not found.");
    return saved;
  }

  private async learnFromOutcome(outcome: OpportunityOutcome): Promise<void> {
    const observation = toLearningObservation(outcome);
    if (observation) await this.learningService.recordOutcome(observation);
  }

  private async requireRecord(id: string): Promise<TrackedOpportunity> {
    const record = await this.repository.get(requireId(id));
    if (!record) throw new Error("Tracked opportunity was not found.");
    return record;
  }

  private async findDuplicate(
    candidate: TrackedOpportunity,
  ): Promise<TrackedOpportunity | undefined> {
    const records = await this.repository.list();
    return records.find((record) => sameTrackingIdentity(record, candidate));
  }

  private async assertNoDuplicate(
    candidate: TrackedOpportunity,
    exceptId: string,
  ): Promise<void> {
    const duplicate = (await this.repository.list()).find(
      (record) =>
        record.id !== exceptId && sameTrackingIdentity(record, candidate),
    );
    if (duplicate) {
      throw new Error("Update would duplicate another tracked opportunity.");
    }
  }
}

function ensureEvidenceForStatus(
  status: TrackingStatus,
  evidence: TrackingEvidence[],
): void {
  if (EVIDENCE_REQUIRED_STATUSES.has(status) && evidence.length === 0) {
    throw new Error(`Evidence is required before setting status ${status}.`);
  }
}

function requireEvidence(evidence: TrackingEvidence[] | undefined): TrackingEvidence[] {
  const normalized = normalizeTrackingEvidence(evidence);
  if (normalized.length === 0) {
    throw new Error("Evidence is required to record a result.");
  }
  return normalized;
}

function outcomeForStatus(
  status: TrackingStatus,
): OutcomeResult | undefined {
  if (status === "ELIGIBLE" || status === "WON") return "success";
  if (status === "INELIGIBLE" || status === "LOST") return "failure";
  return undefined;
}

function makeOutcome(
  record: TrackedOpportunity,
  input: NewOpportunityOutcome,
): OpportunityOutcome {
  const characteristics: Record<string, string | boolean | number> = {
    trackingCategory: record.category,
  };
  if (record.project) characteristics.project = record.project;
  if (record.sourceName) characteristics.sourceName = record.sourceName;
  if (record.sourceUrl) characteristics.sourceUrl = record.sourceUrl;

  const opportunity: Opportunity = {
    id: record.id,
    title: record.title,
    description: record.description ?? record.title,
    source: record.sourceName ?? record.project ?? "Muse opportunity tracker",
    sourceUrl: record.sourceUrl,
    detectedAt: record.createdAt,
    deadline: record.deadline ?? null,
    opportunityType: opportunityTypeForTrackingCategory(record.category),
    characteristics,
    requirements: [],
    status: "SAVED",
  };
  return createOpportunityOutcome(opportunity, input);
}

function serializeEvidence(evidence: TrackingEvidence[]): string {
  return evidence
    .map((item) =>
      [
        item.description,
        item.source ? `Source: ${item.source}` : undefined,
        item.url ? `URL: ${item.url}` : undefined,
        item.observedAt ? `Observed at: ${item.observedAt}` : undefined,
      ]
        .filter(Boolean)
        .join(" — "),
    )
    .join("\n");
}

function sameTrackingIdentity(
  left: TrackedOpportunity,
  right: TrackedOpportunity,
): boolean {
  if (
    left.sourceOpportunityId &&
    right.sourceOpportunityId &&
    left.sourceOpportunityId === right.sourceOpportunityId
  ) {
    return true;
  }
  const leftUrl = canonicalUrl(left.sourceUrl);
  const rightUrl = canonicalUrl(right.sourceUrl);
  if (leftUrl && rightUrl && leftUrl === rightUrl) return true;
  return (
    identityText(left.title) === identityText(right.title) &&
    left.category === right.category &&
    identityText(left.project ?? "") === identityText(right.project ?? "")
  );
}

function canonicalUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith("utm_") ||
      ["fbclid", "gclid", "mc_cid", "mc_eid", "ref"].includes(normalized)
    ) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function identityText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function requireId(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Tracked opportunity ID is required.");
  }
  return value.trim();
}

function normalizeDays(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 365) {
    throw new Error("Upcoming deadline window must be an integer from 0 to 365 days.");
  }
  return value;
}

function nextDueAt(
  record: TrackedOpportunity,
  start: number,
  end: number,
): number | undefined {
  const dates = [
    record.deadline,
    record.launchDate,
    record.expectedResultDate,
    record.nextActionDueAt,
  ]
    .filter((date): date is string => Boolean(date))
    .map((date) => Date.parse(date))
    .filter((date) => date >= start && date <= end);
  return dates.length ? Math.min(...dates) : undefined;
}

function earliestDate(
  record: TrackedOpportunity,
  keys: ("deadline" | "nextActionDueAt")[],
): string {
  return keys
    .map((key) => record[key])
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? "";
}
