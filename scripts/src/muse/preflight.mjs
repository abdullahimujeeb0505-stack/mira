import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = fileURLToPath(new URL("../../", import.meta.url));
const workspaceDirectory = resolve(scriptsDirectory, "..");
const PROVIDER_KEYS = {
  groq: ["GROQ_API_KEY", "GROK_API_CODING_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  agentrouter: ["AGENTROUTER_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
};
const VALID_PROVIDERS = new Set(Object.keys(PROVIDER_KEYS));

function selectedProvider(env, task) {
  const taskOverride = env[`MUSE_${task.toUpperCase()}_LLM_PROVIDER`];
  const globalOverride = env.MUSE_LLM_PROVIDER;
  const fallback = "groq";
  return (
    (taskOverride ?? globalOverride ?? fallback).trim().toLowerCase() ||
    fallback
  );
}

function alternateProvider(env, task) {
  const requested = selectedProvider(env, task);
  const otherTask = task === "chat" ? "research" : "chat";
  const otherRequested = selectedProvider(env, otherTask);
  if (requested === "groq") return "gemini";
  if (requested === "gemini") return "groq";
  if (otherRequested !== requested && VALID_PROVIDERS.has(otherRequested)) {
    return otherRequested;
  }
  return "groq";
}

function providerConfiguration(env, provider) {
  if (!VALID_PROVIDERS.has(provider)) return { configured: false };
  const keyNames = PROVIDER_KEYS[provider];
  const keyName = keyNames.find(
    (name) => typeof env[name] === "string" && env[name].trim().length > 0,
  );
  if (!keyName) return { configured: false, missingKey: keyNames[0] };
  if (provider === "openrouter" && !(env.OPENROUTER_MODEL ?? "").trim()) {
    return { configured: false, keyName, missingModel: true };
  }
  return { configured: true, keyName };
}

function resolveTaskProvider(env, task, requested, alternate) {
  if (!VALID_PROVIDERS.has(requested)) {
    return {
      ready: false,
      requested,
      used: null,
      fallbackProvider: alternate,
      fallbackConfigured: false,
    };
  }

  const primary = providerConfiguration(env, requested);
  if (primary.configured) {
    const fallback = providerConfiguration(env, alternate);
    return {
      ready: true,
      requested,
      used: requested,
      fallbackProvider: alternate,
      fallbackConfigured: fallback.configured,
    };
  }

  if (alternate !== requested) {
    const fallback = providerConfiguration(env, alternate);
    if (fallback.configured) {
      return {
        ready: true,
        requested,
        used: alternate,
        warning: `The ${task} task will use ${alternate} because the configured primary ${VALID_PROVIDERS.has(requested) ? requested : "provider"} is unavailable; configure the preferred provider to restore the primary route.`,
      };
    }
  }

  return {
    ready: false,
    requested,
    used: null,
    fallbackProvider: alternate,
    fallbackConfigured: false,
  };
}

export function inspectMuseReadiness(
  env = process.env,
  tsxAvailable = isTsxAvailable(),
) {
  const checks = [];
  const checkByName = new Map();
  const warnings = [];
  const addCheck = (name, ready, guidance) => {
    const existing = checkByName.get(name);
    if (existing) {
      existing.ready = existing.ready && ready;
      return;
    }
    const check = { name, ready, guidance };
    checkByName.set(name, check);
    checks.push(check);
  };

  addCheck(
    "SESSION_SECRET",
    typeof env.SESSION_SECRET === "string" &&
      env.SESSION_SECRET.trim().length > 0,
    "Add a non-empty SESSION_SECRET to GitHub Codespaces Secrets or the runtime environment.",
  );

  const requested = {
    chat: selectedProvider(env, "chat"),
    research: selectedProvider(env, "research"),
  };
  const alternates = {
    chat: alternateProvider(env, "chat"),
    research: alternateProvider(env, "research"),
  };
  const resolved = {
    chat: resolveTaskProvider(env, "chat", requested.chat, alternates.chat),
    research: resolveTaskProvider(
      env,
      "research",
      requested.research,
      alternates.research,
    ),
  };
  if (
    (env.MUSE_GEMINI_SEARCH ?? "1").trim() !== "0" &&
    !(env.GEMINI_API_KEY ?? "").trim()
  ) {
    warnings.push(
      "Gemini Google Search grounding is unavailable without GEMINI_API_KEY; research will rely on DuckDuckGo HTML/Lite search.",
    );
  }

  const providersToCheck = new Set();
  for (const task of ["chat", "research"]) {
    const result = resolved[task];
    if (result.ready) {
      providersToCheck.add(result.used);
      addCheck(
        `${task} LLM provider (${result.used})`,
        true,
        `Configure a usable provider for the ${task} task.`,
      );
      if (result.fallbackProvider && result.fallbackConfigured) {
        providersToCheck.add(result.fallbackProvider);
        addCheck(
          `${task} LLM fallback (${result.fallbackProvider})`,
          true,
          `Configure a usable fallback for the ${task} task.`,
        );
      } else if (result.fallbackProvider) {
        warnings.push(
          `The ${task} task has no configured ${result.fallbackProvider} runtime fallback; ${result.used} remains the primary provider without failover.`,
        );
      }
      if (result.warning) warnings.push(result.warning);
      continue;
    }

    providersToCheck.add(result.requested);
    if (result.fallbackProvider) providersToCheck.add(result.fallbackProvider);
    addCheck(
      VALID_PROVIDERS.has(result.requested)
        ? `${task} LLM provider (${result.requested})`
        : `${task} LLM provider configuration`,
      false,
      `Configure a valid ${task} provider and its credential, or configure the other task provider as a fallback.`,
    );
  }

  for (const provider of providersToCheck) {
    if (!VALID_PROVIDERS.has(provider)) {
      const setting = env.MUSE_CHAT_LLM_PROVIDER?.trim()
        ? "MUSE_CHAT_LLM_PROVIDER"
        : env.MUSE_RESEARCH_LLM_PROVIDER?.trim()
          ? "MUSE_RESEARCH_LLM_PROVIDER"
          : "MUSE_LLM_PROVIDER";
      addCheck(
        setting,
        false,
        "Use groq, openrouter, agentrouter, or gemini for provider selection.",
      );
      continue;
    }

    const keyNames = PROVIDER_KEYS[provider];
    const configuredKey = keyNames.find(
      (name) => typeof env[name] === "string" && env[name].trim().length > 0,
    );
    const keyLabel =
      provider === "groq" && !configuredKey
        ? "GROQ_API_KEY or GROK_API_CODING_KEY"
        : (configuredKey ?? keyNames[0]);
    addCheck(
      keyLabel,
      Boolean(configuredKey),
      `Add ${keyLabel} to GitHub Codespaces Secrets or the runtime environment for ${provider}.`,
    );
    if (provider === "openrouter") {
      addCheck(
        "OPENROUTER_MODEL",
        typeof env.OPENROUTER_MODEL === "string" &&
          env.OPENROUTER_MODEL.trim().length > 0,
        "Set OPENROUTER_MODEL to an available model after reviewing its pricing and limits.",
      );
    }
  }

  addCheck(
    "tsx",
    tsxAvailable,
    "Restore workspace dependencies from pnpm-lock.yaml before starting Muse.",
  );

  return {
    ready: checks.every(({ ready }) => ready),
    checks,
    warnings,
  };
}

export function formatMuseReadiness(report) {
  const lines = ["Muse demo preflight:"];
  for (const check of report.checks) {
    lines.push(`${check.ready ? "PASS" : "BLOCKED"}: ${check.name}`);
    if (!check.ready) lines.push(`  ${check.guidance}`);
  }
  for (const warning of report.warnings ?? []) {
    lines.push(`WARNING: ${warning}`);
  }
  lines.push(
    report.ready
      ? "Ready to start the existing Muse Chat Preview workflow."
      : "Do not start the preview until all blocked checks are resolved.",
  );
  return lines.join("\n");
}

function isTsxAvailable() {
  return [
    resolve(scriptsDirectory, "node_modules/.bin/tsx"),
    resolve(workspaceDirectory, "node_modules/.bin/tsx"),
  ].some(existsSync);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = inspectMuseReadiness();
  process.stdout.write(`${formatMuseReadiness(report)}\n`);
  if (!report.ready) process.exitCode = 1;
}
