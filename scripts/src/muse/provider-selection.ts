import { AgentRouterProvider } from "./agentrouter-provider.js";
import { GroqProvider } from "./groq-provider.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";

export type MuseProviderName = "groq" | "agentrouter" | "openrouter";

export type MuseTaskName = "chat" | "research";

const SUPPORTED_PROVIDERS = new Set<MuseProviderName>([
  "groq",
  "agentrouter",
  "openrouter",
]);

export interface TextGenerationProviderFactories {
  groq?: () => TextGenerationProvider;
  agentrouter?: () => TextGenerationProvider;
  openrouter?: () => TextGenerationProvider;
}

export interface ProviderSelectionOptions {
  provider?: string;
  factories?: TextGenerationProviderFactories;
}

export interface TaskProviderSelectionOptions {
  /** Preferred provider for quick conversational turns. Default "groq". */
  chatProvider?: string;
  /** Preferred provider for research, synthesis, and writing. Default "groq". */
  researchProvider?: string;
  factories?: TextGenerationProviderFactories;
}

export interface TaskProviderResolution {
  /** Request path: primary provider with runtime failover when configured. */
  provider: TextGenerationProvider;
  /** Actual provider selected as primary (or startup fallback if unavailable). */
  primaryProvider: TextGenerationProvider;
  /** Provider name the configuration asked for. */
  requested: string;
  /** Provider name actually in use (differs from `requested` after a startup fallback). */
  used: string;
  /** Optional runtime failover provider when the primary request fails. */
  fallbackProvider?: TextGenerationProvider;
  /** Classified reason when the runtime fallback could not be constructed. */
  fallbackUnavailableReason?: string;
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
  throw new Error(
    `Unsupported MUSE_LLM_PROVIDER "${provider}". Choose "groq", "openrouter", or "agentrouter".`,
  );
}

class ProviderWithFallback implements TextGenerationProvider {
  readonly providerName?: string;
  readonly model?: string;

  constructor(
    private readonly primary: TextGenerationProvider,
    private readonly fallback: TextGenerationProvider,
  ) {
    this.providerName = primary.providerName;
    this.model = primary.model;
  }

  async generateText(
    request: Parameters<TextGenerationProvider["generateText"]>[0],
  ): Promise<string> {
    try {
      return await this.primary.generateText(request);
    } catch (primaryError) {
      const primaryCause = classifyProviderFailure(primaryError);
      // Do not route provider safety refusals to another model.
      if (primaryCause === "blocked by provider safety filters")
        throw primaryError;

      console.warn(
        `Muse ${this.primary.providerName ?? "primary provider"} request failed (${primaryCause}); retrying with ${this.fallback.providerName ?? "fallback provider"}.`,
      );
      try {
        return await this.fallback.generateText(request);
      } catch (fallbackError) {
        const fallbackCause = classifyProviderFailure(fallbackError);
        throw new Error(
          `Primary ${this.primary.providerName ?? "provider"} failed (${primaryCause}); ` +
            `${this.fallback.providerName ?? "fallback provider"} fallback failed (${fallbackCause}).`,
        );
      }
    }
  }
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

function noUsableProviderError(
  task: MuseTaskName,
  requested: string,
  failure: unknown,
): Error {
  return new Error(
    `No usable LLM provider for ${task} tasks. ` +
      `"${requested}" failed: ${describeFailure(failure)} ` +
      `Set MUSE_${task.toUpperCase()}_LLM_PROVIDER to a provider whose API key ` +
      `is configured, or fix the missing credentials.`,
  );
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
 * Resolve both chat and research with Groq as the default primary.
 * Task-specific overrides remain available through
 * `MUSE_CHAT_LLM_PROVIDER` and `MUSE_RESEARCH_LLM_PROVIDER`, while
 * `MUSE_LLM_PROVIDER` pins both tasks. When the tasks select different
 * providers, one may serve as the other's fallback; non-Groq primaries use
 * Groq as their default alternate.
 *
 * If a selected primary cannot be constructed, resolve directly to its
 * configured alternate. When both are available, operational request failures
 * retry once through that alternate.
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
      "groq"
    )
      .trim()
      .toLowerCase() || "groq";

  const chooseAlternate = (
    requested: string,
    otherTaskProvider: string,
  ): string => {
    if (
      otherTaskProvider !== requested &&
      SUPPORTED_PROVIDERS.has(otherTaskProvider as MuseProviderName)
    ) {
      return otherTaskProvider;
    }
    return requested === "groq" ? "" : "groq";
  };

  const resolve = (
    task: MuseTaskName,
    requested: string,
    alternate: string,
  ): TaskProviderResolution => {
    try {
      const primary = instantiateProvider(requested, options.factories);
      let fallbackProvider: TextGenerationProvider | undefined;
      let fallbackUnavailableReason: string | undefined;
      if (alternate && alternate !== requested) {
        try {
          fallbackProvider = instantiateProvider(alternate, options.factories);
        } catch (fallbackError) {
          // The fallback is optional; keep the configured primary usable.
          fallbackUnavailableReason = classifyProviderFailure(fallbackError);
        }
      }
      return {
        provider: fallbackProvider
          ? new ProviderWithFallback(primary, fallbackProvider)
          : primary,
        primaryProvider: primary,
        requested,
        used: requested,
        ...(fallbackProvider ? { fallbackProvider } : {}),
        ...(fallbackUnavailableReason ? { fallbackUnavailableReason } : {}),
      };
    } catch (firstError) {
      if (!SUPPORTED_PROVIDERS.has(requested as MuseProviderName)) {
        throw noUsableProviderError(task, requested, firstError);
      }
      if (alternate && alternate !== requested) {
        try {
          const fallbackProvider = instantiateProvider(
            alternate,
            options.factories,
          );
          return {
            provider: fallbackProvider,
            primaryProvider: fallbackProvider,
            requested,
            used: alternate,
            fallbackReason: describeFailure(firstError),
          };
        } catch {
          // Both providers failed; report the original failure below.
        }
      }
      throw noUsableProviderError(task, requested, firstError);
    }
  };

  return {
    chat: resolve(
      "chat",
      chatRequested,
      chooseAlternate(chatRequested, researchRequested),
    ),
    research: resolve(
      "research",
      researchRequested,
      chooseAlternate(researchRequested, chatRequested),
    ),
  };
}

export function formatTaskProviderDiagnostics(
  providers: TaskAwareProviders,
): string[] {
  const lines = [
    `Muse chat LLM: ${providers.chat.primaryProvider.providerName} (model: ${providers.chat.primaryProvider.model}).`,
    `Muse research LLM: ${providers.research.primaryProvider.providerName} (model: ${providers.research.primaryProvider.model}).`,
  ];
  if (providers.chat.fallbackProvider) {
    lines.push(
      `Muse chat LLM fallback: ${providers.chat.fallbackProvider.providerName} (model: ${providers.chat.fallbackProvider.model}).`,
    );
  } else if (!providers.chat.fallbackUnavailableReason) {
    lines.push("Muse chat LLM fallback: none.");
  }
  if (providers.research.fallbackProvider) {
    lines.push(
      `Muse research LLM fallback: ${providers.research.fallbackProvider.providerName} (model: ${providers.research.fallbackProvider.model}).`,
    );
  } else if (!providers.research.fallbackUnavailableReason) {
    lines.push("Muse research LLM fallback: none.");
  }
  if (providers.chat.fallbackUnavailableReason) {
    lines.push(
      `Muse chat LLM fallback unavailable: ${providers.chat.fallbackUnavailableReason}.`,
    );
  }
  if (providers.research.fallbackUnavailableReason) {
    lines.push(
      `Muse research LLM fallback unavailable: ${providers.research.fallbackUnavailableReason}.`,
    );
  }
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
