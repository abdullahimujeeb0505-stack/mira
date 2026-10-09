import type {
  NotificationUrgency,
  ReminderPriority,
} from "./reminder-types.js";

export interface NotificationMessage {
  reminderId: string;
  deduplicationKey: string;
  title: string;
  body: string;
  priority: ReminderPriority;
  urgency: NotificationUrgency;
  scheduledAt: string;
  timezone: string;
}

export interface NotificationSendContext {
  signal: AbortSignal;
}

export type NotificationSendResult =
  | { kind: "delivered"; receipt: NotificationReceiptInput }
  | { kind: "retryable_failure"; error: string; retryAfterMs?: number }
  | { kind: "permanent_failure"; error: string };

export type NotificationReceiptInput = {
  adapterId: string;
  receiptId: string;
  confirmedAt: string;
  mock: boolean;
  detail?: string;
};

export interface NotificationAdapter {
  readonly id: string;
  send(
    message: NotificationMessage,
    context: NotificationSendContext,
  ): Promise<NotificationSendResult>;
}
