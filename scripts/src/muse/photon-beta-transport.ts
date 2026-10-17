import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import { PhotonApiRequestError } from "./photon-beta-api.js";
import type { PhotonBetaConfiguration } from "./photon-beta.js";
import type { PhotonBetaMessageHandler } from "./photon-beta.js";
import { PhotonCursorStore } from "./photon-cursor-store.js";

const PHOTON_API_ORIGIN = "https://api.photon.codes";
const MAX_PENDING_DELIVERIES = 128;

export class PhotonBetaTransport {
  private socket?: ReturnType<typeof io>;
  private completion?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private queue: Promise<void> = Promise.resolve();
  private cursor = 0;
  private eventIds = new Set<string>();
  private generation = 0;
  private pending = 0;
  private stopping = false;

  constructor(
    private readonly configuration: PhotonBetaConfiguration,
    private readonly handler: PhotonBetaMessageHandler,
    private readonly cursorStore: PhotonCursorStore,
    private readonly reportFailure: (message: string) => void = console.error,
  ) {}

  async run(): Promise<void> {
    if (this.socket) throw new Error("Photon event transport is already running.");

    const state = await this.cursorStore.load();
    if (this.stopping) return;
    this.cursor = state.cursor;
    this.eventIds = new Set(state.eventIds);
    for (const eventId of state.eventIds) this.handler.markProcessed(eventId);

    const socket = io(
      PHOTON_API_ORIGIN,
      photonEventSocketOptions(this.configuration),
    );
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      this.completion = { resolve, reject };
      socket.on("connect", () => this.subscribe());
      socket.on("disconnect", () => {
        this.generation += 1;
      });
      socket.on("connect_error", (error: Error) => {
        if (isAuthenticationFailure(error)) {
          this.reportFailure(
            "Photon rejected the project ID or project API key; check project access.",
          );
          this.fail(new Error("Photon event authentication failed."));
        } else {
          this.reportFailure(
            "Photon event connection failed; Socket.IO will retry.",
          );
        }
      });
      socket.on("delivery_error", (error: unknown) =>
        this.handleDeliveryError(error),
      );
      socket.on(
        "delivery",
        (event: unknown, metadata: unknown) =>
          this.enqueueDelivery(event, metadata),
      );
      socket.connect();
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.queue;
    this.generation += 1;
    this.socket?.disconnect();
    this.completion?.resolve();
  }

  private subscribe(): void {
    const socket = this.socket;
    if (!socket || this.stopping) return;

    socket.timeout(10_000).emit(
      "subscribe",
      { startSeq: this.cursor },
      (error: Error | null, result: unknown) => {
        if (error || !isRecord(result) || result.ok !== true) {
          this.reportFailure("Photon rejected the event stream subscription.");
          this.restartStream();
        }
      },
    );
  }

  private enqueueDelivery(event: unknown, metadata: unknown): void {
    if (this.stopping) return;
    const delivery = parseDeliveryMetadata(metadata);
    const eventId = isRecord(event) && typeof event.id === "string"
      ? event.id
      : undefined;
    if (delivery === undefined || !eventId) {
      this.reportFailure("Photon delivered an invalid event frame.");
      this.restartStream();
      return;
    }

    if (++this.pending > MAX_PENDING_DELIVERIES) {
      this.pending -= 1;
      this.reportFailure("Photon event queue is full; reconnecting for replay.");
      this.restartStream();
      return;
    }

    const deliveryGeneration = this.generation;
    this.queue = this.queue
      .then(async () => {
        if (
          deliveryGeneration !== this.generation ||
          delivery.seq <= this.cursor
        ) {
          return;
        }

        if (!this.eventIds.has(eventId)) {
          await this.handler.handle(event);
        }
        if (deliveryGeneration !== this.generation) return;
        if (delivery.replyExpected) {
          await this.acknowledgeWebhookEvent(eventId);
        }
        if (deliveryGeneration !== this.generation) return;

        const nextEventIds = new Set(this.eventIds);
        nextEventIds.delete(eventId);
        nextEventIds.add(eventId);
        const boundedEventIds = [...nextEventIds].slice(-10_000);
        await this.cursorStore.save({
          cursor: delivery.seq,
          eventIds: boundedEventIds,
        });
        this.cursor = delivery.seq;
        this.eventIds = new Set(boundedEventIds);
        this.handler.markProcessed(eventId);
      })
      .catch(async (error: unknown) => {
        this.reportFailure(
          "Photon event processing failed; reconnecting from the last saved cursor.",
        );
        if (error instanceof PhotonApiRequestError && !error.retryable) {
          this.fail(new Error(error.message));
          return;
        }
        if (
          error instanceof PhotonApiRequestError &&
          error.retryAfterMs &&
          !this.stopping
        ) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, error.retryAfterMs),
          );
        }
        if (!this.stopping) this.restartStream();
      })
      .finally(() => {
        this.pending -= 1;
      });
  }

  private handleDeliveryError(value: unknown): void {
    const code =
      isRecord(value) &&
      typeof value.code === "string" &&
      /^[a-z_]+$/.test(value.code)
        ? value.code
        : "unknown";
    this.reportFailure(`Photon event stream reported ${code}.`);
    if (
      isRecord(value) &&
      value.fatal === true &&
      value.retryable === false
    ) {
      this.fail(new Error(`Photon stopped the event stream (${code}).`));
    }
  }

  private acknowledgeWebhookEvent(eventId: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.resolve();

    return new Promise<void>((resolve) => {
      socket.timeout(5_000).emit(
        "reply",
        photonWebhookAcknowledgement(eventId),
        (error: Error | null, result: unknown) => {
          if (error) {
            this.reportFailure(
              "Photon webhook acknowledgement timed out; its outcome is unknown.",
            );
          } else if (!isRecord(result) || result.ok !== true) {
            this.reportFailure("Photon did not accept a webhook acknowledgement.");
          }
          resolve();
        },
      );
    });
  }

  private restartStream(): void {
    if (this.stopping) return;
    this.generation += 1;
    this.socket?.io.engine?.close();
  }

  private fail(error: Error): void {
    if (this.stopping) return;
    this.stopping = true;
    this.generation += 1;
    this.socket?.disconnect();
    this.completion?.reject(error);
  }
}

export function defaultPhotonCursorPath(projectId: string): string {
  const hash = createHash("sha256").update(projectId).digest("hex");
  return fileURLToPath(new URL(
    `../../data/muse-photon-beta/${hash}.json`,
    import.meta.url,
  ));
}

export function photonEventSocketOptions(
  configuration: PhotonBetaConfiguration,
) {
  return {
    path:
      `/v1/projects/${encodeURIComponent(configuration.projectId)}` +
      "/events/ws",
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: {
      Authorization: `Bearer ${configuration.apiKey}`,
    },
    autoConnect: false,
  };
}

export function photonWebhookAcknowledgement(eventId: string) {
  return {
    eventId,
    status: 200,
    headers: { "content-type": "text/plain" },
    body: Buffer.from("accepted").toString("base64"),
  };
}

function parseDeliveryMetadata(
  value: unknown,
): { seq: number; replyExpected: boolean } | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.seq !== "number" ||
    value.seq < 0 ||
    typeof value.replyExpected !== "boolean"
  ) {
    return undefined;
  }
  return { seq: value.seq, replyExpected: value.replyExpected };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAuthenticationFailure(error: Error): boolean {
  if (/\b(401|403)\b|unauthorized|forbidden|authentication/i.test(error.message)) {
    return true;
  }
  for (const key of ["data", "context", "description"]) {
    const detail = isRecord(error) ? error[key] : undefined;
    if (
      isRecord(detail) &&
      (detail.status === 401 ||
        detail.status === 403 ||
        detail.statusCode === 401 ||
        detail.statusCode === 403)
    ) {
      return true;
    }
  }
  return false;
}
