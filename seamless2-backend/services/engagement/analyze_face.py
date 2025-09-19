# analyze_face.py - basic attention detection using mediapipe
import cv2, mediapipe as mp, argparse, json, os
mp_face = mp.solutions.face_mesh

def analyze_video(video_path, meeting_id, out_dir='./storage/meetings'):
    cap = cv2.VideoCapture(video_path)
    face_mesh = mp_face.FaceMesh(static_image_mode=False, max_num_faces=1)
    frame_idx = 0
    face_count = 0
    eye_open_count = 0
    total_frames = 0
    while True:
        ok, frame = cap.read()
        if not ok: break
        total_frames += 1
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = face_mesh.process(rgb)
        if results.multi_face_landmarks:
            face_count += 1
            # naive attention: if landmarks found, assume face present and looking somewhat forward
            # more advanced: compute eye aspect ratio or head pose
        frame_idx += 1
    score = face_count / total_frames if total_frames else 0
    out = {'frames': total_frames, 'face_frames': face_count, 'attention_score': round(score,3)}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{meeting_id}.engagement.json"), 'w') as f:
        json.dump(out, f, indent=2)
    print("saved engagement", out)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', required=True)
    parser.add_argument('--meeting', required=True)
    args = parser.parse_args()
    analyze_video(args.video, args.meeting)
