import { shouldResearchMessage } from "./message-routing.js";
import type { MuseAgent } from "./muse-agent.js";

export interface PhotonSpace {
  readonly __platform: string;
  readonly id: string;
  responding<T>(handler: () => T | Promise<T>): Promise<T>;
}

export interface PhotonMessage {
  content: { type: string; text?: string };
  direction: "inbound" | "outbound";
  platform: string;
  reply(content: string): Promise<unknown>;
}

export const PHOTON_FAILURE_REPLY =
  "Sorry, I couldn't complete that response just now. Please try again.";

type Conversation = {
  agent: Pick<MuseAgent, "hasConversationHistory" | "respond">;
  pending: Promise<void>;
};

export class PhotonMessageHandler {
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly createAgent: (
      spaceKey: string,
    ) => Pick<MuseAgent, "hasConversationHistory" | "respond">,
    private readonly reportFailure: (message: string) => void = console.error,
  ) {}

  get conversationCount(): number {
    return this.conversations.size;
  }

  async handle(space: PhotonSpace, message: PhotonMessage): Promise<boolean> {
    if (
      message.direction !== "inbound" ||
      message.platform !== "imessage" ||
      message.content.type !== "text" ||
      typeof message.content.text !== "string" ||
      !message.content.text.trim()
    ) {
      return false;
    }

    const spaceKey = `${space.__platform}:${space.id}`;
    let conversation = this.conversations.get(spaceKey);
    if (!conversation) {
      conversation = {
        agent: this.createAgent(spaceKey),
        pending: Promise.resolve(),
      };
      this.conversations.set(spaceKey, conversation);
    }

    const activeConversation = conversation;
    const text = message.content.text.trim();
    const response = activeConversation.pending.then(async () => {
      let reply: string;
      try {
        const research = shouldResearchMessage(
          text,
          activeConversation.agent.hasConversationHistory,
        );
        const respond = () => activeConversation.agent.respond(text);
        reply = research
          ? await space.responding(respond)
          : await respond();
      } catch {
        this.reportFailure("Muse could not complete an incoming iMessage.");
        reply = PHOTON_FAILURE_REPLY;
      }

      await message.reply(reply);
    });
    activeConversation.pending = response.then(
      () => undefined,
      () => undefined,
    );
    await response;
    return true;
  }
}
