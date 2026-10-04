import type { Logger } from './logger.js';

type Listener<T> = (payload: T) => void;

/**
 * Bus d'événements typé : seul canal entre modules.
 * Une erreur dans un abonné est journalisée et n'interrompt ni l'émetteur ni les autres abonnés.
 */
export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly logger?: Logger) {}

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        this.logger?.error({ err, event: String(event) }, 'abonné du bus en erreur');
      }
    }
  }
}
