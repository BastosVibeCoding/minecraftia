"""Synthèse vocale derrière une interface : Edge TTS aujourd'hui, Piper ou Kokoro demain."""
from __future__ import annotations

import os
from typing import Protocol

import numpy as np

from .codec import SVC_RATE, decode_file_bytes


class TtsEngine(Protocol):
    """Moteur de synthèse : texte -> PCM mono 16 bits à 48 kHz (format de Simple Voice Chat)."""

    name: str

    async def synth(self, text: str) -> np.ndarray: ...


class EdgeTts:
    """Voix neuronales de Microsoft Edge (service en ligne, gratuit)."""

    name = "edge"

    def __init__(self, voice: str | None = None) -> None:
        self.voice = voice or os.environ.get("EDGE_VOICE", "fr-FR-HenriNeural")

    async def synth(self, text: str) -> np.ndarray:
        import edge_tts

        audio = bytearray()
        async for chunk in edge_tts.Communicate(text, self.voice).stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
        if not audio:
            raise RuntimeError("Edge TTS n'a renvoyé aucun audio")
        return decode_file_bytes(bytes(audio), SVC_RATE)


ENGINES: dict[str, type] = {"edge": EdgeTts}


def create_engine(name: str | None = None) -> TtsEngine:
    """Moteur choisi par `TTS_ENGINE` ; pour en ajouter un, l'enregistrer dans `ENGINES`."""
    key = name or os.environ.get("TTS_ENGINE", "edge")
    if key not in ENGINES:
        raise ValueError(f"moteur TTS inconnu : {key} (disponibles : {', '.join(ENGINES)})")
    return ENGINES[key]()
