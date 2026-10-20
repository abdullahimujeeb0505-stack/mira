import assert from "node:assert/strict";
import test from "node:test";
import { formatMuseReadiness, inspectMuseReadiness } from "./preflight.mjs";

const validEnv = {
  SESSION_SECRET: "configured-session-secret",
  GROK_API_CODING_KEY: "configured-provider-key",
  MUSE_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  MUSE_CLOUDFLARE_AI_TOKEN: "configured-cloudflare-token",
};

test("reports Groq readiness without exposing configured values", () => {
  const report = inspectMuseReadiness(validEnv, true);
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(output, /PASS: GROK_API_CODING_KEY/);
  assert.doesNotMatch(output, /MUSE_CHAT_ACCESS_TOKEN/);
  assert.doesNotMatch(
    output,
    /configured-session-secret|configured-provider-key/,
  );
});

test("Cloudflare image secrets are optional and missing values only warn", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_CLOUDFLARE_ACCOUNT_ID: "",
      MUSE_CLOUDFLARE_AI_TOKEN: "",
    },
    true,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(output, /WARNING: Image generation and image attachment understanding are optional/);
  assert.doesNotMatch(output, /configured-cloudflare-token/);
});

test("defaults chat and research to Groq with no secondary provider", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      GEMINI_API_KEY: "obsolete-gemini-key",
    },
    true,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (groq)" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM provider (groq)" && ready,
    ),
  );
  assert.ok(!report.checks.some(({ name }) => name === "GEMINI_API_KEY"));
  assert.match(output, /chat task has no secondary provider configured/);
  assert.match(output, /research task has no secondary provider configured/);
});

test("distinct task providers are available as each other's fallback", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_CHAT_LLM_PROVIDER: "agentrouter",
      MUSE_RESEARCH_LLM_PROVIDER: "openrouter",
      AGENTROUTER_API_KEY: "configured-agentrouter-key",
      OPENROUTER_API_KEY: "configured-openrouter-key",
      OPENROUTER_MODEL: "test/model",
    },
    true,
  );

  assert.equal(report.ready, true);
  for (const name of [
    "chat LLM provider (agentrouter)",
    "chat LLM fallback (openrouter)",
    "research LLM provider (openrouter)",
    "research LLM fallback (agentrouter)",
  ]) {
    assert.ok(report.checks.some((check) => check.name === name && check.ready), name);
  }
  assert.deepEqual(report.warnings, []);
});

test("uses Groq at startup when an OpenRouter primary cannot be constructed", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "configured-openrouter-key",
      OPENROUTER_MODEL: "",
    },
    true,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, true);
  assert.match(
    output,
    /chat task will use groq because the configured primary openrouter is unavailable/,
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (groq)" && ready,
    ),
  );
});

test("a leftover Gemini key cannot substitute for missing Groq credentials", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      GROQ_API_KEY: "",
      GROK_API_CODING_KEY: "",
      GEMINI_API_KEY: "obsolete-gemini-key",
    },
    true,
  );

  assert.equal(report.ready, false);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "chat LLM provider (groq)" && !ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "research LLM provider (groq)" && !ready,
    ),
  );
  assert.ok(!report.checks.some(({ name }) => name === "GEMINI_API_KEY"));
});

test("prefers the canonical Groq credential when both variables are available", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      GROQ_API_KEY: "canonical-provider-key",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(({ name, ready }) => name === "GROQ_API_KEY" && ready),
  );
});

test("selects AgentRouter without requiring Groq credentials", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "agentrouter",
      AGENTROUTER_API_KEY: "configured-agentrouter-key",
      GROK_API_CODING_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "AGENTROUTER_API_KEY" && ready,
    ),
  );
  assert.ok(!report.checks.some(({ name }) => name === "GROK_API_CODING_KEY"));
});

test("blocks an OpenRouter provider without its required model or usable Groq alternate", () => {
  const report = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "configured-openrouter-key",
      OPENROUTER_MODEL: "",
      GROQ_API_KEY: "",
      GROK_API_CODING_KEY: "",
    },
    true,
  );

  assert.equal(report.ready, false);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "OPENROUTER_API_KEY" && ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "OPENROUTER_MODEL" && !ready,
    ),
  );
  assert.ok(
    report.checks.some(
      ({ name, ready }) =>
        name === "GROQ_API_KEY or GROK_API_CODING_KEY" && !ready,
    ),
  );
});

test("uses Groq when the provider setting is blank", () => {
  const report = inspectMuseReadiness(
    { ...validEnv, MUSE_LLM_PROVIDER: "  " },
    true,
  );

  assert.equal(report.ready, true);
  assert.ok(
    report.checks.some(
      ({ name, ready }) => name === "GROK_API_CODING_KEY" && ready,
    ),
  );
  assert.ok(!report.checks.some(({ name }) => name === "MUSE_LLM_PROVIDER"));
});

test("reports missing secrets and unavailable tsx without printing values", () => {
  const report = inspectMuseReadiness(
    {
      SESSION_SECRET: "",
      GROK_API_CODING_KEY: "",
    },
    false,
  );
  const output = formatMuseReadiness(report);

  assert.equal(report.ready, false);
  assert.match(output, /BLOCKED: SESSION_SECRET/);
  assert.match(output, /BLOCKED: GROQ_API_KEY or GROK_API_CODING_KEY/);
  assert.match(output, /BLOCKED: tsx/);
});

test("rejects removed Gemini and other unsupported provider names", () => {
  const removedProviderReport = inspectMuseReadiness(
    { ...validEnv, MUSE_LLM_PROVIDER: "gemini" },
    true,
  );
  const arbitraryProviderReport = inspectMuseReadiness(
    { ...validEnv, MUSE_LLM_PROVIDER: "private-provider-value" },
    true,
  );
  const taskOverrideReport = inspectMuseReadiness(
    {
      ...validEnv,
      MUSE_CHAT_LLM_PROVIDER: "agentrouter",
      MUSE_RESEARCH_LLM_PROVIDER: "private-provider-value",
      AGENTROUTER_API_KEY: "configured-agentrouter-key",
    },
    true,
  );
  const output = [removedProviderReport, arbitraryProviderReport, taskOverrideReport]
    .map(formatMuseReadiness)
    .join("\n");

  assert.equal(removedProviderReport.ready, false);
  assert.equal(arbitraryProviderReport.ready, false);
  assert.equal(taskOverrideReport.ready, false);
  assert.match(output, /BLOCKED: MUSE_LLM_PROVIDER/);
  assert.match(output, /BLOCKED: MUSE_RESEARCH_LLM_PROVIDER/);
  assert.doesNotMatch(output, /private-provider-value/);
});
