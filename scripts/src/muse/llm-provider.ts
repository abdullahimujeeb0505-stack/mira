export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

export interface TextGenerationRequest {
  systemPrompt: string;
  conversation: readonly ConversationMessage[];
}

export interface TextGenerationProvider {
  generateText(request: TextGenerationRequest): Promise<string>;
}
