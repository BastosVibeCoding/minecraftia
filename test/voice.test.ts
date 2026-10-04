import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ChatSpeaker, CompositeSpeaker, VoiceSpeaker } from '../src/tts/speaker.js';
import { HeardAudioExtractor } from '../src/voice/audioIn.js';
import { VoiceClient, type Transcript } from '../src/voice/voiceClient.js';
import { VoiceLink } from '../src/voice/voiceLink.js';
import { silentLogger } from './helpers.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let port = 18900;
const nextPort = () => port++;

describe('audio entendu (Easy LLM)', () => {
  const batch = (listeners: Record<string, { speaker: string; at: number; data: string }[]>) => ({
    type: 'heard_audio_batch',
    data: {
      listeners: Object.fromEntries(
        Object.entries(listeners).map(([l, pkts]) => [l, { heard_packets: pkts.map((p) => ({ speaker_name: p.speaker, speaker_uuid: 'u', captured_at_ms: p.at, opus_data_base64: p.data })) }]),
      ),
    },
  });

  it('ne garde que le joueur suivi, une seule fois par paquet, dans l\'ordre', () => {
    const x = new HeardAudioExtractor('Bastien');
    const out = x.extract(
      batch({
        Minecraftia: [
          { speaker: 'Bastien', at: 40, data: 'BBBB' },
          { speaker: 'Bastien', at: 20, data: 'AAAA' },
          { speaker: 'Autre', at: 30, data: 'ZZZZ' },
        ],
        Alexia: [{ speaker: 'Bastien', at: 20, data: 'AAAA' }],
      }),
    );
    expect(out.map((p) => p.opusBase64)).toEqual(['AAAA', 'BBBB']);
  });

  it('lit aussi les lots imbriqués (event_batch)', () => {
    const x = new HeardAudioExtractor('Bastien');
    expect(x.extract({ type: 'event_batch', items: [batch({ M: [{ speaker: 'Bastien', at: 1, data: 'Q' }] })] })).toHaveLength(1);
  });
});

describe('canal de sortie Easy LLM Voice', () => {
  it('envoie setup, les trames au rythme réel, puis voice_stop', async () => {
    const p = nextPort();
    const link = new VoiceLink({ port: p, playerName: 'Minecraftia', logger: silentLogger });
    link.start();
    const received: Record<string, unknown>[] = [];
    const mod = new WebSocket(`ws://127.0.0.1:${p}`);
    mod.on('message', (d) => received.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise((r) => mod.once('open', r));
    await wait(50);
    expect(received[0]).toMatchObject({ type: 'setup', player_name: 'Minecraftia', audio_codec: 'opus', sample_rate: 48000, frame_millis: 20 });
    const t0 = Date.now();
    await link.play(['AA', 'BB', 'CC', 'DD', 'EE']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80); // 5 trames de 20 ms
    await wait(50);
    const frames = received.filter((m) => m.type === 'voice_frame');
    expect(frames.map((f) => f.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(received.at(-1)).toMatchObject({ type: 'voice_stop', last_sequence: 4 });
    mod.close();
    link.stop();
  });

  it('refuse de jouer sans mod connecté', async () => {
    const link = new VoiceLink({ port: nextPort(), playerName: 'M', logger: silentLogger });
    link.start();
    await expect(link.play(['AA'])).rejects.toThrow(/non connecté/);
    link.stop();
  });
});

describe('client du service vocal', () => {
  it('transmet l\'audio, reçoit les transcriptions et les synthèses', async () => {
    const p = nextPort();
    const server = new WebSocketServer({ port: p });
    const audio: unknown[] = [];
    server.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        if (m.type === 'audio') {
          audio.push(m);
          ws.send(JSON.stringify({ type: 'transcript', speaker: 'Bastien', text: 'construis un mur', audio_ms: 1500, latency_ms: 400 }));
        }
        if (m.type === 'tts') ws.send(JSON.stringify({ type: 'tts_result', id: m.id, frames: ['F1', 'F2'], frame_ms: 20 }));
      });
    });
    const transcripts: Transcript[] = [];
    const client = new VoiceClient(`ws://127.0.0.1:${p}`, silentLogger, (t) => transcripts.push(t));
    client.start();
    for (let i = 0; i < 50 && !client.connected; i++) await wait(20);
    client.sendAudio('Bastien', 'T1BVUw==', 1);
    expect(await client.synth('Salut !')).toEqual(['F1', 'F2']);
    await wait(50);
    expect(audio).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({ speaker: 'Bastien', text: 'construis un mur', audioMs: 1500 });
    client.stop();
    server.close();
  });

  it('service absent : la synthèse échoue proprement', async () => {
    const client = new VoiceClient('ws://127.0.0.1:1', silentLogger, () => {});
    await expect(client.synth('x')).rejects.toThrow(/indisponible/);
  });
});

describe('voix du bot', () => {
  it('chat toujours, voix en plus ; une panne de voix ne bloque pas le message', async () => {
    const chat: string[] = [];
    const played: string[][] = [];
    const ok = new CompositeSpeaker(
      new ChatSpeaker((t) => chat.push(t)),
      new VoiceSpeaker({ synth: async () => ['F'], play: async (f) => void played.push(f), available: true }),
      silentLogger,
    );
    await ok.speak('Je regarde !');
    expect(chat).toEqual(['Je regarde !']);
    expect(played).toEqual([['F']]);

    const broken = new CompositeSpeaker(
      new ChatSpeaker((t) => chat.push(t)),
      new VoiceSpeaker({ synth: async () => { throw new Error('edge hors service'); }, play: async () => {}, available: true }),
      silentLogger,
    );
    await expect(broken.speak('D\'accord')).resolves.toBeUndefined();
    expect(chat).toContain('D\'accord');
  });
});
