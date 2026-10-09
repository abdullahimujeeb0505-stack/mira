export interface SchedulerRuntime {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(delayMs: number): Promise<void>;
}

export const systemRuntime: SchedulerRuntime = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    if (handle !== undefined && handle !== null) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
  sleep: (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, delayMs));
    }),
};
