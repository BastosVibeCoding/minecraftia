# Service vocal de Minecraftia : transcription (faster-whisper + Silero VAD) et synthèse (Edge TTS)
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 WHISPER_MODELS_DIR=/data/models HF_HOME=/data/hf
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt pytest
COPY minecraftia_voice ./minecraftia_voice
COPY tests ./tests
VOLUME ["/data"]
EXPOSE 8800
CMD ["python", "-m", "minecraftia_voice.server"]
