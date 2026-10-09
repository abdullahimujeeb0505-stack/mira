import type {
  NotificationAdapter,
  NotificationMessage,
  NotificationSendContext,
  NotificationSendResult,
} from "./notification-adapter.js";
import type { NotificationReceipt } from "./reminder-types.js";

export class MockNotificationAdapter implements NotificationAdapter {
  readonly id = "mock";
  readonly messages: NotificationMessage[] = [];
  private readonly queuedResults: NotificationSendResult[] = [];
  private readonly receiptsByKey = new Map<string, NotificationReceipt>();
  private nextReceipt = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  queueResult(result: NotificationSendResult): void {
    this.queuedResults.push(result);
  }

  async send(
    message: NotificationMessage,
    _context: NotificationSendContext,
  ): Promise<NotificationSendResult> {
    this.messages.push(structuredClone(message));
    const prior = this.receiptsByKey.get(message.deduplicationKey);
    if (prior) return { kind: "delivered", receipt: prior };

    const result = this.queuedResults.shift() ?? this.makeSuccess();
    if (result.kind === "delivered") {
      this.receiptsByKey.set(message.deduplicationKey, {
        ...result.receipt,
        mock: true,
        detail: "Mock adapter confirmation; no phone notification was sent.",
      });
      return {
        kind: "delivered",
        receipt: this.receiptsByKey.get(message.deduplicationKey)!,
      };
    }
    return result;
  }

  private makeSuccess(): NotificationSendResult {
    return {
      kind: "delivered",
      receipt: {
        adapterId: this.id,
        receiptId: `mock-receipt-${this.nextReceipt++}`,
        confirmedAt: this.now().toISOString(),
        mock: true,
        detail: "Mock adapter confirmation; no phone notification was sent.",
      },
    };
  }
}
