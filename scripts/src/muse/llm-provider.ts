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
  readonly providerName?: string;
  readonly model?: string;
  generateText(request: TextGenerationRequest): Promise<string>;
}
