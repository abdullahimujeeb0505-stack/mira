
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TextGenerationProvider } from "../llm-provider.js";

export type DraftStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "PUBLISHING"
  | "PUBLISH_UNCERTAIN"
  | "PUBLISHED";

export interface QuotePostDraft {
  id: string;
  sourceUrl: string;
  sourceText: string;
  draftText: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  publishedPostId?: string;
  publishedPostUrl?: string;
  publishError?: string;
}

export class QuotePostDraftService {
  private mutationQueue: Promise<void> = Promise.resolve();

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  constructor(
    private readonly provider: TextGenerationProvider,
    private readonly filePath =
      process.env.MUSE_DRAFTS_PATH ??
      "scripts/data/muse-quote-drafts.json",
  ) {}

  async create(
    sourceUrl: string,
    sourceText: string,
  ): Promise<QuotePostDraft> {
    return this.withMutation(() => this.createInternal(sourceUrl, sourceText));
  }

  async updateStatus(
    id: string,
    status: "APPROVED" | "REJECTED",
  ): Promise<QuotePostDraft> {
    return this.withMutation(() => this.updateStatusInternal(id, status));
  }

  async beginPublishing(id: string): Promise<QuotePostDraft> {
    return this.withMutation(() => this.beginPublishingInternal(id));
  }

  async markPublished(
    id: string,
    postId: string,
  ): Promise<QuotePostDraft> {
    return this.withMutation(() => this.markPublishedInternal(id, postId));
  }

  async markPublishUncertain(
    id: string,
    reason: string,
  ): Promise<QuotePostDraft> {
    return this.withMutation(() => this.markPublishUncertainInternal(id, reason));
  }

  private async createInternal(
    sourceUrl: string,
    sourceText: string,
  ): Promise<QuotePostDraft> {
    const url = new URL(sourceUrl);

    if (url.protocol !== "https:" || !url.hostname) {
      throw new Error("Source URL must be a valid HTTPS URL.");
    }

    if (!sourceText.trim()) {
      throw new Error("Original post text is required.");
    }

    if (sourceText.length > 12000) {
      throw new Error(
        "Original post text exceeds the 12,000-character limit.",
      );
    }

    const draftText = (
      await this.provider.generateText({
        systemPrompt: [
          "You are Muse, a personal Web3 research and writing assistant.",
          "Draft one concise X quote-post in the user's natural, direct style.",
          "Be specific to the original post; avoid generic praise and hype.",
          "Never invent personal experience, partnerships, results, or facts.",
          "Do not claim the user tested or used something unless stated.",
          "Return only the proposed post text, with no explanation.",
          "This is a draft for human review. Never publish it.",
        ].join(" "),
        conversation: [
          {
            role: "user",
            content:
              `Original post URL: ${url.toString()}\n\n` +
              `Original post text:\n${sourceText.trim()}`,
          },
        ],
      })
    ).trim();

    if (!draftText) {
      throw new Error("The model returned an empty draft.");
    }

    if (draftText.length > 280) {
      throw new Error(
        `Draft is ${draftText.length} characters; ` +
          "revise it to fit within 280 characters.",
      );
    }

    const now = new Date().toISOString();

    const draft: QuotePostDraft = {
      id: randomUUID(),
      sourceUrl: url.toString(),
      sourceText: sourceText.trim(),
      draftText,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };

    const drafts = await this.readAll();
    drafts.push(draft);
    await this.writeAll(drafts);

    return draft;
  }

  async list(): Promise<QuotePostDraft[]> {
    return this.readAll();
  }

  private async updateStatusInternal(
    id: string,
    status: "APPROVED" | "REJECTED",
  ): Promise<QuotePostDraft> {
    const drafts = await this.readAll();
    const index = drafts.findIndex((draft) => draft.id === id);

    if (index < 0) {
      throw new Error(`Draft "${id}" was not found.`);
    }

    const current = drafts[index]!;

    if (current.status !== "PENDING") {
      throw new Error(`Draft is already ${current.status}.`);
    }

    const updated = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    };

    drafts[index] = updated;
    await this.writeAll(drafts);

    return updated;
  }

  private async beginPublishingInternal(id: string): Promise<QuotePostDraft> {
    const drafts = await this.readAll();
    const index = drafts.findIndex((draft) => draft.id === id);

    if (index < 0) {
      throw new Error(`Draft "${id}" was not found.`);
    }

    const current = drafts[index]!;
    if (current.status !== "APPROVED") {
      throw new Error(
        `Only an APPROVED draft can begin publishing; current status is ${current.status}.`,
      );
    }

    const updated: QuotePostDraft = {
      ...current,
      status: "PUBLISHING",
      publishError: undefined,
      updatedAt: new Date().toISOString(),
    };

    drafts[index] = updated;
    await this.writeAll(drafts);
    return updated;
  }

  private async markPublishedInternal(
    id: string,
    postId: string,
  ): Promise<QuotePostDraft> {
    if (!postId.trim()) {
      throw new Error("An X post ID is required to confirm publication.");
    }

    const drafts = await this.readAll();
    const index = drafts.findIndex((draft) => draft.id === id);

    if (index < 0) {
      throw new Error(`Draft "${id}" was not found.`);
    }

    const current = drafts[index]!;
    if (current.status !== "PUBLISHING") {
      throw new Error(
        `Only a PUBLISHING draft can be marked published; current status is ${current.status}.`,
      );
    }

    const updated: QuotePostDraft = {
      ...current,
      status: "PUBLISHED",
      publishedPostId: postId,
      publishedPostUrl: `https://x.com/i/web/status/${postId}`,
      publishError: undefined,
      updatedAt: new Date().toISOString(),
    };

    drafts[index] = updated;
    await this.writeAll(drafts);
    return updated;
  }

  private async markPublishUncertainInternal(
    id: string,
    reason: string,
  ): Promise<QuotePostDraft> {
    const drafts = await this.readAll();
    const index = drafts.findIndex((draft) => draft.id === id);

    if (index < 0) {
      throw new Error(`Draft "${id}" was not found.`);
    }

    const current = drafts[index]!;
    if (current.status !== "PUBLISHING") {
      throw new Error(
        `Only a PUBLISHING draft can be marked uncertain; current status is ${current.status}.`,
      );
    }

    const updated: QuotePostDraft = {
      ...current,
      status: "PUBLISH_UNCERTAIN",
      publishError: reason.trim().slice(0, 500) || "Unknown publishing outcome.",
      updatedAt: new Date().toISOString(),
    };

    drafts[index] = updated;
    await this.writeAll(drafts);
    return updated;
  }

  private async readAll(): Promise<QuotePostDraft[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        throw new Error("Draft store must contain a JSON array.");
      }

      return parsed as QuotePostDraft[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private async writeAll(
    drafts: QuotePostDraft[],
  ): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const temporary = `${this.filePath}.tmp`;

    await writeFile(
      temporary,
      `${JSON.stringify(drafts, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    await rename(temporary, this.filePath);
  }
}
