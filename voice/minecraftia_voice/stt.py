"""Transcription : découpage en énoncés (silences entre paquets) puis faster-whisper + Silero VAD."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

import numpy as np

from .codec import STT_RATE


@dataclass
class Utterance:
    speaker: str
    pcm: np.ndarray  # 16 kHz mono int16
    started_ms: int
    ended_ms: int

    @property
    def duration_ms(self) -> int:
        return int(len(self.pcm) * 1000 / STT_RATE)


@dataclass
class _Buffer:
    chunks: list[np.ndarray] = field(default_factory=list)
    started_ms: int = 0
    last_ms: int = 0
    samples: int = 0


class UtteranceAssembler:
    """
    Simple Voice Chat n'envoie des paquets que lorsque le joueur parle (appui ou détection de voix) :
    un silence de `gap_ms` sans paquet marque la fin d'un énoncé. Les énoncés trop longs sont coupés.
    """

    def __init__(self, gap_ms: int = 700, min_ms: int = 350, max_ms: int = 15_000) -> None:
        self.gap_ms, self.min_ms, self.max_ms = gap_ms, min_ms, max_ms
        self._buffers: dict[str, _Buffer] = {}

    def push(self, speaker: str, pcm16k: np.ndarray, now_ms: int) -> Utterance | None:
        buf = self._buffers.get(speaker)
        if buf is None:
            buf = _Buffer(started_ms=now_ms)
            self._buffers[speaker] = buf
        buf.chunks.append(pcm16k)
        buf.samples += len(pcm16k)
        buf.last_ms = now_ms
        if buf.samples * 1000 / STT_RATE >= self.max_ms:
            return self._close(speaker)
        return None

    def tick(self, now_ms: int) -> list[Utterance]:
        done = [s for s, b in self._buffers.items() if now_ms - b.last_ms >= self.gap_ms]
        return [u for u in (self._close(s) for s in done) if u is not None]

    def _close(self, speaker: str) -> Utterance | None:
        buf = self._buffers.pop(speaker)
        pcm = np.concatenate(buf.chunks) if buf.chunks else np.zeros(0, dtype=np.int16)
        u = Utterance(speaker, pcm, buf.started_ms, buf.last_ms)
        return u if u.duration_ms >= self.min_ms else None


# Contexte donné à Whisper : prénoms des bots et vocabulaire de Minecraft, pour éviter
# « bushes » au lieu de « bûches » ou « beau » au lieu de « bois ».
DEFAULT_PROMPT = (
    "Alex, Léa, Minecraft. Coupe du bois, récolte des bûches, donne-moi tes bûches, suis-moi, viens ici, "
    "arrête-toi, mine du fer, du charbon, des diamants, creuse, construis un mur, une maison, des planches, "
    "une pioche, une hache, une épée, un établi, un four, un coffre, une échelle, des torches, "
    "un creeper, un zombie, un squelette."
)


class Transcriber:
    """faster-whisper sur CPU (int8), en français, filtre VAD Silero pour ignorer bruits et silences."""

    def __init__(self, model_size: str | None = None, models_dir: str | None = None) -> None:
        from faster_whisper import WhisperModel

        self.model_size = model_size or os.environ.get("WHISPER_MODEL", "small")
        self._model = WhisperModel(
            self.model_size,
            device="cpu",
            compute_type="int8",
            download_root=models_dir or os.environ.get("WHISPER_MODELS_DIR"),
            cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
        )

    def transcribe(self, pcm16k: np.ndarray) -> str:
        return self.transcribe_scored(pcm16k)[0]

    def transcribe_scored(self, pcm16k: np.ndarray) -> tuple[str, float]:
        """Texte et confiance moyenne (log-probabilité moyenne des segments, 0 = sûr, -1 = très douteux)."""
        audio = pcm16k.astype(np.float32) / 32768.0
        segments, _info = self._model.transcribe(
            audio,
            language="fr",
            beam_size=int(os.environ.get("WHISPER_BEAM", "5")),
            initial_prompt=os.environ.get("WHISPER_PROMPT", DEFAULT_PROMPT),
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False,
        )
        segs = list(segments)
        text = " ".join(s.text.strip() for s in segs).strip()
        confidence = sum(s.avg_logprob for s in segs) / len(segs) if segs else -1.0
        return text, float(confidence)
