"""
Service vocal local de Minecraftia (WebSocket, port 8800, réseau Docker interne uniquement).

Bot -> service :
  {"type": "audio", "speaker": "<pseudo>", "t": <ms>, "opus": "<base64>"}   paquet Opus 48 kHz entendu
  {"type": "tts", "id": "<id>", "text": "<phrase>", "voice": "<voix>"?}     synthèse demandée (voix facultative)
  {"type": "ping"}
Service -> bot :
  {"type": "transcript", "speaker", "text", "audio_ms", "latency_ms"}
  {"type": "tts_result", "id", "frames": ["<base64 opus>", ...], "frame_ms": 20, "duration_ms"}
  {"type": "error", "id"?, "message"}
  {"type": "pong"}
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time

import numpy as np
import websockets

from .codec import FRAME_MS, STT_RATE, SVC_RATE, OpusDecoder, encode_opus, resample
from .stt import Transcriber, UtteranceAssembler
from .tts import create_engine

log = logging.getLogger("minecraftia-voice")

# nombre de phrases dont le son est gardé pour une retranscription précise
RECENT_UTTERANCES = 20


def now_ms() -> int:
    return int(time.monotonic() * 1000)


class VoiceService:
    def __init__(self, transcriber: Transcriber, tts=None) -> None:
        self.transcriber = transcriber
        self.tts = tts or create_engine()
        self._voices: dict[str, object] = {}
        self.assembler = UtteranceAssembler()
        self.decoders: dict[str, OpusDecoder] = {}
        self.clients: set = set()
        self._stt_lock = asyncio.Lock()
        # son des dernières phrases, pour une retranscription plus précise à la demande
        self.recent: dict[int, np.ndarray] = {}
        self._next_id = 0
        self._precise: Transcriber | None = None
        self.precise_model = os.environ.get("WHISPER_PRECISE_MODEL", "large-v3-turbo")

    async def handler(self, ws) -> None:
        self.clients.add(ws)
        log.info("client connecté (%d)", len(self.clients))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = msg.get("type")
                if kind == "audio":
                    self.on_audio(msg)
                elif kind == "tts":
                    asyncio.create_task(self.on_tts(ws, msg))
                elif kind == "refine":
                    asyncio.create_task(self.on_refine(ws, msg))
                elif kind == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            log.info("client déconnecté (%d)", len(self.clients))

    def on_audio(self, msg: dict) -> None:
        speaker = str(msg.get("speaker", "?"))
        try:
            packet = base64.b64decode(msg["opus"])
        except (KeyError, ValueError):
            return
        decoder = self.decoders.setdefault(speaker, OpusDecoder())
        try:
            pcm48 = decoder.decode(packet)
        except Exception as err:  # paquet corrompu : on repart d'un décodeur neuf
            log.warning("paquet Opus illisible (%s) : %s", speaker, err)
            self.decoders[speaker] = OpusDecoder()
            return
        done = self.assembler.push(speaker, resample(pcm48, SVC_RATE, STT_RATE), now_ms())
        if done:
            asyncio.create_task(self.emit_transcript(done))

    async def emit_transcript(self, utt) -> None:
        started = time.monotonic()
        async with self._stt_lock:  # une transcription à la fois : le CPU est partagé avec le jeu
            text, confidence = await asyncio.get_running_loop().run_in_executor(None, self.transcriber.transcribe_scored, utt.pcm)
        latency = int((time.monotonic() - started) * 1000)
        log.info("transcription (%s, %d ms d'audio, %d ms, confiance %.2f) : %s", utt.speaker, utt.duration_ms, latency, confidence, text)
        if not text:
            return
        self._next_id += 1
        utt_id = self._next_id
        self.recent[utt_id] = utt.pcm
        for old in [k for k in self.recent if k <= utt_id - RECENT_UTTERANCES]:
            del self.recent[old]
        payload = json.dumps(
            {"type": "transcript", "id": utt_id, "speaker": utt.speaker, "text": text, "confidence": round(confidence, 3), "audio_ms": utt.duration_ms, "latency_ms": latency}
        )
        await asyncio.gather(*(c.send(payload) for c in list(self.clients)), return_exceptions=True)

    async def on_refine(self, ws, msg: dict) -> None:
        """Retranscrit une phrase récente avec le modèle précis (chargé à la première demande)."""
        req_id = msg.get("req")
        pcm = self.recent.get(int(msg.get("id", -1)))
        if pcm is None or self.precise_model == "off":
            await ws.send(json.dumps({"type": "refined", "req": req_id, "text": None}))
            return
        started = time.monotonic()
        loop = asyncio.get_running_loop()
        async with self._stt_lock:
            if self._precise is None:
                log.info("chargement du modèle précis « %s »", self.precise_model)
                self._precise = await loop.run_in_executor(None, lambda: Transcriber(self.precise_model))
            text = await loop.run_in_executor(None, self._precise.transcribe, pcm)
        latency = int((time.monotonic() - started) * 1000)
        log.info("retranscription précise (%d ms) : %s", latency, text)
        await ws.send(json.dumps({"type": "refined", "req": req_id, "text": text or None, "latency_ms": latency}))

    async def on_tts(self, ws, msg: dict) -> None:
        req_id = msg.get("id")
        try:
            pcm = await self.engine_for(msg.get("voice")).synth(str(msg.get("text", ""))[:400])
            frames = [base64.b64encode(p).decode("ascii") for p in encode_opus(pcm, SVC_RATE, FRAME_MS)]
            await ws.send(json.dumps({"type": "tts_result", "id": req_id, "frames": frames, "frame_ms": FRAME_MS, "duration_ms": int(len(pcm) * 1000 / SVC_RATE)}))
        except Exception as err:
            log.warning("synthèse impossible : %s", err)
            await ws.send(json.dumps({"type": "error", "id": req_id, "message": str(err)}))

    def engine_for(self, voice):
        """Chaque bot peut avoir sa voix : un moteur par voix demandée, créé à la première utilisation."""
        if not voice or not isinstance(voice, str):
            return self.tts
        if voice not in self._voices:
            self._voices[voice] = type(self.tts)(voice)
        return self._voices[voice]

    async def ticker(self) -> None:
        while True:
            await asyncio.sleep(0.1)
            for utt in self.assembler.tick(now_ms()):
                asyncio.create_task(self.emit_transcript(utt))


async def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    log.info("chargement du modèle Whisper « %s »", os.environ.get("WHISPER_MODEL", "small"))
    service = VoiceService(Transcriber())
    port = int(os.environ.get("VOICE_PORT", "8800"))
    async with websockets.serve(service.handler, "0.0.0.0", port, max_size=8 * 1024 * 1024):
        log.info("service vocal à l'écoute sur %d", port)
        await service.ticker()


if __name__ == "__main__":
    asyncio.run(main())
