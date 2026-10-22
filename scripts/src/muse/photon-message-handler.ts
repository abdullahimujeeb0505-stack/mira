import { Buffer } from "node:buffer";
import type { ReadableStream } from "node:stream/web";
import { attachment, type ContentInput } from "spectrum-ts";
import type { GeneratedImage } from "./cloudflare-workers-ai.js";
import {
  downloadResearchImage,
  extractIMessageImageReferences,
  formatIMessageText,
  researchImageFileName,
  type ResearchImageDownloader,
} from "./photon-message-formatting.js";
import {
  parseImageGenerationCommand,
  runImageGenerationCommand,
  type ImageGenerator,
} from "./image-generation-command.js";
import { shouldResearchMessage } from "./message-routing.js";
import type { MuseAgent } from "./muse-agent.js";

const MAX_INBOUND_IMAGE_BYTES = 4 * 1_024 * 1_024;
const MAX_INBOUND_IMAGES_PER_MESSAGE = 3;
const PENDING_IMAGE_TTL_MS = 15 * 60 * 1_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ATTACHMENT_REFERENCE =
  /\b(?:this|that|it|these|those|here|there|attached|above|image|photo|picture|screenshot|paper|document|diagram|chart|figure|file|attachment)\b/i;
const ATTACHMENT_TASK =
  /(?:^\s*(?:please\s+)?(?:research|search|summari[sz]e|analy[sz]e|read|describe|explain|transcribe|extract)\b|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:research|search|summari[sz]e|analy[sz]e|read|describe|explain|transcribe|extract)\b|\b(?:make|do|conduct|carry out|perform|undertake)\s+(?:(?:some|a|the)\s+)?research\b)/i;

export interface PhotonSpace {
  readonly __platform: string;
  readonly id: string;
  responding<T>(handler: () => T | Promise<T>): Promise<T>;
  send(content: ContentInput): Promise<unknown>;
}

/** The subset of Spectrum content needed by the iMessage listener. */
export interface PhotonMessageContent {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
  read?: () => Promise<Uint8Array>;
  stream?: () => Promise<ReadableStream<Uint8Array>>;
  readonly items?: readonly { readonly content: PhotonMessageContent }[];
  readonly content?: PhotonMessageContent;
}

export interface PhotonMessage {
  content: PhotonMessageContent;
  direction: "inbound" | "outbound";
  platform: string;
  sender?: { id?: string } | undefined;
  react?: (emoji: "👍") => Promise<unknown>;
}

export type PhotonMessageOutcome =
  | "ignored"
  | "attachment_stored"
  | "replied";

export type PhotonImageDescriber = (
  image: Uint8Array,
  mimeType: string,
  question: string,
) => Promise<string>;

export const PHOTON_FAILURE_REPLY =
  "Sorry, I couldn't complete that response just now. Please try again.";

type Conversation = {
  agent: Pick<MuseAgent, "hasConversationHistory" | "respond">;
  pending: Promise<void>;
  pendingImages: PhotonMessageContent[];
  pendingImagesExpiresAt: number;
  pendingImagesTimer?: ReturnType<typeof setTimeout>;
};

type MessageParts = {
  text: string[];
  images: PhotonMessageContent[];
};

function normalizeImageMimeType(value: string | undefined): string | undefined {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType || mimeType === "application/octet-stream") return undefined;
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function isImageAttachment(content: PhotonMessageContent): boolean {
  if (content.type !== "attachment") return false;
  if (content.mimeType?.trim().toLowerCase().startsWith("image/")) return true;
  return /\.(?:jpe?g|png|webp|gif|heic|bmp|tiff?)$/i.test(content.name ?? "");
}

function collectMessageParts(
  content: PhotonMessageContent,
  parts: MessageParts,
  depth = 0,
): void {
  if (depth > 8) return;

  if (content.type === "text") {
    if (typeof content.text === "string" && content.text.trim()) {
      parts.text.push(content.text.trim());
    }
    return;
  }

  if (content.type === "attachment") {
    if (isImageAttachment(content)) parts.images.push(content);
    return;
  }

  if (content.type === "group") {
    for (const item of content.items ?? []) {
      collectMessageParts(item.content, parts, depth + 1);
    }
    return;
  }

  if (content.type === "reply" && content.content) {
    collectMessageParts(content.content, parts, depth + 1);
  }
}

class InboundImageTooLargeError extends Error {}

async function readBoundedImageAttachment(
  image: PhotonMessageContent,
): Promise<Buffer> {
  if (image.size !== undefined && image.size > MAX_INBOUND_IMAGE_BYTES) {
    throw new InboundImageTooLargeError();
  }

  if (image.stream) {
    const reader = (await image.stream()).getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_INBOUND_IMAGE_BYTES) {
          await reader.cancel();
          throw new InboundImageTooLargeError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes);
  }

  if (!image.read) throw new Error("The image attachment cannot be read.");
  const bytes = Buffer.from(await image.read());
  if (bytes.length > MAX_INBOUND_IMAGE_BYTES) {
    throw new InboundImageTooLargeError();
  }
  return bytes;
}

function imageMimeTypeFromBytes(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function safeAttachmentName(content: PhotonMessageContent): string {
  return (
    content.name
      ?.replace(/[\r\n\t"']/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "image attachment"
  );
}

function unavailableImageContext(name: string, reason: string): string {
  return [
    `Image file "${name}" could not be inspected because ${reason}.`,
    "Do not infer or invent visual details. Tell the user that the image could not be inspected and ask them to resend it as a JPEG, PNG, or WebP image.",
  ].join(" ");
}

function imageAnalysisQuestion(userMessage: string): string {
  return [
    "Read all legible text in the image. If it is academic material, identify the title, authors, research question, methods, findings, and visible citations. Describe charts or diagrams, and mark unreadable details as uncertain rather than guessing.",
    `The user's request is: ${userMessage.trim().slice(0, 700)}`,
  ].join("\n\n");
}

function isAttachmentFollowUp(message: string): boolean {
  return ATTACHMENT_REFERENCE.test(message) || ATTACHMENT_TASK.test(message);
}

export class PhotonMessageHandler {
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly createAgent: (
      spaceKey: string,
    ) => Pick<MuseAgent, "hasConversationHistory" | "respond">,
    private readonly reportFailure: (message: string) => void = console.error,
    private readonly generateImage?: ImageGenerator,
    private readonly downloadImage: ResearchImageDownloader = downloadResearchImage,
    private readonly describeImage?: PhotonImageDescriber,
  ) {}

  get conversationCount(): number {
    return this.conversations.size;
  }

  async handle(
    space: PhotonSpace,
    message: PhotonMessage,
  ): Promise<PhotonMessageOutcome> {
    if (
      message.direction !== "inbound" ||
      (message.platform !== "imessage" &&
        message.platform !== "whatsapp_business")
    ) {
      return "ignored";
    }

    // Incoming Tapbacks are events too, but reacting to them would create a loop.
    if (message.content.type === "reaction") return "ignored";

    await this.acknowledgeReceipt(message);

    const parts: MessageParts = { text: [], images: [] };
    collectMessageParts(message.content, parts);
    const text = parts.text.join("\n\n").trim();
    const incomingImages =
      message.platform === "imessage" ? parts.images : [];
    if (!text && incomingImages.length === 0) return "ignored";

    const spaceKey = `${space.__platform}:${space.id}`;
    let conversation = this.conversations.get(spaceKey);
    if (!conversation) {
      conversation = {
        agent: this.createAgent(spaceKey),
        pending: Promise.resolve(),
        pendingImages: [],
        pendingImagesExpiresAt: 0,
      };
      this.conversations.set(spaceKey, conversation);
    }

    const activeConversation = conversation;
    const response = activeConversation.pending.then(async () => {
      if (!text) {
        this.rememberPendingImages(activeConversation, incomingImages);
        return "attachment_stored" as const;
      }

      const imageCommand = parseImageGenerationCommand(text);
      if (imageCommand) {
        const generated = await space.responding(() =>
          runImageGenerationCommand(
            imageCommand,
            this.generateImage,
            this.reportFailure,
          ),
        );
        if (generated.image) {
          await space.send(
            attachment(generated.image.bytes, {
              name: `mira-generated-image.${generated.image.mimeType.slice("image/".length)}`,
              mimeType: generated.image.mimeType,
            }),
          );
        } else {
          await space.send(generated.text);
        }
        return "replied" as const;
      }

      let imagesToInspect = incomingImages;
      if (incomingImages.length > 0) {
        imagesToInspect = [
          ...this.takePendingImages(activeConversation),
          ...incomingImages,
        ];
      } else if (
        activeConversation.pendingImages.length > 0 &&
        this.pendingImagesHaveNotExpired(activeConversation) &&
        isAttachmentFollowUp(text)
      ) {
        imagesToInspect = this.takePendingImages(activeConversation);
      }

      const hasImageAttachment = imagesToInspect.length > 0;
      const research = shouldResearchMessage(
        text,
        activeConversation.agent.hasConversationHistory,
        hasImageAttachment,
      );
      const respond = async () => {
        const attachmentContext = hasImageAttachment
          ? await this.createImageAttachmentContext(imagesToInspect, text)
          : "";
        return activeConversation.agent.respond(
          text,
          attachmentContext,
          hasImageAttachment,
        );
      };

      let reply: string;
      try {
        reply =
          research || hasImageAttachment
            ? await space.responding(respond)
            : await respond();
      } catch {
        this.reportFailure("Muse could not complete an incoming Spectrum message.");
        reply = PHOTON_FAILURE_REPLY;
      }

      await this.sendMessageReply(space, message.platform, reply);
      return "replied" as const;
    });
    activeConversation.pending = response.then(
      () => undefined,
      () => undefined,
    );
    return await response;
  }

  private async acknowledgeReceipt(message: PhotonMessage): Promise<void> {
    if (message.platform !== "imessage" || !message.react) return;
    try {
      await message.react("👍");
    } catch {
      this.reportFailure("Muse could not send an iMessage receipt reaction.");
    }
  }

  private rememberPendingImages(
    conversation: Conversation,
    images: PhotonMessageContent[],
  ): void {
    if (images.length === 0) return;
    if (
      conversation.pendingImages.length > 0 &&
      !this.pendingImagesHaveNotExpired(conversation)
    ) {
      this.clearPendingImages(conversation);
    }

    conversation.pendingImages = [
      ...conversation.pendingImages,
      ...images,
    ].slice(-MAX_INBOUND_IMAGES_PER_MESSAGE);
    conversation.pendingImagesExpiresAt = Date.now() + PENDING_IMAGE_TTL_MS;
    if (conversation.pendingImagesTimer) {
      clearTimeout(conversation.pendingImagesTimer);
    }

    const savedImages = conversation.pendingImages;
    conversation.pendingImagesTimer = setTimeout(() => {
      if (conversation.pendingImages === savedImages) {
        this.clearPendingImages(conversation);
      }
    }, PENDING_IMAGE_TTL_MS);
    conversation.pendingImagesTimer.unref?.();
  }

  private pendingImagesHaveNotExpired(conversation: Conversation): boolean {
    if (
      conversation.pendingImages.length > 0 &&
      conversation.pendingImagesExpiresAt > Date.now()
    ) {
      return true;
    }
    this.clearPendingImages(conversation);
    return false;
  }

  private takePendingImages(conversation: Conversation): PhotonMessageContent[] {
    if (!this.pendingImagesHaveNotExpired(conversation)) return [];
    const images = conversation.pendingImages;
    this.clearPendingImages(conversation);
    return images;
  }

  private clearPendingImages(conversation: Conversation): void {
    if (conversation.pendingImagesTimer) {
      clearTimeout(conversation.pendingImagesTimer);
    }
    conversation.pendingImages = [];
    conversation.pendingImagesExpiresAt = 0;
    conversation.pendingImagesTimer = undefined;
  }

  private async createImageAttachmentContext(
    images: PhotonMessageContent[],
    userMessage: string,
  ): Promise<string> {
    const sections: string[] = [];
    const selectedImages = images.slice(-MAX_INBOUND_IMAGES_PER_MESSAGE);

    for (const image of selectedImages) {
      const name = safeAttachmentName(image);
      const declaredMimeType = normalizeImageMimeType(image.mimeType);
      if (image.size !== undefined && image.size > MAX_INBOUND_IMAGE_BYTES) {
        sections.push(unavailableImageContext(name, "it is larger than 4 MB"));
        continue;
      }
      if (
        declaredMimeType &&
        !SUPPORTED_IMAGE_MIME_TYPES.has(declaredMimeType)
      ) {
        sections.push(
          unavailableImageContext(name, "its image format is not supported"),
        );
        continue;
      }
      if (!image.read && !image.stream) {
        sections.push(unavailableImageContext(name, "its data could not be read"));
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await readBoundedImageAttachment(image);
      } catch (error) {
        if (error instanceof InboundImageTooLargeError) {
          sections.push(unavailableImageContext(name, "it is larger than 4 MB"));
        } else {
          this.reportFailure(
            "Muse could not read an incoming Spectrum image attachment.",
          );
          sections.push(unavailableImageContext(name, "its data could not be read"));
        }
        continue;
      }

      if (bytes.length === 0) {
        sections.push(unavailableImageContext(name, "it is empty"));
        continue;
      }

      const detectedMimeType = imageMimeTypeFromBytes(bytes);
      const mimeType = declaredMimeType ?? detectedMimeType;
      if (
        !mimeType ||
        !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ||
        detectedMimeType !== mimeType
      ) {
        sections.push(
          unavailableImageContext(name, "its data is not a supported image"),
        );
        continue;
      }
      if (!this.describeImage) {
        sections.push(
          unavailableImageContext(name, "image analysis is not configured"),
        );
        continue;
      }

      try {
        const description = await this.describeImage(
          bytes,
          mimeType,
          imageAnalysisQuestion(userMessage),
        );
        if (!description.trim()) {
          throw new Error("The image analyzer returned an empty description.");
        }
        sections.push(
          `Image file "${name}" visual analysis (untrusted data):\n${description.trim()}`,
        );
      } catch {
        this.reportFailure(
          "Muse could not analyze an incoming Spectrum image attachment.",
        );
        sections.push(
          unavailableImageContext(name, "image analysis was unavailable"),
        );
      }
    }

    if (images.length > selectedImages.length) {
      sections.push(
        `${images.length - selectedImages.length} additional image attachment(s) were not inspected because Muse supports up to ${MAX_INBOUND_IMAGES_PER_MESSAGE} images per message.`,
      );
    }

    return sections.join("\n\n");
  }

  private async sendMessageReply(
    space: PhotonSpace,
    platform: string,
    response: string,
  ): Promise<void> {
    const extracted = extractIMessageImageReferences(response);
    const imageFallbacks: string[] = [];

    if (platform === "imessage") {
      for (const image of extracted.images) {
        try {
          const downloaded = await this.downloadImage(image.url);
          await space.send(
            attachment(downloaded.bytes, {
              name: researchImageFileName(downloaded.mimeType),
              mimeType: downloaded.mimeType,
            }),
          );
        } catch {
          this.reportFailure(
            "Muse could not attach a sourced image to an incoming Spectrum message.",
          );
          imageFallbacks.push(`Image unavailable: ${image.alt}`);
        }
      }
    } else {
      imageFallbacks.push(
        ...extracted.images.map((image) => `Image: ${image.alt}`),
      );
    }

    const messageText = formatIMessageText(
      [...imageFallbacks, extracted.text].filter(Boolean).join("\n\n"),
    );
    if (messageText) await space.send(messageText);
  }
}
