import { randomUUID } from "node:crypto";
import {
  REMINDER_STATUSES,
  REMINDER_TYPES,
  type NewReminder,
  type NotificationUrgency,
  type Reminder,
  type ReminderDeliveryAttempt,
  type ReminderOrigin,
  type ReminderPriority,
  type ReminderStatus,
  type ReminderType,
} from "./reminder-types.js";

export const DEFAULT_REMINDER_TIMEZONE = "Africa/Lagos";
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 8_000;
const MAX_ATTEMPTS = 500;

const REMINDER_ORIGINS: ReminderOrigin[] = [
  "USER",
  "TRACKED_OPPORTUNITY",
  "WATCH_ANNOUNCEMENT",
];
const PRIORITIES: ReminderPriority[] = ["low", "normal", "high", "critical"];
const URGENCIES: NotificationUrgency[] = ["low", "normal", "high", "urgent"];

export function createReminderRecord(
  input: NewReminder,
  now: string,
): Reminder {
  const id = randomUUID();
  return normalizeReminder({
    ...input,
    id,
    deduplicationKey: input.deduplicationKey ?? `${input.origin ?? "USER"}:${id}`,
    origin: input.origin ?? "USER",
    body: input.body ?? "",
    timezone: input.timezone ?? DEFAULT_REMINDER_TIMEZONE,
    priority: input.priority ?? "normal",
    urgency: input.urgency ?? "normal",
    status: "scheduled",
    createdAt: now,
    updatedAt: now,
    deliveryAttempts: 0,
    deliveryHistory: [],
  });
}

export function normalizeReminder(value: unknown): Reminder {
  if (!isRecord(value)) throw new Error("Reminder record must be an object.");
  const type = requiredEnum(value.type, REMINDER_TYPES, "type");
  const status = requiredEnum(value.status, REMINDER_STATUSES, "status");
  const origin = requiredEnum(value.origin, REMINDER_ORIGINS, "origin");
  const attempts = value.deliveryHistory;
  if (!Array.isArray(attempts) || attempts.length > MAX_ATTEMPTS) {
    throw new Error("Reminder delivery history is invalid or exceeds the limit.");
  }
  const deliveryHistory = attempts.map(normalizeAttempt);
  const deliveryAttempts = boundedInteger(value.deliveryAttempts, 0, MAX_ATTEMPTS, "delivery attempts");
  if (deliveryAttempts !== deliveryHistory.length) {
    throw new Error("Reminder delivery attempt count does not match its history.");
  }

  const timezone = normalizeTimezone(value.timezone);
  const deliveryReceipt = value.deliveryReceipt
    ? normalizeReceipt(value.deliveryReceipt)
    : undefined;
  if (status === "delivered" && !deliveryReceipt) {
    throw new Error("A delivered reminder must include an adapter receipt.");
  }
  if (status === "snoozed" && !optionalDate(value.snoozeUntil, "snooze time")) {
    throw new Error("A snoozed reminder must include a snooze time.");
  }

  const body = optionalSafeText(value.body, "body", MAX_BODY_LENGTH) ?? "";
  return {
    id: requiredText(value.id, "ID", 300),
    deduplicationKey: requiredText(value.deduplicationKey, "deduplication key", 1_000),
    origin,
    title: requiredText(value.title, "title", MAX_TITLE_LENGTH),
    body,
    type,
    ...(optionalText(value.trackingOpportunityId, "tracked opportunity ID", 300)
      ? { trackingOpportunityId: optionalText(value.trackingOpportunityId, "tracked opportunity ID", 300) }
      : {}),
    ...(optionalText(value.opportunityId, "opportunity ID", 300)
      ? { opportunityId: optionalText(value.opportunityId, "opportunity ID", 300) }
      : {}),
    ...(optionalDate(value.eventAt, "event time") ? { eventAt: optionalDate(value.eventAt, "event time") } : {}),
    scheduledAt: requiredDate(value.scheduledAt, "scheduled time"),
    ...(optionalDate(value.snoozeUntil, "snooze time")
      ? { snoozeUntil: optionalDate(value.snoozeUntil, "snooze time") }
      : {}),
    timezone,
    priority: requiredEnum(value.priority, PRIORITIES, "priority"),
    urgency: requiredEnum(value.urgency, URGENCIES, "urgency"),
    status,
    createdAt: requiredDate(value.createdAt, "creation time"),
    updatedAt: requiredDate(value.updatedAt, "update time"),
    deliveryAttempts,
    deliveryHistory,
    ...(optionalDate(value.nextAttemptAt, "next attempt time")
      ? { nextAttemptAt: optionalDate(value.nextAttemptAt, "next attempt time") }
      : {}),
    ...(optionalSafeText(value.lastError, "last error", 1_000)
      ? { lastError: optionalSafeText(value.lastError, "last error", 1_000) }
      : {}),
    ...(deliveryReceipt ? { deliveryReceipt } : {}),
    ...(optionalSafeText(value.cancellationReason, "cancellation reason", 1_000)
      ? { cancellationReason: optionalSafeText(value.cancellationReason, "cancellation reason", 1_000) }
      : {}),
  };
}

export function normalizeReminderDate(value: string, field: string): string {
  return requiredDate(value, field);
}

export function normalizeReminderTimezone(value: string): string {
  return normalizeTimezone(value);
}

function normalizeAttempt(value: unknown): ReminderDeliveryAttempt {
  if (!isRecord(value)) throw new Error("Reminder delivery attempt is invalid.");
  const result = requiredEnum(
    value.result,
    ["pending", "delivered", "retryable_failure", "permanent_failure"] as const,
    "delivery result",
  );
  const receipt = value.receipt ? normalizeReceipt(value.receipt) : undefined;
  if (result === "delivered" && !receipt) {
    throw new Error("A successful delivery attempt must include a receipt.");
  }
  return {
    attempt: boundedInteger(value.attempt, 1, MAX_ATTEMPTS, "attempt number"),
    startedAt: requiredDate(value.startedAt, "attempt start time"),
    ...(optionalDate(value.finishedAt, "attempt finish time")
      ? { finishedAt: optionalDate(value.finishedAt, "attempt finish time") }
      : {}),
    result,
    ...(optionalSafeText(value.error, "delivery error", 1_000)
      ? { error: optionalSafeText(value.error, "delivery error", 1_000) }
      : {}),
    ...(optionalDate(value.retryAt, "retry time")
      ? { retryAt: optionalDate(value.retryAt, "retry time") }
      : {}),
    ...(receipt ? { receipt } : {}),
  };
}

function normalizeReceipt(value: unknown): Reminder["deliveryReceipt"] & {} {
  if (!isRecord(value)) throw new Error("Notification delivery receipt is invalid.");
  const mock = value.mock;
  if (typeof mock !== "boolean") {
    throw new Error("Notification delivery receipt must identify whether it is a mock.");
  }
  const detail = optionalSafeText(value.detail, "receipt detail", 1_000);
  return {
    adapterId: requiredText(value.adapterId, "adapter ID", 200),
    receiptId: requiredText(value.receiptId, "receipt ID", 500),
    confirmedAt: requiredDate(value.confirmedAt, "receipt confirmation time"),
    mock,
    ...(detail ? { detail } : {}),
  };
}

function normalizeTimezone(value: unknown): string {
  const timezone = requiredText(value, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error(`Reminder timezone "${timezone}" is not a valid IANA timezone.`);
  }
  return timezone;
}

function requiredDate(value: unknown, field: string): string {
  const normalized = optionalDate(value, field);
  if (!normalized) throw new Error(`Reminder ${field} is required.`);
  return normalized;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new Error(`Reminder ${field} must be a valid date.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Reminder ${field} must be a valid date.`);
  return date.toISOString();
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Reminder ${field} cannot be empty.`);
  }
  const normalized = sanitizeSensitiveText(value.trim()).slice(0, maxLength);
  if (!normalized) throw new Error(`Reminder ${field} cannot be empty.`);
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, field, maxLength);
}

function optionalSafeText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  return optionalText(value, field, maxLength);
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g,
      "[redacted credential]",
    )
    .replace(/\b0x[a-f\d]{64}\b/gi, "[redacted private key]")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|authorization|password|secret|token|private[_ -]?key|seed[_ -]?phrase)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Reminder ${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Reminder ${field} is not supported.`);
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
