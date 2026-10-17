import { AgentRouterProvider } from "./agentrouter-provider.js";
import { GroqProvider } from "./groq-provider.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";

export type MuseProviderName = "groq" | "agentrouter" | "openrouter";

export interface TextGenerationProviderFactories {
  groq?: () => TextGenerationProvider;
  agentrouter?: () => TextGenerationProvider;
  openrouter?: () => TextGenerationProvider;
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
    return (options.factories?.groq ?? (() => new GroqProvider()))();
  }

  if (provider === "agentrouter") {
    return (
      options.factories?.agentrouter ?? (() => new AgentRouterProvider())
    )();
  }

  if (provider === "openrouter") {
    return (
      options.factories?.openrouter ?? (() => new OpenRouterProvider())
    )();
  }

  throw new Error(
    `Unsupported MUSE_LLM_PROVIDER "${configuredProvider}". Choose "groq", "openrouter", or "agentrouter".`,
  );
}
