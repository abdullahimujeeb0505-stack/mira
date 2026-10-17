import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PhotonCursorState {
  cursor: number;
  eventIds: string[];
}

const EMPTY_STATE: PhotonCursorState = { cursor: 0, eventIds: [] };
const MAX_EVENT_IDS = 10_000;

export class PhotonCursorStore {
  constructor(private readonly filename: string) {}

  async load(): Promise<PhotonCursorState> {
    let content: string;
    try {
      content = await readFile(this.filename, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ...EMPTY_STATE, eventIds: [] };
      }
      throw new Error("Could not read the Photon event cursor file.");
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("The Photon event cursor file contains invalid JSON.");
    }
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.cursor) ||
      typeof value.cursor !== "number" ||
      value.cursor < 0 ||
      !Array.isArray(value.eventIds) ||
      value.eventIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("The Photon event cursor file has an invalid structure.");
    }

    return {
      cursor: value.cursor,
      eventIds: value.eventIds.slice(-MAX_EVENT_IDS),
    };
  }

  async save(state: PhotonCursorState): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true });
    const temporaryFilename = `${this.filename}.${process.pid}.tmp`;
    const serialized = JSON.stringify({
      cursor: state.cursor,
      eventIds: state.eventIds.slice(-MAX_EVENT_IDS),
    });
    try {
      await writeFile(temporaryFilename, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryFilename, this.filename);
    } catch {
      throw new Error("Could not persist the Photon event cursor.");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
