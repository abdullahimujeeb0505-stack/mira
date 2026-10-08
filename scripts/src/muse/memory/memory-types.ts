export const MEMORY_CATEGORIES = [
  "USER",
  "ACTIVE",
  "WATCHING",
  "CONTENT",
  "HISTORY",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory {
  category: MemoryCategory;
  content: string;
}

export interface MemoryRepository {
  list(category?: MemoryCategory): Promise<MemoryRecord[]>;
  create(memory: NewMemory): Promise<MemoryRecord>;
  update(id: string, content: string): Promise<MemoryRecord | undefined>;
  delete(id: string): Promise<boolean>;
  search(query: string, limit?: number): Promise<MemoryRecord[]>;
}

export function isMemoryCategory(value: string): value is MemoryCategory {
  return MEMORY_CATEGORIES.includes(value.toUpperCase() as MemoryCategory);
}

export function parseMemoryCategory(value: string): MemoryCategory | undefined {
  const normalized = value.trim().toUpperCase();
  return isMemoryCategory(normalized) ? normalized : undefined;
}
