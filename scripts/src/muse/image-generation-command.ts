import type { GeneratedImage } from "./cloudflare-workers-ai.js";

export const IMAGE_GENERATION_MAX_PROMPT_LENGTH = 1_000;
export const IMAGE_GENERATION_SUCCESS_REPLY = "Here is the generated image.";
export const IMAGE_GENERATION_UNAVAILABLE_REPLY =
  "Sorry, image generation is unavailable right now. Please try again later.";
export const IMAGE_GENERATION_USAGE_REPLY =
  "To generate an image, send “generate image: <description>” (up to 1,000 characters).";
export const IMAGE_GENERATION_PROMPT_TOO_LONG_REPLY =
  "That image prompt is too long. Keep it to 1,000 characters or fewer.";

export type ImageGenerationCommand =
  | { kind: "generate"; prompt: string }
  | { kind: "missing-prompt" }
  | { kind: "prompt-too-long" };

export interface ImageGenerationResponse {
  text: string;
  image?: GeneratedImage;
}

export type ImageGenerator = (prompt: string) => Promise<GeneratedImage>;

const IMAGE_GENERATION_PREFIX =
  /^(?:\/(?:imagine|image|generate-image)\b|(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:generate|create|make|draw|paint|illustrate)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|illustration|artwork|visual)\b)([\s\S]*)$/i;

/** Match only an explicit, leading image command; ordinary chat stays on its
 *  normal conversational path. */
export function parseImageGenerationCommand(
  text: string,
): ImageGenerationCommand | undefined {
  const match = IMAGE_GENERATION_PREFIX.exec(text.trim());
  if (!match) return undefined;

  const prompt = (match[1] ?? "")
    .replace(/^\s*(?:[:\-–—]\s*)?/u, "")
    .replace(/^of(?=\s|$|:)\s*:?\s*/i, "")
    .trim();
  if (!prompt) return { kind: "missing-prompt" };
  if (prompt.length > IMAGE_GENERATION_MAX_PROMPT_LENGTH) {
    return { kind: "prompt-too-long" };
  }
  return { kind: "generate", prompt };
}

export async function runImageGenerationCommand(
  command: ImageGenerationCommand,
  generateImage: ImageGenerator | undefined,
  reportFailure: (message: string) => void = console.error,
): Promise<ImageGenerationResponse> {
  if (command.kind === "missing-prompt") {
    return { text: IMAGE_GENERATION_USAGE_REPLY };
  }
  if (command.kind === "prompt-too-long") {
    return { text: IMAGE_GENERATION_PROMPT_TOO_LONG_REPLY };
  }
  if (!generateImage) {
    reportFailure(
      "Muse image generation is unavailable because Cloudflare Workers AI is not configured.",
    );
    return { text: IMAGE_GENERATION_UNAVAILABLE_REPLY };
  }

  try {
    return {
      text: IMAGE_GENERATION_SUCCESS_REPLY,
      image: await generateImage(command.prompt),
    };
  } catch {
    reportFailure("Muse could not generate an image for an incoming iMessage.");
    return { text: IMAGE_GENERATION_UNAVAILABLE_REPLY };
  }
}
