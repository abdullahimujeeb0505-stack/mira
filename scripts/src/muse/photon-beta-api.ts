import type {
  PhotonBetaConfiguration,
  PhotonBetaReply,
} from "./photon-beta.js";

const PHOTON_API_ORIGIN = "https://api.photon.codes";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

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

export async function sendPhotonBetaReply(
  configuration: PhotonBetaConfiguration,
  reply: PhotonBetaReply,
  options: PhotonBetaApiOptions = {},
): Promise<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const url =
    `${PHOTON_API_ORIGIN}/v1/projects/` +
    `${encodeURIComponent(configuration.projectId)}/messages`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImplementation(url, {
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
          content: {
            type: "text",
            format: "plain",
            text: reply.text,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        throw new PhotonApiRequestError(
          "Photon message request failed after retrying.",
          true,
        );
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 202) return;
    const retryable =
      response.status === 429 || response.status >= 500;
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
      await sleep(delay);
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
        "Photon message rate limit reached after retrying (HTTP 429).",
        true,
        retryAfterMs,
      );
    }
    if (retryable) {
      throw new PhotonApiRequestError(
        `Photon message request failed with HTTP ${response.status} after retrying.`,
        true,
      );
    }
    throw new PhotonApiRequestError(
      `Photon message request failed with HTTP ${response.status}.`,
      false,
    );
  }
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
