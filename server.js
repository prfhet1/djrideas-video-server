const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const gTTS = require('gtts');

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

// TTS using gTTS (Google Translate TTS via Node.js wrapper)
app.post('/tts', async (req, res) => {
  const tmpDir = os.tmpdir();
  const jobId = Date.now();
  const mp3Path = path.join(tmpDir, `tts_${jobId}.mp3`);

  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    // Split into chunks of 180 chars max
    const words = text.split(' ');
    const chunks = [];
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > 170) {
        if (current) chunks.push(current.trim());
        current = word;
      } else {
        current = (current + ' ' + word).trim();
      }
    }
    if (current) chunks.push(current.trim());

    // Generate audio for each chunk and combine
    const chunkFiles = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(tmpDir, `chunk_${jobId}_${i}.mp3`);
      await new Promise((resolve, reject) => {
        const gtts = new gTTS(chunks[i], 'en');
        gtts.save(chunkPath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      chunkFiles.push(chunkPath);
    }

    // Combine chunks with FFmpeg
    let finalPath;
    if (chunkFiles.length === 1) {
      finalPath = chunkFiles[0];
    } else {
      finalPath = mp3Path;
      const listFile = path.join(tmpDir, `list_${jobId}.txt`);
      fs.writeFileSync(listFile, chunkFiles.map(f => `file '${f}'`).join('\n'));
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(finalPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      fs.unlinkSync(listFile);
      chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    }

    const audioBuffer = fs.readFileSync(finalPath);
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

// Video creation — image + audio → MP4
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
          '-c:v libx264',
          '-tune stillimage',
          '-c:a aac',
          '-b:a 128k',
          '-pix_fmt yuv420p',
          '-shortest',
          '-movflags +faststart',
          '-vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const mp4Buffer = fs.readFileSync(outputPath);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="trade-video.mp4"',
      'Content-Length': mp4Buffer.length,
      'Access-Control-Allow-Origin': '*'
    });
    res.send(mp4Buffer);

  } catch(err) {
    console.error('Video error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    [imagePath, audioPath, outputPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
    });
  }
});

app.listen(PORT, () => {
  console.log(`Video server running on port ${PORT}`);
});
