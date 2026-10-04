"""Codage audio : Opus (Simple Voice Chat, 48 kHz mono, trames de 20 ms) <-> PCM 16 bits."""
from __future__ import annotations

import io

import av
import numpy as np

SVC_RATE = 48_000
STT_RATE = 16_000
FRAME_MS = 20


class OpusDecoder:
    """Décodeur Opus avec état (un par locuteur : les trames successives dépendent les unes des autres)."""

    def __init__(self, rate: int = SVC_RATE) -> None:
        self._codec = av.CodecContext.create("libopus", "r")
        self._codec.sample_rate = rate
        self._codec.layout = "mono"

    def decode(self, packet: bytes) -> np.ndarray:
        chunks = [_mono_s16(frame) for frame in self._codec.decode(av.Packet(packet))]
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)


def _mono_s16(frame: av.AudioFrame) -> np.ndarray:
    data = frame.to_ndarray()
    if data.dtype != np.int16:
        data = np.clip(data * 32767.0, -32768, 32767).astype(np.int16) if data.dtype.kind == "f" else data.astype(np.int16)
    if data.ndim == 2:
        # formats planaires (canaux, échantillons) ou entrelacés (1, échantillons × canaux)
        channels = len(frame.layout.channels)
        if data.shape[0] == channels and channels > 1:
            data = data.mean(axis=0).astype(np.int16)
        elif channels > 1:
            data = data.reshape(-1, channels).mean(axis=1).astype(np.int16)
        else:
            data = data.reshape(-1)
    return data.astype(np.int16, copy=False)


def resample(pcm: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Rééchantillonnage PCM 16 bits mono (filtrage de qualité via libswresample)."""
    if src == dst or len(pcm) == 0:
        return pcm.astype(np.int16, copy=False)
    resampler = av.AudioResampler(format="s16", layout="mono", rate=dst)
    frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm, dtype=np.int16).reshape(1, -1), format="s16", layout="mono")
    frame.sample_rate = src
    out = [f.to_ndarray().reshape(-1) for f in resampler.resample(frame)]
    out += [f.to_ndarray().reshape(-1) for f in resampler.resample(None)]
    return np.concatenate(out).astype(np.int16) if out else np.zeros(0, dtype=np.int16)


def encode_opus(pcm: np.ndarray, rate: int = SVC_RATE, frame_ms: int = FRAME_MS) -> list[bytes]:
    """PCM mono 16 bits -> paquets Opus de `frame_ms` (comme les envoie Simple Voice Chat)."""
    codec = av.CodecContext.create("libopus", "w")
    codec.sample_rate = rate
    codec.layout = "mono"
    codec.format = "s16"
    codec.options = {"application": "voip", "frame_duration": str(frame_ms)}
    size = rate * frame_ms // 1000
    pcm = np.ascontiguousarray(pcm, dtype=np.int16)
    packets: list[bytes] = []
    for start in range(0, len(pcm), size):
        chunk = pcm[start : start + size]
        if len(chunk) < size:
            chunk = np.pad(chunk, (0, size - len(chunk)))
        frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = rate
        packets.extend(bytes(p) for p in codec.encode(frame))
    packets.extend(bytes(p) for p in codec.encode(None))
    return packets


def decode_file_bytes(data: bytes, rate: int = SVC_RATE) -> np.ndarray:
    """Fichier audio compressé (mp3, wav...) -> PCM mono 16 bits à `rate`."""
    chunks: list[np.ndarray] = []
    with av.open(io.BytesIO(data)) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
        for frame in container.decode(audio=0):
            chunks += [f.to_ndarray().reshape(-1) for f in resampler.resample(frame)]
        chunks += [f.to_ndarray().reshape(-1) for f in resampler.resample(None)]
    return np.concatenate(chunks).astype(np.int16) if chunks else np.zeros(0, dtype=np.int16)
