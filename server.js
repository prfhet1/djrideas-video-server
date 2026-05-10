const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

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

// TTS using espeak-ng — installed on Render's Linux environment
app.post('/tts', async (req, res) => {
  const tmpDir = os.tmpdir();
  const jobId = Date.now();
  const wavPath = path.join(tmpDir, `tts_${jobId}.wav`);
  const mp3Path = path.join(tmpDir, `tts_${jobId}.mp3`);

  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    // Write text to file to avoid shell escaping issues
    const textFile = path.join(tmpDir, `text_${jobId}.txt`);
    fs.writeFileSync(textFile, text);

    // Use espeak-ng — available on Render's Ubuntu environment
    // -v en-us+m3 = male voice, -s 145 = speed, -p 40 = pitch
    await new Promise((resolve, reject) => {
      exec(
        `espeak-ng -v en-us+m3 -s 145 -p 40 -f "${textFile}" -w "${wavPath}"`,
        (err, stdout, stderr) => {
          if (err) reject(new Error('espeak error: ' + stderr));
          else resolve();
        }
      );
    });

    // Convert WAV to MP3 using FFmpeg for better quality
    await new Promise((resolve, reject) => {
      ffmpeg(wavPath)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .output(mp3Path)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const audioBuffer = fs.readFileSync(mp3Path);
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
    [wavPath, mp3Path, path.join(os.tmpdir(), `text_${jobId}.txt`)]
      .forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
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
