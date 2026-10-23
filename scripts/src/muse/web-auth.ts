import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;
const DUMMY_SALT = Buffer.from("6d7573652d617574682d64756d6d79", "hex");
const DUMMY_HASH = Buffer.alloc(SCRYPT_KEY_LENGTH);

export interface WebUser {
  id: string;
  username: string;
}

interface StoredWebUser extends WebUser {
  normalizedUsername: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

export class WebAuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthInputError";
  }
}

export class WebUsernameTakenError extends Error {
  constructor() {
    super("That username is already taken.");
    this.name = "WebUsernameTakenError";
  }
}

export class JsonWebUserStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async register(usernameValue: string, password: string): Promise<WebUser> {
    const username = usernameValue.trim();
    const normalizedUsername = normalizeUsername(username);
    validatePasswordForRegistration(password);

    return this.withExclusive(async () => {
      const users = await this.readUsers();
      if (users.some((user) => user.normalizedUsername === normalizedUsername)) {
        throw new WebUsernameTakenError();
      }

      const salt = randomBytes(16);
      const passwordHash = await derivePassword(password, salt);
      const user: StoredWebUser = {
        id: randomUUID(),
        username,
        normalizedUsername,
        salt: salt.toString("hex"),
        passwordHash: passwordHash.toString("hex"),
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await this.writeUsers(users);
      return publicUser(user);
    });
  }

  async authenticate(
    usernameValue: string,
    password: string,
  ): Promise<WebUser | undefined> {
    const username = usernameValue.trim();
    const normalizedUsername = tryNormalizeUsername(username);
    if (!normalizedUsername || !password || password.length > PASSWORD_MAX_LENGTH) {
      const dummyCandidate = await derivePassword(
        password.slice(0, PASSWORD_MAX_LENGTH),
        DUMMY_SALT,
      );
      timingSafeEqual(dummyCandidate, DUMMY_HASH);
      return undefined;
    }

    const users = await this.readUsers();
    const user = users.find(
      (candidate) => candidate.normalizedUsername === normalizedUsername,
    );
    const salt = user ? Buffer.from(user.salt, "hex") : DUMMY_SALT;
    const expectedHash = user
      ? Buffer.from(user.passwordHash, "hex")
      : DUMMY_HASH;
    const actualHash = await derivePassword(password, salt);
    const passwordMatches = timingSafeEqual(actualHash, expectedHash);
    return user && passwordMatches ? publicUser(user) : undefined;
  }

  private async readUsers(): Promise<StoredWebUser[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error("Muse account data is not valid JSON.");
    }
    if (!Array.isArray(parsed) || !parsed.every(isStoredWebUser)) {
      throw new Error("Muse account data has an invalid format.");
    }
    return parsed;
  }

  private async writeUsers(users: StoredWebUser[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(users, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  private withExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(task, task);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function normalizeUsername(username: string): string {
  const normalized = tryNormalizeUsername(username);
  if (!normalized) {
    throw new WebAuthInputError(
      "Use a username with 3–24 letters, numbers, or underscores.",
    );
  }
  return normalized;
}

function tryNormalizeUsername(username: string): string | undefined {
  const trimmed = username.trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function validatePasswordForRegistration(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new WebAuthInputError(
      `Use a password with at least ${PASSWORD_MIN_LENGTH} characters.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new WebAuthInputError(
      `Passwords must be ${PASSWORD_MAX_LENGTH} characters or fewer.`,
    );
  }
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key as Buffer);
      },
    );
  });
}

function publicUser(user: StoredWebUser): WebUser {
  return { id: user.id, username: user.username };
}

function isStoredWebUser(value: unknown): value is StoredWebUser {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.id) &&
    typeof value.username === "string" &&
    typeof value.normalizedUsername === "string" &&
    /^[a-z0-9_]{3,24}$/.test(value.normalizedUsername) &&
    value.username.trim().toLowerCase() === value.normalizedUsername &&
    typeof value.salt === "string" &&
    /^[0-9a-f]{32}$/.test(value.salt) &&
    typeof value.passwordHash === "string" &&
    /^[0-9a-f]{128}$/.test(value.passwordHash) &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
