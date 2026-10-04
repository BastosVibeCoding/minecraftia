import type { Logger } from '../core/logger.js';

/**
 * Voix du bot. Interface unique pour brancher d'autres moteurs : Edge TTS aujourd'hui (via le service
 * vocal), Piper ou Kokoro demain (côté service : `TTS_ENGINE`), ou un simple chat textuel.
 */
export interface Speaker {
  speak(text: string): Promise<void>;
}

/** Écrit dans le chat du jeu (toujours disponible). */
export class ChatSpeaker implements Speaker {
  constructor(private readonly chat: (text: string) => void) {}
  async speak(text: string): Promise<void> {
    this.chat(text);
  }
}

export interface SynthAndPlay {
  synth(text: string): Promise<string[]>;
  play(frames: string[]): Promise<void>;
  readonly available: boolean;
}

/** Parle dans le jeu (Simple Voice Chat) : synthèse par le service vocal, lecture par Easy LLM Voice. */
export class VoiceSpeaker implements Speaker {
  constructor(private readonly backend: SynthAndPlay) {}
  async speak(text: string): Promise<void> {
    if (!this.backend.available) throw new Error('voix indisponible');
    await this.backend.play(await this.backend.synth(text));
  }
}

/**
 * Chat toujours (lisible, trace écrite), voix en plus quand elle est disponible.
 * Un échec de la voix n'empêche jamais le message d'être transmis.
 */
export class CompositeSpeaker implements Speaker {
  constructor(
    private readonly chat: Speaker,
    private readonly voice: Speaker | null,
    private readonly logger: Logger,
  ) {}

  async speak(text: string): Promise<void> {
    await this.chat.speak(text);
    if (!this.voice) return;
    try {
      await this.voice.speak(text);
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'voix non jouée (chat seul)');
    }
  }
}
