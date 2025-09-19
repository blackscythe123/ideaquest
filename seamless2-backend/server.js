// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const uploadDir = process.env.UPLOAD_DIR || './storage/uploads';
fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

// POST /api/upload - accepts wav or mp4
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    const meetingId = uuidv4();
    const savePath = path.join(uploadDir, meetingId + path.extname(file.filename));
    fs.renameSync(file.path, savePath);

    // If .mp4 -> extract audio to wav (ffmpeg)
    const ext = path.extname(savePath).toLowerCase();
    let audioPath = savePath;
    if (ext === '.mp4' || ext === '.mkv' || ext === '.mov') {
      const wavPath = path.join(uploadDir, `${meetingId}.wav`);
      // synchronous ffmpeg spawn (better to do async job queue)
      await runFfmpegExtract(savePath, wavPath);
      audioPath = wavPath;
    }

    // Kick off transcription (fire-and-forget) - do not block upload response
    // The python script will produce JSON output file in meeting results folder
    spawnPythonTranscriber(audioPath, meetingId).catch((e) => console.error('Transcriber error', e));

    return res.json({ meetingId, status: 'processing' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'upload failed' });
  }
});

app.get('/api/transcript/:meetingId', (req, res) => {
  const meetingId = req.params.meetingId;
  const resultPath = path.join(process.env.MEETING_DIR || './storage/meetings', `${meetingId}.transcript.json`);
  if (!fs.existsSync(resultPath)) return res.json({ status: 'pending' });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  return res.json({ status: 'done', result });
});

async function runFfmpegExtract(input, output) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffmpeg = spawn(ffmpegBin, ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', output]);
    ffmpeg.on('close', (code) => { code === 0 ? resolve() : reject(new Error('ffmpeg failed')); });
  });
}

async function spawnPythonTranscriber(audioPath, meetingId) {
  return new Promise((resolve, reject) => {
    let defaultPy = process.platform === 'win32' ? 'python' : 'python3';
    // Prefer project venv python if present
    try {
      const winVenv = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
      const nixVenv = path.join(__dirname, 'venv', 'bin', 'python');
      if (process.platform === 'win32' && fs.existsSync(winVenv)) defaultPy = winVenv;
      if (process.platform !== 'win32' && fs.existsSync(nixVenv)) defaultPy = nixVenv;
    } catch (_) {}
    const py = process.env.ASR_PYTHON || defaultPy;
    const args = ['services/asr/transcribe.py', '--input', audioPath, '--meeting', meetingId];
    const pyProcess = spawn(py, args, { stdio: ['ignore','pipe','pipe'] });
    let out = '';
    pyProcess.stdout.on('data', (data) => { out += data.toString(); });
    pyProcess.stderr.on('data', (d) => console.error('PYERR', d.toString()));
    pyProcess.on('close', (code) => {
      if (code === 0) resolve(out); else reject(new Error('transcriber failed'));
    });
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
