const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DJR Ideas Video Server running' });
});

// Fetch a URL and return buffer
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com',
        'Accept': '*/*'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// TTS — Microsoft Edge Neural Voice via edge-tts-universal
// Free, no API key, no credit card, no limits
// Uses en-US-GuyNeural — confident American male voice
app.post('/tts', async (req, res) => {
  const tmpDir = os.tmpdir();
  const jobId = Date.now();
  const mp3Path = path.join(tmpDir, `tts_${jobId}.mp3`);

  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    console.log('TTS request, length:', text.length);

    // edge-tts-universal uses Communicate class
    const { Communicate } = require('edge-tts-universal');
    const communicate = new Communicate(text, { voice: 'en-US-GuyNeural' });
    const chunks = [];
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        chunks.push(chunk.data);
      }
    }
    const audioData = Buffer.concat(chunks);
    fs.writeFileSync(mp3Path, audioData);

    const audioBuffer = fs.readFileSync(mp3Path);
    console.log('TTS done, size:', audioBuffer.length);

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Access-Control-Allow-Origin': '*'
    });
    res.send(audioBuffer);

  } catch(err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch(e) {}
  }
});


// Video creation
app.post('/create-video', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const tmpDir = os.tmpdir();
  const jobId = Date.now();
  const imagePath = path.join(tmpDir, `image_${jobId}.jpg`);
  const audioPath = path.join(tmpDir, `audio_${jobId}.mp3`);
  const outputPath = path.join(tmpDir, `output_${jobId}.mp4`);

  try {
    if (!req.files || !req.files.image || !req.files.audio) {
      return res.status(400).json({ error: 'Missing image or audio' });
    }

    fs.writeFileSync(imagePath, req.files.image[0].buffer);
    fs.writeFileSync(audioPath, req.files.audio[0].buffer);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop 1'])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264', '-tune stillimage', '-preset ultrafast', '-crf 28',
          '-c:a aac', '-b:a 96k', '-pix_fmt yuv420p', '-shortest', '-movflags +faststart',
          '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const mp4Buffer = fs.readFileSync(outputPath);
    res.set({ 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="trade-video.mp4"', 'Content-Length': mp4Buffer.length, 'Access-Control-Allow-Origin': '*' });
    res.send(mp4Buffer);

  } catch(err) {
    console.error('Video error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    [imagePath, audioPath, outputPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
  }
});

app.listen(PORT, () => console.log(`Video server running on port ${PORT}`));
