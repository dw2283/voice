import argparse
import json
import logging
import os
import sys

from faster_whisper import WhisperModel


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model", default="base")
    return parser.parse_args()


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def transcribe(model, audio_path):
    segments, info = model.transcribe(
        audio_path,
        beam_size=1,
        best_of=1,
        condition_on_previous_text=False,
        patience=1,
        temperature=0,
        vad_filter=True
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "language": info.language,
        "language_probability": info.language_probability,
        "text": text
    }


def main():
    args = parse_args()
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    os.makedirs(args.cache_dir, exist_ok=True)

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.cache_dir
        )
    except Exception as exc:
        emit({"event": "error", "error": f"Failed to load local speech model: {exc}"})
        return 1

    emit(
        {
            "cache_dir": args.cache_dir,
            "compute_type": args.compute_type,
            "device": args.device,
            "event": "ready",
            "model": args.model
        }
    )

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        try:
            request = json.loads(line)
            result = transcribe(model, request["audio_path"])
            emit({"id": request["id"], **result})
        except Exception as exc:
            emit({"error": str(exc), "id": request.get("id") if "request" in locals() else None})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
