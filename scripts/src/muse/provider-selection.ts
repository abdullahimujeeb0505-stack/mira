import { AgentRouterProvider } from "./agentrouter-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { GroqProvider } from "./groq-provider.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";

export type MuseProviderName = "groq" | "agentrouter" | "openrouter" | "gemini";

export interface TextGenerationProviderFactories {
  groq?: () => TextGenerationProvider;
  agentrouter?: () => TextGenerationProvider;
  openrouter?: () => TextGenerationProvider;
  gemini?: () => TextGenerationProvider;
}

export interface ProviderSelectionOptions {
  provider?: string;
  factories?: TextGenerationProviderFactories;
}

export function formatProviderDiagnostic(
  provider: TextGenerationProvider,
): string {
  if (!provider.providerName || !provider.model) {
    throw new Error(
      "The selected LLM provider does not expose provider/model diagnostics.",
    );
  }
  return `Muse LLM provider: ${provider.providerName} (model: ${provider.model}).`;
}

export function createTextGenerationProvider(
  options: ProviderSelectionOptions = {},
): TextGenerationProvider {
  const configuredProvider =
    options.provider ?? process.env.MUSE_LLM_PROVIDER ?? "gemini";
  const provider = configuredProvider.trim().toLowerCase() || "gemini";

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

  if (provider === "gemini") {
    return (options.factories?.gemini ?? (() => new GeminiProvider()))();
  }

  throw new Error(
    `Unsupported MUSE_LLM_PROVIDER "${configuredProvider}". Choose "groq", "openrouter", "agentrouter", or "gemini".`,
  );
}
