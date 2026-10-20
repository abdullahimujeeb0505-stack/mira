import { createMuseHttpServer } from "./http-server.js";
import {
  createTaskAwareProviders,
  formatTaskProviderDiagnostics,
  probeProviderConnection,
} from "./provider-selection.js";

const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Default to all interfaces so container previews (GitHub Codespaces port
// forwarding, the Replit workflow preview, e2b) can reach the server; set
// MUSE_BIND_HOST=127.0.0.1 to restrict to loopback on a shared machine.
const bindHost = process.env.MUSE_BIND_HOST?.trim() || "0.0.0.0";

const providers = createTaskAwareProviders();
for (const line of formatTaskProviderDiagnostics(providers)) {
  console.info(line);
}
console.info("Muse web search: DuckDuckGo HTML/Lite.");
const cloudflareAccountId =
  process.env.MUSE_CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
const cloudflareAiToken = process.env.MUSE_CLOUDFLARE_AI_TOKEN?.trim() ?? "";
if (!cloudflareAccountId || !cloudflareAiToken) {
  console.warn(
    "Muse image tools: disabled (set MUSE_CLOUDFLARE_ACCOUNT_ID and MUSE_CLOUDFLARE_AI_TOKEN).",
  );
} else if (!/^[a-f0-9]{32}$/i.test(cloudflareAccountId)) {
  console.warn(
    "Muse image tools: disabled (MUSE_CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID).",
  );
} else {
  console.info(
    "Muse image tools: Cloudflare Workers AI credentials found; live API access is not probed at startup.",
  );
}
const server = createMuseHttpServer({
  providerFactory: () => providers.chat.provider,
  researchProviderFactory: () => providers.research.provider,
});
server.listen(port, bindHost, () => {
  console.log(`Muse demo server listening on port ${port} (${bindHost}).`);
});

// Non-fatal startup probes: surface bad keys, quotas, and network problems
// now instead of on the user's first message. Set MUSE_LLM_STARTUP_PROBE=0
// to skip the probe requests.
if ((process.env.MUSE_LLM_STARTUP_PROBE ?? "1").trim() !== "0") {
  const probeTargets = new Map<
    string,
    { labels: string[]; provider: (typeof providers.chat)["primaryProvider"] }
  >();
  const addProbeTarget = (
    label: string,
    provider: (typeof providers.chat)["primaryProvider"] | undefined,
  ) => {
    if (!provider) return;
    const key = `${provider.providerName ?? "unknown"}:${provider.model ?? "unknown"}`;
    const existing = probeTargets.get(key);
    if (existing) {
      existing.labels.push(label);
    } else {
      probeTargets.set(key, { labels: [label], provider });
    }
  };

  for (const [task, resolution] of [
    ["chat", providers.chat],
    ["research", providers.research],
  ] as const) {
    addProbeTarget(`${task} primary`, resolution.primaryProvider);
    addProbeTarget(`${task} fallback`, resolution.fallbackProvider);
  }

  void Promise.all(
    [...probeTargets.values()].map(({ labels, provider }) =>
      probeProviderConnection(labels.join("/"), provider),
    ),
  ).then((lines) => {
    for (const line of lines) console.info(line);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
