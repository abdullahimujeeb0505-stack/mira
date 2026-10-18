import { AgentRouterProvider } from "./agentrouter-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { GroqProvider } from "./groq-provider.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";

export type MuseProviderName = "groq" | "agentrouter" | "openrouter" | "gemini";

export type MuseTaskName = "chat" | "research";

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

export interface TaskProviderSelectionOptions {
  /** Preferred provider for quick conversational turns. Default "groq". */
  chatProvider?: string;
  /** Preferred provider for research planning, synthesis, and long-form writing. Default "gemini". */
  researchProvider?: string;
  factories?: TextGenerationProviderFactories;
}

export interface TaskProviderResolution {
  provider: TextGenerationProvider;
  /** Provider name the configuration asked for. */
  requested: string;
  /** Provider name actually in use (differs from `requested` after a fallback). */
  used: string;
  /** Set when the requested provider was unavailable and `used` replaced it. */
  fallbackReason?: string;
}

export interface TaskAwareProviders {
  chat: TaskProviderResolution;
  research: TaskProviderResolution;
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

function instantiateProvider(
  provider: string,
  factories: TextGenerationProviderFactories | undefined,
): TextGenerationProvider {
  const name = provider.trim().toLowerCase();
  if (name === "groq") {
    return (factories?.groq ?? (() => new GroqProvider()))();
  }
  if (name === "agentrouter") {
    return (factories?.agentrouter ?? (() => new AgentRouterProvider()))();
  }
  if (name === "openrouter") {
    return (factories?.openrouter ?? (() => new OpenRouterProvider()))();
  }
  if (name === "gemini") {
    return (factories?.gemini ?? (() => new GeminiProvider()))();
  }
  throw new Error(
    `Unsupported MUSE_LLM_PROVIDER "${provider}". Choose "groq", "openrouter", "agentrouter", or "gemini".`,
  );
}

export function createTextGenerationProvider(
  options: ProviderSelectionOptions = {},
): TextGenerationProvider {
  const configuredProvider =
    options.provider ?? process.env.MUSE_LLM_PROVIDER ?? "groq";
  return instantiateProvider(configuredProvider, options.factories);
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the provider's short HTTP error detail visible in diagnostics. The
 * adapters redact their own credentials; this final pass also removes any
 * configured provider key in case an upstream error echoed one back.
 */
function describeProviderFailureDetail(error: unknown): string | undefined {
  const message = describeFailure(error);
  const status = message.match(/HTTP \d{3}/i);
  if (!status || status.index === undefined) return undefined;

  let detail = message.slice(status.index + status[0].length).trim();
  while (/^[:.)—-]/.test(detail)) detail = detail.slice(1).trimStart();
  if (!detail || /^[.!?]+$/.test(detail)) return undefined;

  for (const name of [
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "GROK_API_CODING_KEY",
    "AGENTROUTER_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    const secret = process.env[name]?.trim();
    if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
  }

  detail = detail
    .replaceAll(String.fromCharCode(13), " ")
    .replaceAll(String.fromCharCode(10), " ")
    .replaceAll(String.fromCharCode(9), " ")
    .split(" ")
    .filter(Boolean)
    .join(" ");
  return detail ? detail.slice(0, 220) : undefined;
}

/**
 * Classify a provider failure into a short, honest cause label that is safe to
 * surface in user-facing messages and logs.
 */
export function classifyProviderFailure(error: unknown): string {
  const message = describeFailure(error);
  if (
    /401|403|unauthori[sz]ed|forbidden|api[ _-]?key|missing .*key|invalid .*key|credential/i.test(
      message,
    )
  ) {
    return "auth error (check the API key)";
  }
  if (/429|rate.?limit|quota|too many requests/i.test(message)) {
    return "rate limited";
  }
  if (/timeout|timed out/i.test(message)) {
    return "timeout";
  }
  if (
    /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket|dns/i.test(
      message,
    )
  ) {
    return "network error";
  }
  if (/safety|recitation|blocked/i.test(message)) {
    return "blocked by provider safety filters";
  }
  const httpStatus = message.match(/HTTP (\d{3})/i);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    if (status >= 500) return `provider outage (HTTP ${status})`;
    return `the provider rejected the request (HTTP ${status})`;
  }
  if (/without text output|malformed|unsupported response/i.test(message)) {
    return "the provider returned an unusable response";
  }
  return "provider error";
}

/**
 * Resolve the two task-aware providers: quick chat turns default to Groq
 * (speed) while research planning, synthesis, and long-form writing default to
 * Gemini (long context and citation discipline). Override with
 * `MUSE_CHAT_LLM_PROVIDER` / `MUSE_RESEARCH_LLM_PROVIDER`.
 *
 * When the preferred provider's credentials are missing, resolution falls back
 * to the other provider and records the reason so startup diagnostics can
 * surface the configuration problem instead of failing every request silently.
 */
export function createTaskAwareProviders(
  options: TaskProviderSelectionOptions = {},
): TaskAwareProviders {
  const chatRequested =
    (
      options.chatProvider ??
      process.env.MUSE_CHAT_LLM_PROVIDER ??
      process.env.MUSE_LLM_PROVIDER ??
      "groq"
    )
      .trim()
      .toLowerCase() || "groq";
  const researchRequested =
    (
      options.researchProvider ??
      process.env.MUSE_RESEARCH_LLM_PROVIDER ??
      process.env.MUSE_LLM_PROVIDER ??
      "gemini"
    )
      .trim()
      .toLowerCase() || "gemini";

  const resolve = (
    task: MuseTaskName,
    requested: string,
    alternate: string,
  ): TaskProviderResolution => {
    try {
      return {
        provider: instantiateProvider(requested, options.factories),
        requested,
        used: requested,
      };
    } catch (firstError) {
      if (alternate !== requested) {
        try {
          return {
            provider: instantiateProvider(alternate, options.factories),
            requested,
            used: alternate,
            fallbackReason: describeFailure(firstError),
          };
        } catch {
          // Both providers failed; report the original failure below.
        }
      }
      throw new Error(
        `No usable LLM provider for ${task} tasks. ` +
          `"${requested}" failed: ${describeFailure(firstError)} ` +
          `Set MUSE_${task.toUpperCase()}_LLM_PROVIDER to a provider whose API key ` +
          `is configured, or fix the missing credentials.`,
      );
    }
  };

  return {
    chat: resolve("chat", chatRequested, researchRequested),
    research: resolve("research", researchRequested, chatRequested),
  };
}

export function formatTaskProviderDiagnostics(
  providers: TaskAwareProviders,
): string[] {
  const lines = [
    `Muse chat LLM: ${providers.chat.provider.providerName} (model: ${providers.chat.provider.model}).`,
    `Muse research LLM: ${providers.research.provider.providerName} (model: ${providers.research.provider.model}).`,
  ];
  if (providers.chat.fallbackReason) {
    lines.push(
      `Muse chat LLM fell back from "${providers.chat.requested}" to "${providers.chat.used}": ${providers.chat.fallbackReason}`,
    );
  }
  if (providers.research.fallbackReason) {
    lines.push(
      `Muse research LLM fell back from "${providers.research.requested}" to "${providers.research.used}": ${providers.research.fallbackReason}`,
    );
  }
  return lines;
}

/**
 * Send a minimal probe request so configuration problems (bad keys, quotas,
 * network) are reported at startup instead of on the user's first research.
 * Never throws; returns a short status line with bounded, redacted HTTP details.
 */
export async function probeProviderConnection(
  label: string,
  provider: TextGenerationProvider,
): Promise<string> {
  try {
    await provider.generateText({
      systemPrompt: "Reply with the single word ok. Do not add anything else.",
      conversation: [{ role: "user", content: "ok" }],
    });
    return `LLM probe (${label}): ok.`;
  } catch (error) {
    const detail = describeProviderFailureDetail(error);
    const detailSuffix = detail ? ` — provider detail: ${detail}` : "";
    return (
      `LLM probe (${label}) FAILED: ${classifyProviderFailure(error)}` +
      `${detailSuffix} — provider "${provider.providerName}" (model: ${provider.model}).`
    );
  }
}
