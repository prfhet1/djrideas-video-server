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
// Supports multiple voices per persona
app.post('/tts', async (req, res) => {
  const tmpDir = os.tmpdir();
  const jobId = Date.now();
  const mp3Path = path.join(tmpDir, `tts_${jobId}.mp3`);

  try {
    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    // Allowed voices — mapped to personas
    const allowedVoices = [
      'en-US-GuyNeural',    // Technical — confident American male
      'en-US-AriaNeural',   // Fundamental — warm authoritative female
      'en-US-DavisNeural',  // Educational — friendly approachable male
      'en-US-TonyNeural',   // bonus option
      'en-US-JasonNeural',  // bonus option
    ];
    const selectedVoice = allowedVoices.includes(voice) ? voice : 'en-US-GuyNeural';

    console.log(`TTS request — voice: ${selectedVoice}, length: ${text.length}`);

    const { Communicate } = require('edge-tts-universal');

    // Retry up to 3 times — Microsoft Edge TTS can transiently fail
    let audioData = null;
    let lastError = null;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`TTS attempt ${attempt}/${MAX_RETRIES}...`);
        const communicate = new Communicate(text, { voice: selectedVoice });
        const chunks = [];
        for await (const chunk of communicate.stream()) {
          if (chunk.type === 'audio' && chunk.data) {
            chunks.push(chunk.data);
          }
        }
        if (chunks.length === 0) throw new Error('No audio was received.');
        audioData = Buffer.concat(chunks);
        console.log(`TTS attempt ${attempt} succeeded — size: ${audioData.length}`);
        break; // success — exit retry loop
      } catch (err) {
        lastError = err;
        console.warn(`TTS attempt ${attempt} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          // Wait 1.5s before retrying
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    if (!audioData || audioData.length === 0) {
      throw new Error(`TTS failed after ${MAX_RETRIES} attempts: ${lastError?.message || 'No audio received'}`);
    }

    fs.writeFileSync(mp3Path, audioData);
    const audioBuffer = fs.readFileSync(mp3Path);
    console.log(`TTS done — voice: ${selectedVoice}, size: ${audioBuffer.length}`);

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


// YouTube upload proxy — browser can't call Google directly due to coi-serviceworker CORS
// Server calls Google on behalf of the browser
const https = require('https');

app.post('/upload-youtube', upload.single('video'), async (req, res) => {
  try {
    const { apiKey, title, description, category } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Missing video file' });
    if (!apiKey)   return res.status(400).json({ error: 'Missing API key' });

    console.log(`YouTube upload — title: "${title}", size: ${req.file.size}`);

    const metadata = {
      snippet: {
        title,
        description,
        categoryId: category || '27',
        tags: ['swing trading', 'stock market education', 'technical analysis', 'educational']
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    };

    const boundary = '-------DJRideasBoundary314159';
    const CRLF = '\r\n';
    const metaStr = JSON.stringify(metadata);
    const metaPart = Buffer.from(
      `--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metaStr}${CRLF}` +
      `--${boundary}${CRLF}Content-Type: video/mp4${CRLF}${CRLF}`
    );
    const closePart = Buffer.from(`${CRLF}--${boundary}--`);
    const body = Buffer.concat([metaPart, req.file.buffer, closePart]);

    const options = {
      hostname: 'www.googleapis.com',
      path: `/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status&key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary="${boundary}"`,
        'Content-Length': body.length
      }
    };

    const result = await new Promise((resolve, reject) => {
      const req2 = https.request(options, (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: r.statusCode, body: JSON.parse(text) }); }
          catch(e) { resolve({ status: r.statusCode, body: { raw: text } }); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (result.status >= 400) {
      const msg = result.body?.error?.message || result.body?.raw || 'YouTube upload failed';
      console.error('YouTube error:', msg);
      return res.status(result.status).json({ error: msg });
    }

    console.log('YouTube upload success — id:', result.body.id);
    res.json({ success: true, videoId: result.body.id, url: `https://youtu.be/${result.body.id}` });

  } catch(err) {
    console.error('Upload proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
