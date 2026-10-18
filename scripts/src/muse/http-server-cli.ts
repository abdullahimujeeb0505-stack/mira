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
  void Promise.all([
    probeProviderConnection("chat", providers.chat.provider),
    probeProviderConnection("research", providers.research.provider),
  ]).then((lines) => {
    for (const line of lines) console.info(line);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
