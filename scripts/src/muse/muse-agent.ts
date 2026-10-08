import type {
  ConversationMessage,
  TextGenerationProvider,
} from "./llm-provider.js";

const MUSE_SYSTEM_PROMPT =
  "You are Muse, the user's personal Web3 intern. Be thoughtful, practical, and concise. " +
  "Be clear about uncertainty, and never claim to have checked live information or taken an action unless you actually did so in this conversation.";

export class MuseAgent {
  private readonly conversation: ConversationMessage[] = [];

  constructor(private readonly provider: TextGenerationProvider) {}

  async respond(userMessage: string): Promise<string> {
    const content = userMessage.trim();
    if (!content) {
      throw new Error("Please enter a message.");
    }

    const pendingMessage: ConversationMessage = { role: "user", content };
    const response = await this.provider.generateText({
      systemPrompt: MUSE_SYSTEM_PROMPT,
      conversation: [...this.conversation, pendingMessage],
    });

    this.conversation.push(
      pendingMessage,
      { role: "assistant", content: response },
    );
    return response;
  }
}
