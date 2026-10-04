import type { ActionResult } from '../skills/actionController.js';
import type { ReflexEvent } from '../reflexes/engine.js';

/** Carte des événements du bus. Chaque phase y ajoute les siens. */
export interface BusEvents {
  'bot:ready': { username: string };
  'bot:lost': { reason: string };
  'action:result': ActionResult;
  'reflex:triggered': ReflexEvent;
}
