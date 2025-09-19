# services/summarizer/summarize.py
from transformers import pipeline
import json, os, argparse

def summarize_text(text, meeting_id, out_dir='./storage/meetings'):
    summarizer = pipeline("summarization", model="facebook/bart-large-cnn")
    # split long text if needed
    summary = summarizer(text, max_length=200, min_length=40, do_sample=False)[0]['summary_text']
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{meeting_id}.summary.json")
    with open(out_path, 'w') as f:
        json.dump({'summary': summary}, f, indent=2)
    print("saved summary")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--text', required=False)
    parser.add_argument('--meeting', required=True)
    args = parser.parse_args()
    # read transcript
    with open(f'./storage/meetings/{args.meeting}.transcript.json','r') as f:
        t = json.load(f)
    summarize_text(t['transcript'], args.meeting)
