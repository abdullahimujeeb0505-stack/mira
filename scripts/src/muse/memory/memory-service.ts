import type {
  MemoryCategory,
  MemoryRecord,
  MemoryRepository,
  NewMemory,
} from "./memory-types.js";
import { containsCredentialMaterial } from "./memory-safety.js";

const MAX_MEMORY_LENGTH = 2_000;

export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  list(category?: MemoryCategory): Promise<MemoryRecord[]> {
    return this.repository.list(category);
  }

  retrieve(query: string, limit = 5): Promise<MemoryRecord[]> {
    return this.repository.search(query, limit);
  }

  async remember(memory: NewMemory): Promise<MemoryRecord> {
    const normalized: NewMemory = {
      category: memory.category,
      content: validateContent(memory.content),
    };
    const existing = (await this.repository.list(normalized.category)).find(
      (record) => record.content.toLowerCase() === normalized.content.toLowerCase(),
    );
    return existing ?? this.repository.create(normalized);
  }

  update(id: string, content: string): Promise<MemoryRecord | undefined> {
    return this.repository.update(id, validateContent(content));
  }

  forget(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }
}

function validateContent(value: string): string {
  const content = value.trim();
  if (!content) throw new Error("Memory content cannot be empty.");
  if (content.length > MAX_MEMORY_LENGTH) {
    throw new Error(`Memory content must be ${MAX_MEMORY_LENGTH} characters or fewer.`);
  }
  if (containsCredentialMaterial(content)) {
    throw new Error("Muse will not store passwords, API keys, tokens, or wallet secrets.");
  }
  return content;
}
