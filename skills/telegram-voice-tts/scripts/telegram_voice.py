#!/usr/bin/env python3
import sys
import os
import subprocess
from pathlib import Path


def generate_voice_ogg(text: str, output_ogg: str) -> bool:
    temp_mp3 = output_ogg + ".mp3"
    voice = os.getenv("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
    rate = os.getenv("EDGE_TTS_RATE", "+0%")
    pitch = os.getenv("EDGE_TTS_PITCH", "+0Hz")

    try:
        Path(output_ogg).parent.mkdir(parents=True, exist_ok=True)

        subprocess.run(
            [
                "edge-tts",
                "--voice",
                voice,
                "--rate",
                rate,
                "--pitch",
                pitch,
                "--text",
                text,
                "--write-media",
                temp_mp3,
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        subprocess.run(
            [
                "ffmpeg",
                "-i",
                temp_mp3,
                "-c:a",
                "libopus",
                "-b:a",
                "32k",
                "-vbr",
                "on",
                "-y",
                output_ogg,
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        if os.path.exists(temp_mp3):
            os.remove(temp_mp3)
        return True
    except subprocess.CalledProcessError as e:
        print(e.stderr or str(e), file=sys.stderr)
        return False
    except Exception as e:
        print(str(e), file=sys.stderr)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: telegram_voice.py <text> <output_ogg_path>", file=sys.stderr)
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]

    ok = generate_voice_ogg(text, output_path)
    if ok:
        print(output_path)
    else:
        sys.exit(1)
