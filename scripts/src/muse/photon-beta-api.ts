import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
  PhotonBetaConfiguration,
  PhotonBetaReply,
} from "./photon-beta.js";
import type { GeneratedImage } from "./cloudflare-workers-ai.js";

const PHOTON_API_ORIGIN = "https://api.photon.codes";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const MAX_ATTACHMENT_BYTES = 8 * 1_024 * 1_024;
const PHOTON_ATTACHMENT_ID = /^pho_att_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export class PhotonApiRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PhotonApiRequestError";
  }
}

export interface PhotonBetaApiOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type ResolvedApiOptions = {
  fetchImplementation: typeof fetch;
  timeoutMs: number;
  sleep: (milliseconds: number) => Promise<void>;
};
type PhotonOperation = "message" | "attachment upload";

export async function sendPhotonBetaReply(
  configuration: PhotonBetaConfiguration,
  reply: PhotonBetaReply,
  options: PhotonBetaApiOptions = {},
): Promise<void> {
  const resolvedOptions = resolveOptions(options);
  let content: Record<string, unknown>;
  if (reply.image) {
    const attachmentId = await uploadPhotonBetaAttachment(
      configuration,
      reply.messageId,
      reply.image,
      resolvedOptions,
    );
    content = {
      type: "group",
      parts: [
        { type: "text", format: "plain", text: reply.text },
        { type: "attachment", attachmentId },
      ],
    };
  } else {
    content = { type: "text", format: "plain", text: reply.text };
  }

  const url =
    `${PHOTON_API_ORIGIN}/v1/projects/` +
    `${encodeURIComponent(configuration.projectId)}/messages`;
  await requestWithRetries(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `muse-reply:${reply.messageId}`,
      },
      body: JSON.stringify({
        spaceId: reply.spaceId,
        senderId: reply.senderId,
        parentMessageId: reply.messageId,
        content,
      }),
    },
    [202],
    "message",
    resolvedOptions,
  );
}

async function uploadPhotonBetaAttachment(
  configuration: PhotonBetaConfiguration,
  messageId: string,
  image: GeneratedImage,
  options: ResolvedApiOptions,
): Promise<string> {
  const multipart = createMultipartRelatedImage(image);
  const url =
    `${PHOTON_API_ORIGIN}/v1/projects/` +
    `${encodeURIComponent(configuration.projectId)}/attachments`;
  const response = await requestWithRetries(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": multipart.contentType,
        "Content-Length": String(multipart.body.byteLength),
        "Idempotency-Key": `muse-image:${messageId}`,
      },
      body: multipart.body,
    },
    [200, 201],
    "attachment upload",
    options,
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PhotonApiRequestError(
      "Photon attachment upload returned an invalid response.",
      false,
    );
  }
  if (
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    !PHOTON_ATTACHMENT_ID.test(payload.id)
  ) {
    throw new PhotonApiRequestError(
      "Photon attachment upload returned an invalid attachment ID.",
      false,
    );
  }
  return payload.id;
}

function createMultipartRelatedImage(image: GeneratedImage): {
  contentType: string;
  body: Buffer;
} {
  if (
    !image.bytes.byteLength ||
    image.bytes.byteLength > MAX_ATTACHMENT_BYTES ||
    !["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)
  ) {
    throw new PhotonApiRequestError(
      "The generated image cannot be uploaded to Photon.",
      false,
    );
  }

  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[image.mimeType];
  const filename = `mira-generated-image.${extension}`;
  const metadata = JSON.stringify({
    contentType: image.mimeType,
    sizeBytes: image.bytes.byteLength,
    filename,
  });
  const boundary = `muse-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        "Content-Type: application/json; charset=utf-8\r\n" +
        "Content-ID: <metadata>\r\n\r\n" +
        `${metadata}\r\n`,
      "utf8",
    ),
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: ${image.mimeType}\r\n` +
        `Content-Disposition: attachment; filename="${filename}"\r\n` +
        "Content-Transfer-Encoding: binary\r\n" +
        "Content-ID: <file>\r\n\r\n",
      "utf8",
    ),
    image.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  return {
    contentType: `multipart/related; type="application/json"; boundary="${boundary}"`,
    body,
  };
}

async function requestWithRetries(
  url: string,
  request: Omit<RequestInit, "signal">,
  successStatuses: readonly number[],
  operation: PhotonOperation,
  options: ResolvedApiOptions,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchImplementation(url, {
        ...request,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        throw new PhotonApiRequestError(
          `Photon ${operation} request failed after retrying.`,
          true,
        );
      }
      await options.sleep(250 * 2 ** (attempt - 1));
      continue;
    }

    if (successStatuses.includes(response.status)) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      let delay = 250 * 2 ** (attempt - 1);
      if (response.status === 429) {
        const retryAfterMs = retryDelay(
          response.headers.get("Retry-After"),
          attempt,
        );
        if (retryAfterMs > 60_000) {
          throw new PhotonApiRequestError(
            "Photon rate limit requires a retry delay longer than one minute (HTTP 429).",
            false,
          );
        }
        delay = retryAfterMs;
      }
      await options.sleep(delay);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new PhotonApiRequestError(
        `Photon rejected the configured project credentials (HTTP ${response.status}).`,
        false,
      );
    }
    if (response.status === 429) {
      const retryAfterMs = retryDelay(
        response.headers.get("Retry-After"),
        attempt,
      );
      if (retryAfterMs > 60_000) {
        throw new PhotonApiRequestError(
          "Photon rate limit requires a retry delay longer than one minute (HTTP 429).",
          false,
        );
      }
      throw new PhotonApiRequestError(
        `Photon ${operation} rate limit reached after retrying (HTTP 429).`,
        true,
        retryAfterMs,
      );
    }
    if (retryable) {
      throw new PhotonApiRequestError(
        `Photon ${operation} request failed with HTTP ${response.status} after retrying.`,
        true,
      );
    }
    throw new PhotonApiRequestError(
      `Photon ${operation} request failed with HTTP ${response.status}.`,
      false,
    );
  }

  throw new PhotonApiRequestError(
    `Photon ${operation} request failed after retrying.`,
    true,
  );
}

function resolveOptions(options: PhotonBetaApiOptions): ResolvedApiOptions {
  return {
    fetchImplementation: options.fetchImplementation ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    sleep:
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function retryDelay(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return Math.max(timestamp - Date.now(), 0);
    }
  }
  return 250 * 2 ** (attempt - 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
