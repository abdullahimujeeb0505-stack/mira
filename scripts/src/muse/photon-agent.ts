import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { JsonMemoryRepository } from "./memory/json-memory-repository.js";
import { MemoryService } from "./memory/memory-service.js";
import { MuseAgent } from "./muse-agent.js";
import { PhotonMessageHandler } from "./photon-message-handler.js";
import { createTextGenerationProvider } from "./provider-selection.js";

const DEFAULT_MEMORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/muse-photon-spaces",
);

async function main(): Promise<void> {
  const projectId = process.env.SPECTRUM_PROJECT_ID?.trim();
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!projectId || !projectSecret) {
    throw new Error(
      "Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET before starting Muse Photon.",
    );
  }

  const memoryDirectory =
    process.env.MUSE_PHOTON_MEMORY_DIR?.trim() || DEFAULT_MEMORY_DIRECTORY;
  await mkdir(memoryDirectory, { recursive: true });

  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
  const handler = new PhotonMessageHandler((spaceKey) => {
    const filename = createHash("sha256").update(spaceKey).digest("hex");
    return new MuseAgent(
      createTextGenerationProvider(),
      new MemoryService(
        new JsonMemoryRepository(path.join(memoryDirectory, `${filename}.json`)),
      ),
    );
  });

  const shutdown = () => {
    void app.stop().catch(() => {
      console.error("Muse Photon shutdown did not complete cleanly.");
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    for await (const [space, message] of app.messages) {
      try {
        await handler.handle(space, message);
      } catch {
        console.error("Muse could not deliver an iMessage reply.");
      }
    }
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await app.stop();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.message.startsWith("Set SPECTRUM_")
      ? error.message
      : "Muse Photon agent failed to start or stopped unexpectedly. Check the configuration and provider logs.",
  );
  process.exitCode = 1;
});
