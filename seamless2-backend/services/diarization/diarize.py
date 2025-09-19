# services/diarization/diarize.py (high-level)
from pyannote.audio import Pipeline
import json, os, argparse

def diarize(input_wav, meeting_id, out_dir='./storage/meetings'):
    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization", use_auth_token="YOUR_HF_TOKEN")
    diarization = pipeline(input_wav)
    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({'start': turn.start, 'end': turn.end, 'speaker': speaker})
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{meeting_id}.diarization.json")
    with open(out_path, 'w') as f:
        json.dump({'segments': segments}, f, indent=2)
