import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import {
  CloudflareWorkersAIProvider,
  type GeneratedImage,
} from "./cloudflare-workers-ai.js";
import type { ImageGenerator } from "./image-generation-command.js";
import { JsonMemoryRepository } from "./memory/json-memory-repository.js";
import { MemoryService } from "./memory/memory-service.js";
import { MuseAgent } from "./muse-agent.js";
import {
  PhotonBetaMessageHandler,
  readPhotonBetaConfiguration,
} from "./photon-beta.js";
import { sendPhotonBetaReply } from "./photon-beta-api.js";
import { PhotonCursorStore } from "./photon-cursor-store.js";
import {
  defaultPhotonCursorPath,
  PhotonBetaTransport,
} from "./photon-beta-transport.js";
import { PhotonMessageHandler } from "./photon-message-handler.js";
import { selectMusePhotonTransport } from "./photon-transport-selection.js";
import { createTextGenerationProvider } from "./provider-selection.js";

const DEFAULT_MEMORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/muse-photon-spaces",
);

async function main(): Promise<void> {
  const transport = selectMusePhotonTransport(
    process.env.MUSE_PHOTON_TRANSPORT,
  );
  if (transport === "spectrum") {
    await runSpectrum();
    return;
  }
  await runPhoton2();
}

async function runPhoton2(): Promise<void> {
  const configuration = readPhotonBetaConfiguration();
  const { projectId } = configuration;
  const provider = createTextGenerationProvider();
  const memoryDirectory =
    process.env.MUSE_PHOTON_MEMORY_DIR?.trim() || DEFAULT_MEMORY_DIRECTORY;
  await mkdir(memoryDirectory, { recursive: true });

  const handler = new PhotonBetaMessageHandler(
    projectId,
    (spaceKey) => createAgent(memoryDirectory, spaceKey, provider),
    (reply) => sendPhotonBetaReply(configuration, reply),
    undefined,
    createImageGenerator(),
  );
  const cursorPath =
    process.env.MUSE_PHOTON_CURSOR_PATH?.trim() ||
    defaultPhotonCursorPath(projectId);
  const transport = new PhotonBetaTransport(
    configuration,
    handler,
    new PhotonCursorStore(cursorPath),
  );

  let stopPromise: Promise<void> | undefined;
  const shutdown = () => {
    stopPromise ??= transport.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await transport.run();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await (stopPromise ?? transport.stop());
  }
}

async function runSpectrum(): Promise<void> {
  const projectId = process.env.SPECTRUM_PROJECT_ID?.trim();
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!projectId || !projectSecret) {
    throw new Error(
      "Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET before starting the Spectrum legacy transport.",
    );
  }

  const provider = createTextGenerationProvider();
  const memoryDirectory =
    process.env.MUSE_PHOTON_MEMORY_DIR?.trim() || DEFAULT_MEMORY_DIRECTORY;
  await mkdir(memoryDirectory, { recursive: true });

  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
  const handler = new PhotonMessageHandler(
    (spaceKey) => createAgent(memoryDirectory, spaceKey, provider),
    undefined,
    createImageGenerator(),
  );

  const shutdown = () => {
    void app.stop().catch(() => {
      console.error("Muse Spectrum shutdown did not complete cleanly.");
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

function createAgent(
  memoryDirectory: string,
  spaceKey: string,
  provider: ReturnType<typeof createTextGenerationProvider>,
): MuseAgent {
  const filename = createHash("sha256").update(spaceKey).digest("hex");
  return new MuseAgent(
    provider,
    new MemoryService(
      new JsonMemoryRepository(path.join(memoryDirectory, `${filename}.json`)),
    ),
  );
}

function createImageGenerator(): ImageGenerator {
  let provider: CloudflareWorkersAIProvider | undefined;
  const generationTimestamps: number[] = [];
  return async (prompt: string): Promise<GeneratedImage> => {
    provider ??= new CloudflareWorkersAIProvider();
    const now = Date.now();
    while (
      generationTimestamps.length > 0 &&
      now - generationTimestamps[0]! >= 60 * 60 * 1_000
    ) {
      generationTimestamps.shift();
    }
    if (generationTimestamps.length >= 10) {
      throw new Error(
        "The hourly iMessage image-generation limit was reached.",
      );
    }
    generationTimestamps.push(now);
    return provider.generateImage(prompt);
  };
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Muse Photon agent failed to start or stopped unexpectedly.",
  );
  process.exitCode = 1;
});
