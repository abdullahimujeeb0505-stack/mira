import type { MuseAgent } from "./muse-agent.js";

export interface PhotonBetaConfiguration {
  projectId: string;
  apiKey: string;
}

export function readPhotonBetaConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PhotonBetaConfiguration {
  const projectId = env.PHOTON_PROJECT_ID?.trim();
  const apiKey = env.PHOTON_API_KEY?.trim();
  const missing = [
    !projectId ? "PHOTON_PROJECT_ID" : "",
    !apiKey ? "PHOTON_API_KEY" : "",
  ].filter(Boolean);

  if (!projectId || !apiKey) {
    throw new Error(
      `Set ${missing.join(" and ")} before starting the Photon 2.0 agent.`,
    );
  }

  return { projectId, apiKey };
}

export interface PhotonBetaMessage {
  eventId: string;
  messageId: string;
  spaceId: string;
  senderId: string;
  text: string;
}

export function parsePhotonBetaMessage(
  value: unknown,
  projectId: string,
): PhotonBetaMessage | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("Photon delivered an event without a valid event ID.");
  }
  if (typeof value.type !== "string") {
    throw new Error("Photon delivered an event without a valid event type.");
  }
  if (value.type !== "message.received") return undefined;
  if (!isRecord(value.data) || value.data.projectId !== projectId) {
    throw new Error("Photon delivered a message for an unexpected project.");
  }

  const message = value.data.object;
  if (!isRecord(message)) {
    throw new Error("Photon delivered a message event without a message object.");
  }
  if (message.platform !== "imessage") return undefined;
  if (value.source !== "imessage.photon") {
    throw new Error("Photon delivered an iMessage event with an invalid source.");
  }
  if (message.status !== "received") {
    throw new Error("Photon delivered a message event with an invalid status.");
  }

  const space = message.space;
  const sentBy = message.sentBy;
  const receivedBy = message.receivedBy;
  const content = message.content;
  if (
    !isRecord(space) ||
    typeof space.id !== "string" ||
    !space.id ||
    space.platform !== "imessage" ||
    !isRecord(sentBy) ||
    sentBy.kind !== "human" ||
    sentBy.platform !== "imessage" ||
    !isRecord(receivedBy) ||
    receivedBy.kind !== "agent" ||
    receivedBy.platform !== "imessage" ||
    typeof receivedBy.id !== "string" ||
    !receivedBy.id ||
    typeof message.id !== "string" ||
    !message.id
  ) {
    throw new Error("Photon delivered a message with an invalid sender or space.");
  }

  if (
    !isRecord(content) ||
    content.type !== "text" ||
    content.format !== "plain" ||
    typeof content.text !== "string" ||
    !content.text.trim()
  ) {
    return undefined;
  }

  return {
    eventId: value.id,
    messageId: message.id,
    spaceId: space.id,
    senderId: receivedBy.id,
    text: content.text.trim(),
  };
}

export interface PhotonBetaReply {
  messageId: string;
  spaceId: string;
  senderId: string;
  text: string;
}

export const PHOTON_BETA_FAILURE_REPLY =
  "Sorry, I couldn't complete that response just now. Please try again.";

type Agent = Pick<MuseAgent, "hasConversationHistory" | "respond">;

type Conversation = {
  agent: Agent;
  pending: Promise<void>;
};

export class PhotonBetaMessageHandler {
  private readonly conversations = new Map<string, Conversation>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly processed = new Set<string>();
  private readonly responseCache = new Map<string, string>();

  constructor(
    private readonly projectId: string,
    private readonly createAgent: (spaceKey: string) => Agent,
    private readonly sendReply: (reply: PhotonBetaReply) => Promise<void>,
    private readonly reportFailure: (message: string) => void = console.error,
  ) {}

  get conversationCount(): number {
    return this.conversations.size;
  }

  async handle(event: unknown): Promise<boolean> {
    const message = parsePhotonBetaMessage(event, this.projectId);
    if (!message) return false;
    if (this.processed.has(message.eventId)) return false;
    const pending = this.inFlight.get(message.eventId);
    if (pending) return pending;

    const processing = this.process(message);
    this.inFlight.set(message.eventId, processing);
    try {
      return await processing;
    } finally {
      this.inFlight.delete(message.eventId);
    }
  }

  markProcessed(eventId: string): void {
    this.processed.add(eventId);
    if (this.processed.size > 10_000) {
      const oldest = this.processed.values().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }
  }

  private async process(message: PhotonBetaMessage): Promise<boolean> {
    const spaceKey = `imessage:${message.spaceId}`;
    let conversation = this.conversations.get(spaceKey);
    if (!conversation) {
      conversation = {
        agent: this.createAgent(spaceKey),
        pending: Promise.resolve(),
      };
      this.conversations.set(spaceKey, conversation);
    }

    const activeConversation = conversation;
    const response = activeConversation.pending.then(async () => {
      let reply = this.responseCache.get(message.eventId);
      if (!reply) {
        try {
          reply = await activeConversation.agent.respond(message.text);
        } catch {
          this.reportFailure("Muse could not complete an incoming iMessage.");
          reply = PHOTON_BETA_FAILURE_REPLY;
        }
        this.responseCache.set(message.eventId, reply);
      }

      await this.sendReply({
        messageId: message.messageId,
        spaceId: message.spaceId,
        senderId: message.senderId,
        text: reply,
      });
    });
    activeConversation.pending = response.then(
      () => undefined,
      () => undefined,
    );
    await response;
    this.responseCache.delete(message.eventId);
    this.markProcessed(message.eventId);
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
