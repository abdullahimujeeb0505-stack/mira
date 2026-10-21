import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";
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
import {
  PhotonMessageHandler,
  type PhotonMessage,
  type PhotonSpace,
} from "./photon-message-handler.js";
import { selectMusePhotonTransport } from "./photon-transport-selection.js";
import { selectMuseSpectrumPlatform } from "./photon-spectrum-platform.js";
import { createTextGenerationProvider } from "./provider-selection.js";

const DEFAULT_MEMORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/muse-photon-spaces",
);

type SpectrumAppLike = {
  messages: AsyncIterable<[PhotonSpace, PhotonMessage]>;
  stop(): Promise<void>;
};

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
  const spectrumPlatform = selectMuseSpectrumPlatform(
    process.env.MUSE_SPECTRUM_PLATFORM,
  );
  const projectId = process.env.SPECTRUM_PROJECT_ID?.trim();
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!projectId || !projectSecret) {
    throw new Error(
      "Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET before starting the Spectrum transport.",
    );
  }

  const provider = createTextGenerationProvider();
  const memoryDirectory =
    process.env.MUSE_PHOTON_MEMORY_DIR?.trim() || DEFAULT_MEMORY_DIRECTORY;
  await mkdir(memoryDirectory, { recursive: true });
  let app: SpectrumAppLike;
  try {
    app =
      spectrumPlatform === "imessage"
        ? await Spectrum({
            projectId,
            projectSecret,
            providers: [imessage.config()],
          })
        : await Spectrum({
            projectId,
            projectSecret,
            providers: [whatsappBusiness.config()],
          });
  } catch (error) {
    throw new Error(
      `Spectrum connection failed: ${formatSpectrumError(error, projectSecret)}`,
    );
  }
  console.info(`Spectrum platform: ${spectrumPlatform}`);
  console.info("Spectrum connected");

  const handler = new PhotonMessageHandler(
    (spaceKey) => createAgent(memoryDirectory, spaceKey, provider),
    undefined,
    createImageGenerator(),
  );

  const shutdown = () => {
    void app.stop().catch(() => {
      console.error("Spectrum shutdown did not complete cleanly.");
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    for await (const [space, message] of app.messages) {
      if (message.direction !== "inbound") continue;
      const handle = formatSpectrumSenderHandle(
        message.sender?.id,
        projectSecret,
      );
      console.info(`received message from ${handle}`);
      try {
        const replied = await handler.handle(space, message);
        if (replied) {
          console.info(`Spectrum reply sent to ${handle}`);
        } else {
          console.info(
            `Spectrum reply skipped for ${handle}: unsupported message`,
          );
        }
      } catch (error) {
        const errorMessage = formatSpectrumError(error, projectSecret);
        console.error(`Spectrum reply failed for ${handle}: ${errorMessage}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Spectrum listener failed: ${formatSpectrumError(error, projectSecret)}`,
    );
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    try {
      await app.stop();
    } catch (error) {
      throw new Error(
        `Spectrum shutdown failed: ${formatSpectrumError(error, projectSecret)}`,
      );
    }
  }
}

function formatSpectrumSenderHandle(
  senderId: string | undefined,
  projectSecret: string,
): string {
  const safeSenderId = senderId?.split(projectSecret).join("[REDACTED]");
  const handle = safeSenderId
    ?.replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 120);
  return handle || "unknown";
}

function formatSpectrumError(error: unknown, projectSecret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message
    .split(projectSecret)
    .join("[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return (safeMessage || "Unknown error").slice(0, 500);
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
