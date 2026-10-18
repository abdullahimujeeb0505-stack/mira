import { createMuseHttpServer } from "./http-server.js";
import {
  createTextGenerationProvider,
  formatProviderDiagnostic,
} from "./provider-selection.js";

const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Default to all interfaces so container previews (Replit workflow preview,
// e2b) can reach the server; set MUSE_BIND_HOST=127.0.0.1 to restrict to
// loopback, e.g. when running on a shared machine without the access-token gate.
const bindHost = process.env.MUSE_BIND_HOST?.trim() || "0.0.0.0";

const provider = createTextGenerationProvider();
console.info(formatProviderDiagnostic(provider));
const server = createMuseHttpServer({ providerFactory: () => provider });
server.listen(port, bindHost, () => {
  console.log(`Muse demo server listening on port ${port} (${bindHost}).`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
