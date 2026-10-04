/** Horloge injectable : le temps réel en production, un temps simulé dans les tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

/** Horloge manuelle pour les tests et les simulations accélérées. */
export class ManualClock implements Clock {
  private current: number;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const id = this.nextId++;
    this.timers.push({ at: this.current + ms, fn, id });
    return { cancel: () => (this.timers = this.timers.filter((t) => t.id !== id)) };
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.current = next.at;
      next.fn();
    }
    this.current = target;
  }
}
