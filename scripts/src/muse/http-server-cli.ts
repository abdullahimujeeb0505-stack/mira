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

const provider = createTextGenerationProvider();
console.info(formatProviderDiagnostic(provider));
const server = createMuseHttpServer({ providerFactory: () => provider });
server.listen(port, "127.0.0.1", () => {
  console.log(`Muse demo server listening on port ${port}.`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
