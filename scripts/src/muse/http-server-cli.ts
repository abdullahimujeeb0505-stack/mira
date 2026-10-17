import { createMuseHttpServer } from "./http-server.js";

const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createMuseHttpServer();
server.listen(port, "127.0.0.1", () => {
  console.log(`Muse demo server listening on port ${port}.`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
