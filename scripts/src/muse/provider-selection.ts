import { AgentRouterProvider } from "./agentrouter-provider.js";
import { GroqResponsesProvider } from "./groq-responses-provider.js";
import type { TextGenerationProvider } from "./llm-provider.js";

export type MuseProviderName = "groq" | "agentrouter";

export interface TextGenerationProviderFactories {
  groq?: () => TextGenerationProvider;
  agentrouter?: () => TextGenerationProvider;
}

export interface ProviderSelectionOptions {
  provider?: string;
  factories?: TextGenerationProviderFactories;
}

export function createTextGenerationProvider(
  options: ProviderSelectionOptions = {},
): TextGenerationProvider {
  const configuredProvider =
    options.provider ?? process.env.MUSE_LLM_PROVIDER ?? "groq";
  const provider = configuredProvider.trim().toLowerCase() || "groq";

  if (provider === "groq") {
    return (options.factories?.groq ?? (() => new GroqResponsesProvider()))();
  }

  if (provider === "agentrouter") {
    return (
      options.factories?.agentrouter ?? (() => new AgentRouterProvider())
    )();
  }

  throw new Error(
    `Unsupported MUSE_LLM_PROVIDER "${configuredProvider}". Choose "groq" or "agentrouter".`,
  );
}
