---
name: telegram-voice-tts
description: Generate high-quality Telegram voice notes (bubbles) using Microsoft Edge TTS and FFmpeg. Use when asked to send audio as a voice message, or when the user requires voice-bar replies instead of audio files. Handles edge-tts generation and OGG/Opus conversion for native Telegram voice compatibility.
---

# Telegram Voice TTS

> 本地部署版。用于在当前工作区稳定生成 Telegram 原生语音气泡。

## What this skill does

This skill provides a workflow for generating native Telegram voice notes.

1. Generate an OGG/Opus file with `{baseDir}/scripts/telegram_voice.py`
2. Send the resulting file through Telegram as a voice note (`asVoice: true`)

## Requirements

- `edge-tts` command installed and available on PATH
- `ffmpeg` installed and available on PATH
- Telegram sending path that supports local media files

## Script usage

```bash
python3 {baseDir}/scripts/telegram_voice.py "Text to speak" "/tmp/output.ogg"
```

## Environment variables

The script honors these optional env vars:

- `EDGE_TTS_VOICE` (default: `zh-CN-XiaoxiaoNeural`)
- `EDGE_TTS_RATE` (default: `+0%`)
- `EDGE_TTS_PITCH` (default: `+0Hz`)

## Notes

- This is deployed because the built-in TTS path did not reliably produce Telegram voice bubbles in the current Web → Telegram mirror flow.
- The goal is not just TTS, but **stable Telegram native voice-note delivery**.
- For text + voice dual output, keep the original text message and send the generated `.ogg` as an additional Telegram voice note.
