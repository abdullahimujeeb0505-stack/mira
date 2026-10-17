import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = fileURLToPath(new URL("../../", import.meta.url));
const workspaceDirectory = resolve(scriptsDirectory, "..");

export function inspectMuseReadiness(
  env = process.env,
  tsxAvailable = isTsxAvailable(),
) {
  const checks = [];
  const addCheck = (name, ready, guidance) => {
    checks.push({ name, ready, guidance });
  };

  addCheck(
    "SESSION_SECRET",
    typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.trim().length > 0,
    "Add a non-empty SESSION_SECRET in Replit Secrets.",
  );

  addCheck(
    "MUSE_CHAT_ACCESS_TOKEN",
    typeof env.MUSE_CHAT_ACCESS_TOKEN === "string" &&
      Buffer.byteLength(env.MUSE_CHAT_ACCESS_TOKEN, "utf8") >= 32,
    "Add a MUSE_CHAT_ACCESS_TOKEN of at least 32 bytes in Replit Secrets.",
  );

  const provider =
    (env.MUSE_LLM_PROVIDER ?? "").trim().toLowerCase() || "groq";
  if (!["groq", "openrouter", "agentrouter"].includes(provider)) {
    addCheck(
      "MUSE_LLM_PROVIDER",
      false,
      "Use groq, openrouter, or agentrouter for MUSE_LLM_PROVIDER.",
    );
  } else {
    const keyNames = {
      groq: ["GROQ_API_KEY", "GROK_API_CODING_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      agentrouter: ["AGENTROUTER_API_KEY"],
    }[provider];
    const configuredKey = keyNames.find(
      (name) => typeof env[name] === "string" && env[name].trim().length > 0,
    );
    const keyLabel =
      provider === "groq" && !configuredKey
        ? "GROQ_API_KEY or GROK_API_CODING_KEY"
        : configuredKey ?? keyNames[0];
    addCheck(
      keyLabel,
      Boolean(configuredKey),
      `Add ${keyLabel} in Replit Secrets for the selected provider.`,
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
  };
}

export function formatMuseReadiness(report) {
  const lines = ["Muse demo preflight:"];
  for (const check of report.checks) {
    lines.push(`${check.ready ? "PASS" : "BLOCKED"}: ${check.name}`);
    if (!check.ready) lines.push(`  ${check.guidance}`);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectMuseReadiness();
  process.stdout.write(`${formatMuseReadiness(report)}\n`);
  if (!report.ready) process.exitCode = 1;
}
