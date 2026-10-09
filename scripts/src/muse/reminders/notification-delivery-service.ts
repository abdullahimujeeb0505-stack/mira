import type {
  NotificationAdapter,
  NotificationMessage,
  NotificationSendResult,
} from "./notification-adapter.js";

export interface NotificationRuntime {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemNotificationRuntime: NotificationRuntime = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    if (handle !== undefined && handle !== null) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

export interface NotificationDeliveryServiceOptions {
  runtime?: NotificationRuntime;
  timeoutMs?: number;
}

export class NotificationDeliveryService {
  private readonly runtime: NotificationRuntime;
  private readonly timeoutMs: number;

  constructor(
    private readonly adapter: NotificationAdapter,
    options: NotificationDeliveryServiceOptions = {},
  ) {
    this.runtime = options.runtime ?? systemNotificationRuntime;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 100, 120_000);
  }

  async deliver(message: NotificationMessage): Promise<NotificationSendResult> {
    const controller = new AbortController();
    let timeoutHandle: unknown;
    const timeout = new Promise<NotificationSendResult>((resolve) => {
      timeoutHandle = this.runtime.setTimeout(() => {
        controller.abort();
        resolve({
          kind: "retryable_failure",
          error: `Notification adapter timed out after ${this.timeoutMs}ms.`,
        });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        this.adapter.send(message, { signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      return {
        kind: "retryable_failure",
        error: sanitizeError(error),
      };
    } finally {
      this.runtime.clearTimeout(timeoutHandle);
    }
  }
}

export function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .slice(0, 1_000);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Notification timeout must be an integer from ${minimum} to ${maximum}ms.`);
  }
  return value;
}
