import type { EasyLlmMessage } from '../bot/easyLlm.js';

export interface HeardPacket {
  speaker: string;
  capturedAtMs: number;
  opusBase64: string;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});

/**
 * Extrait de la télémétrie Easy LLM (`heard_audio_batch`) les paquets Opus prononcés par un joueur.
 * Format (programme d'exemple de l'auteur du mod) : data.listeners[<auditeur>].heard_packets[] avec
 * speaker_name, captured_at_ms, opus_data_base64. Un même paquet entendu par plusieurs auditeurs
 * n'est gardé qu'une fois.
 */
export class HeardAudioExtractor {
  private seen = new Map<string, number>();

  constructor(private readonly speaker: string) {}

  extract(msg: EasyLlmMessage): HeardPacket[] {
    if (msg.type === 'event_batch' && Array.isArray(msg.items)) return msg.items.flatMap((i) => this.extract(asRec(i)));
    if (msg.type !== 'heard_audio_batch') return [];
    const out: HeardPacket[] = [];
    for (const listener of Object.values(asRec(asRec(msg.data).listeners))) {
      const packets = asRec(listener).heard_packets;
      if (!Array.isArray(packets)) continue;
      for (const raw of packets) {
        const p = asRec(raw);
        if (p.speaker_name !== this.speaker || typeof p.opus_data_base64 !== 'string') continue;
        const at = Number(p.captured_at_ms ?? 0);
        const key = `${at}:${p.opus_data_base64.length}:${p.opus_data_base64.slice(0, 16)}`;
        if (this.seen.has(key)) continue;
        this.seen.set(key, at);
        out.push({ speaker: this.speaker, capturedAtMs: at, opusBase64: p.opus_data_base64 });
      }
    }
    if (this.seen.size > 5000) {
      const cutoff = Math.max(...this.seen.values()) - 60_000;
      for (const [k, at] of this.seen) if (at < cutoff) this.seen.delete(k);
    }
    return out.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  }
}
