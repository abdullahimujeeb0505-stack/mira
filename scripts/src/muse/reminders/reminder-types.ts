export const REMINDER_TYPES = [
  "OPPORTUNITY_DEADLINE",
  "APPLICATION_DEADLINE",
  "COMPETITION_DEADLINE",
  "MINT_DATE",
  "LAUNCH_TIME",
  "WALLET_CHECKER_ANNOUNCEMENT",
  "RESULT_ANNOUNCEMENT",
  "FOLLOW_UP",
  "USER_CREATED",
  "OPPORTUNITY_ANNOUNCEMENT",
] as const;

export type ReminderType = (typeof REMINDER_TYPES)[number];

export const REMINDER_STATUSES = [
  "scheduled",
  "due",
  "delivered",
  "snoozed",
  "cancelled",
  "failed",
] as const;

export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export type ReminderPriority = "low" | "normal" | "high" | "critical";
export type NotificationUrgency = "low" | "normal" | "high" | "urgent";
export type ReminderOrigin =
  | "USER"
  | "TRACKED_OPPORTUNITY"
  | "WATCH_ANNOUNCEMENT";

export interface NotificationReceipt {
  adapterId: string;
  receiptId: string;
  confirmedAt: string;
  mock: boolean;
  detail?: string;
}

export interface ReminderDeliveryAttempt {
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  result: "pending" | "delivered" | "retryable_failure" | "permanent_failure";
  error?: string;
  retryAt?: string;
  receipt?: NotificationReceipt;
}

export interface Reminder {
  id: string;
  deduplicationKey: string;
  origin: ReminderOrigin;
  title: string;
  body: string;
  type: ReminderType;
  trackingOpportunityId?: string;
  opportunityId?: string;
  eventAt?: string;
  scheduledAt: string;
  snoozeUntil?: string;
  timezone: string;
  priority: ReminderPriority;
  urgency: NotificationUrgency;
  status: ReminderStatus;
  createdAt: string;
  updatedAt: string;
  deliveryAttempts: number;
  deliveryHistory: ReminderDeliveryAttempt[];
  nextAttemptAt?: string;
  lastError?: string;
  deliveryReceipt?: NotificationReceipt;
  cancellationReason?: string;
}

export interface NewReminder {
  deduplicationKey?: string;
  origin?: ReminderOrigin;
  title: string;
  body?: string;
  type: ReminderType;
  trackingOpportunityId?: string;
  opportunityId?: string;
  eventAt?: string | null;
  scheduledAt: string;
  timezone?: string;
  priority?: ReminderPriority;
  urgency?: NotificationUrgency;
}

export interface ReminderChanges {
  title?: string;
  body?: string;
  type?: ReminderType;
  eventAt?: string | null;
  scheduledAt?: string;
  timezone?: string;
  priority?: ReminderPriority;
  urgency?: NotificationUrgency;
}

export interface ReminderFilters {
  status?: ReminderStatus;
  type?: ReminderType;
  trackingOpportunityId?: string;
  origin?: ReminderOrigin;
}

export interface ReminderRepository {
  list(filters?: ReminderFilters): Promise<Reminder[]>;
  get(id: string): Promise<Reminder | undefined>;
  findByDeduplicationKey(key: string): Promise<Reminder | undefined>;
  create(reminder: Reminder): Promise<Reminder>;
  replace(reminder: Reminder): Promise<Reminder | undefined>;
}

export interface ReminderCreateResult {
  reminder: Reminder;
  created: boolean;
  updated: boolean;
}

export interface ReminderCycleResult {
  checkedAt: string;
  due: number;
  delivered: number;
  retrying: number;
  failed: number;
  cancelledAsStale: number;
  errors: string[];
}

export function isReminderType(value: string): value is ReminderType {
  return REMINDER_TYPES.includes(value.toUpperCase() as ReminderType);
}

export function isReminderStatus(value: string): value is ReminderStatus {
  return REMINDER_STATUSES.includes(value.toLowerCase() as ReminderStatus);
}
