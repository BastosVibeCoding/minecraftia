"""
Service vocal local de Minecraftia (WebSocket, port 8800, réseau Docker interne uniquement).

Bot -> service :
  {"type": "audio", "speaker": "<pseudo>", "t": <ms>, "opus": "<base64>"}   paquet Opus 48 kHz entendu
  {"type": "tts", "id": "<id>", "text": "<phrase>"}                          synthèse demandée
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

import websockets

from .codec import FRAME_MS, STT_RATE, SVC_RATE, OpusDecoder, encode_opus, resample
from .stt import Transcriber, UtteranceAssembler
from .tts import create_engine

log = logging.getLogger("minecraftia-voice")


def now_ms() -> int:
    return int(time.monotonic() * 1000)


class VoiceService:
    def __init__(self, transcriber: Transcriber, tts=None) -> None:
        self.transcriber = transcriber
        self.tts = tts or create_engine()
        self.assembler = UtteranceAssembler()
        self.decoders: dict[str, OpusDecoder] = {}
        self.clients: set = set()
        self._stt_lock = asyncio.Lock()

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
            text = await asyncio.get_running_loop().run_in_executor(None, self.transcriber.transcribe, utt.pcm)
        latency = int((time.monotonic() - started) * 1000)
        log.info("transcription (%s, %d ms d'audio, %d ms) : %s", utt.speaker, utt.duration_ms, latency, text)
        if not text:
            return
        payload = json.dumps({"type": "transcript", "speaker": utt.speaker, "text": text, "audio_ms": utt.duration_ms, "latency_ms": latency})
        await asyncio.gather(*(c.send(payload) for c in list(self.clients)), return_exceptions=True)

    async def on_tts(self, ws, msg: dict) -> None:
        req_id = msg.get("id")
        try:
            pcm = await self.tts.synth(str(msg.get("text", ""))[:400])
            frames = [base64.b64encode(p).decode("ascii") for p in encode_opus(pcm, SVC_RATE, FRAME_MS)]
            await ws.send(json.dumps({"type": "tts_result", "id": req_id, "frames": frames, "frame_ms": FRAME_MS, "duration_ms": int(len(pcm) * 1000 / SVC_RATE)}))
        except Exception as err:
            log.warning("synthèse impossible : %s", err)
            await ws.send(json.dumps({"type": "error", "id": req_id, "message": str(err)}))

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
