import type { SourceAdapter } from "./source-types.js";

export interface SourceAdapterRegistration {
  type: string;
  enabled: boolean;
}

interface RegisteredAdapter {
  adapter: SourceAdapter;
  enabled: boolean;
}

export class SourceRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();

  register(adapter: SourceAdapter, enabled = true): void {
    const type = normalizeAdapterType(adapter.type);
    if (this.adapters.has(type)) {
      throw new Error(`Source adapter "${type}" is already registered.`);
    }
    this.adapters.set(type, { adapter, enabled });
  }

  get(type: string): SourceAdapter | undefined {
    return this.adapters.get(normalizeAdapterType(type))?.adapter;
  }

  isEnabled(type: string): boolean {
    return this.adapters.get(normalizeAdapterType(type))?.enabled ?? false;
  }

  enable(type: string): boolean {
    const registration = this.adapters.get(normalizeAdapterType(type));
    if (!registration) return false;
    registration.enabled = true;
    return true;
  }

  disable(type: string): boolean {
    const registration = this.adapters.get(normalizeAdapterType(type));
    if (!registration) return false;
    registration.enabled = false;
    return true;
  }

  list(): SourceAdapterRegistration[] {
    return [...this.adapters.entries()]
      .map(([type, registration]) => ({
        type,
        enabled: registration.enabled,
      }))
      .sort((left, right) => left.type.localeCompare(right.type));
  }
}

function normalizeAdapterType(value: string): string {
  const type = value.trim().toLowerCase();
  if (!type) throw new Error("Source adapter type cannot be empty.");
  return type;
}
