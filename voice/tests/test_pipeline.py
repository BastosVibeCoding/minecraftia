"""Tests du service vocal. Les tests marqués `reel` utilisent Edge TTS (réseau) et un vrai modèle Whisper."""
import asyncio
import os

import numpy as np
import pytest

from minecraftia_voice.codec import STT_RATE, SVC_RATE, OpusDecoder, encode_opus, resample
from minecraftia_voice.stt import UtteranceAssembler


def sine(seconds: float, freq: float = 440.0, rate: int = SVC_RATE) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (np.sin(2 * np.pi * freq * t) * 12000).astype(np.int16)


def test_aller_retour_opus_conserve_la_duree():
    pcm = sine(1.0)
    packets = encode_opus(pcm)
    assert 48 <= len(packets) <= 52  # ~50 trames de 20 ms
    dec = OpusDecoder()
    out = np.concatenate([dec.decode(p) for p in packets])
    assert abs(len(out) - len(pcm)) <= SVC_RATE * 0.05


def test_reechantillonnage_48k_vers_16k():
    out = resample(sine(1.0), SVC_RATE, STT_RATE)
    assert abs(len(out) - STT_RATE) <= 160


def test_un_silence_entre_paquets_clot_l_enonce():
    asm = UtteranceAssembler(gap_ms=700, min_ms=200)
    chunk = np.zeros(STT_RATE // 50, dtype=np.int16)  # 20 ms
    for i in range(50):  # 1 s de parole
        assert asm.push("Bastien", chunk, i * 20) is None
    assert asm.tick(1000 + 500) == []
    done = asm.tick(1000 + 800)
    assert len(done) == 1 and done[0].speaker == "Bastien" and 950 <= done[0].duration_ms <= 1050


def test_un_bruit_trop_court_est_ignore():
    asm = UtteranceAssembler(min_ms=350)
    asm.push("Bastien", np.zeros(STT_RATE // 10, dtype=np.int16), 0)
    assert asm.tick(5000) == []


def test_enonce_trop_long_coupe():
    asm = UtteranceAssembler(max_ms=2000)
    chunk = np.zeros(STT_RATE // 10, dtype=np.int16)
    results = [asm.push("B", chunk, i * 100) for i in range(25)]
    assert any(r is not None for r in results)


@pytest.mark.skipif(os.environ.get("VOICE_REAL_TESTS") != "1", reason="réseau + modèle Whisper : VOICE_REAL_TESTS=1")
def test_reel_tts_puis_transcription_par_le_chemin_svc():
    from minecraftia_voice.stt import Transcriber
    from minecraftia_voice.tts import EdgeTts

    phrase = "Construis un mur en pierre près de la maison."
    pcm48 = asyncio.run(EdgeTts().synth(phrase))
    assert len(pcm48) > SVC_RATE  # plus d'une seconde d'audio

    # même chemin qu'en jeu : paquets Opus de 20 ms -> décodage -> 16 kHz -> assemblage -> Whisper
    dec = OpusDecoder()
    asm = UtteranceAssembler()
    t = 0
    for p in encode_opus(pcm48):
        asm.push("Bastien", resample(dec.decode(p), SVC_RATE, STT_RATE), t)
        t += 20
    (utt,) = asm.tick(t + 1000)
    text = Transcriber(os.environ.get("WHISPER_MODEL", "base")).transcribe(utt.pcm).lower()
    print("transcription :", text)
    assert "mur" in text and "pierre" in text


def test_une_voix_par_bot():
    from minecraftia_voice.server import VoiceService
    from minecraftia_voice.tts import EdgeTts

    svc = VoiceService.__new__(VoiceService)
    svc.tts = EdgeTts("fr-FR-DeniseNeural")
    svc._voices = {}
    assert svc.engine_for(None) is svc.tts
    vivienne = svc.engine_for("fr-FR-VivienneMultilingualNeural")
    assert vivienne.voice == "fr-FR-VivienneMultilingualNeural"
    assert svc.engine_for("fr-FR-VivienneMultilingualNeural") is vivienne


class _FakeWs:
    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(__import__("json").loads(payload))


class _FakeTranscriber:
    def __init__(self, text, confidence=-0.9):
        self.text, self.confidence = text, confidence

    def transcribe(self, pcm):
        return self.text

    def transcribe_scored(self, pcm):
        return self.text, self.confidence


def test_transcription_numerotee_puis_retranscription_precise_a_la_demande():
    from minecraftia_voice.server import VoiceService
    from minecraftia_voice.stt import Utterance

    async def run():
        svc = VoiceService(_FakeTranscriber("Alex, mettez Jean-Bière"), tts=object())
        ws = _FakeWs()
        svc.clients.add(ws)
        await svc.emit_transcript(Utterance("Bilboquet86", np.zeros(16000, dtype=np.int16), 0, 1000))
        msg = ws.sent[-1]
        assert msg["type"] == "transcript" and msg["id"] == 1 and msg["confidence"] == -0.9
        # le modèle précis est chargé à la première demande : ici on le remplace par un faux
        svc._precise = _FakeTranscriber("Alex, mets tes jambières")
        await svc.on_refine(ws, {"type": "refine", "id": 1, "req": "r1"})
        assert ws.sent[-1] == {"type": "refined", "req": "r1", "text": "Alex, mets tes jambières", "latency_ms": ws.sent[-1]["latency_ms"]}
        # phrase trop ancienne ou inconnue : pas de texte
        await svc.on_refine(ws, {"type": "refine", "id": 99, "req": "r2"})
        assert ws.sent[-1] == {"type": "refined", "req": "r2", "text": None}

    asyncio.run(run())
