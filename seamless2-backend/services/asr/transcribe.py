# services/asr/transcribe.py
import argparse, json, os
import whisper

def transcribe(input_path, meeting_id, out_dir='./storage/meetings'):
    os.makedirs(out_dir, exist_ok=True)
    model = whisper.load_model("small")  # "base","small","medium","large" trade-offs
    print(f"Transcribing {input_path} ...")
    result = model.transcribe(input_path, word_timestamps=True)  # word_timestamps best in newer whisper
    # format segments: start, end, text
    segments = []
    for seg in result.get('segments', []):
        segments.append({'start': seg['start'], 'end': seg['end'], 'text': seg['text']})
    out = {
        'transcript': result.get('text'),
        'segments': segments,
        'model': 'whisper',
        'raw': {}  # keep raw if desired
    }
    out_path = os.path.join(out_dir, f"{meeting_id}.transcript.json")
    with open(out_path, 'w', encoding='utf8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Saved transcript to {out_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--meeting', required=True)
    args = parser.parse_args()
    transcribe(args.input, args.meeting)
