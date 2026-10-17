import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface QualificationReviewItem {
  id: string;
  sourceId: string;
  updateId: string;
  title: string;
  description: string;
  sourceUrl: string | null;
  decision: "REVIEW";
  reasons: string[];
  evidence: string[];
  detectedAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
}

export class QualificationReviewRepository {
  constructor(private readonly filePath: string) {}

  async list(status?: QualificationReviewItem["status"]) {
    const items = await this.read();
    return status ? items.filter((item) => item.status === status) : items;
  }

  async add(item: QualificationReviewItem): Promise<void> {
    const items = await this.read();
    const existing = items.find(
      (entry) => entry.sourceId === item.sourceId &&
        entry.updateId === item.updateId,
    );

    if (existing) return;
    items.push(item);
    await this.write(items);
  }

  async syncPending(
    sourceId: string,
    current: QualificationReviewItem[],
  ): Promise<void> {
    const items = await this.read();
    const resolvedIds = new Set(
      items
        .filter((item) => item.sourceId === sourceId &&
          item.status !== "PENDING")
        .map((item) => item.id),
    );

    const retained = items.filter(
      (item) => item.sourceId !== sourceId || item.status !== "PENDING",
    );
    const refreshed = current.filter(
      (item) => item.sourceId === sourceId &&
        item.status === "PENDING" && !resolvedIds.has(item.id),
    );

    await this.write([...retained, ...refreshed]);
  }

  async resolve(
    id: string,
    status: "APPROVED" | "REJECTED",
  ): Promise<boolean> {
    const items = await this.read();
    const item = items.find(
      (entry) => entry.id === id && entry.status === "PENDING",
    );
    if (!item) return false;

    item.status = status;
    await this.write(items);
    return true;
  }

  private async read(): Promise<QualificationReviewItem[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("Qualification review file must contain an array.");
      }
      return parsed as QualificationReviewItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(items: QualificationReviewItem[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(items, null, 2), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temporaryPath, this.filePath);
  }
}
