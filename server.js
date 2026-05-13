const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const querystring = require('querystring');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cookie parser (simple inline — no extra dep needed)
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
});

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ─── Health ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DJR Ideas Video Server running' });
});

// ─── TTS ─────────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  const tmpDir = os.tmpdir();
  const jobId = Date.now();
  const mp3Path = path.join(tmpDir, `tts_${jobId}.mp3`);

  try {
    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const allowedVoices = [
      'en-US-GuyNeural',
      'en-US-AriaNeural',
      'en-US-DavisNeural',
      'en-US-TonyNeural',
      'en-US-JasonNeural',
    ];
    const selectedVoice = allowedVoices.includes(voice) ? voice : 'en-US-GuyNeural';
    console.log(`TTS request — voice: ${selectedVoice}, length: ${text.length}`);

    const { Communicate } = require('edge-tts-universal');
    let audioData = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`TTS attempt ${attempt}/3...`);
        const communicate = new Communicate(text, { voice: selectedVoice });
        const chunks = [];
        for await (const chunk of communicate.stream()) {
          if (chunk.type === 'audio' && chunk.data) chunks.push(chunk.data);
        }
        if (chunks.length === 0) throw new Error('No audio was received.');
        audioData = Buffer.concat(chunks);
        break;
      } catch (err) {
        lastError = err;
        console.warn(`TTS attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
      }
    }

    if (!audioData || audioData.length === 0) {
      throw new Error(`TTS failed after 3 attempts: ${lastError?.message}`);
    }

    fs.writeFileSync(mp3Path, audioData);
    const audioBuffer = fs.readFileSync(mp3Path);
    console.log(`TTS done — size: ${audioBuffer.length}`);

    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length, 'Access-Control-Allow-Origin': '*' });
    res.send(audioBuffer);

  } catch(err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch(e) {}
  }
});

// ─── YouTube OAuth 2.0 ────────────────────────────────────
const OAUTH_REDIRECT = 'https://djrideas-video-server.onrender.com/oauth/callback';
const OAUTH_SCOPES   = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

// Temporary in-memory token store — cleared after pickup
const pendingTokens = new Map();

// Poll endpoint — browser checks this after popup opens
app.get('/oauth/token-ready', (req, res) => {
  const entry = [...pendingTokens.values()][0];
  if (entry) {
    pendingTokens.clear();
    return res.json(entry);
  }
  res.json({});
});

// Step 1 — browser sends client_id + secret, we store in cookies and redirect to Google
app.get('/oauth/start', (req, res) => {
  const clientId     = req.query.client_id;
  const clientSecret = req.query.client_secret;
  if (!clientId || !clientSecret) return res.status(400).send('Missing client_id or client_secret');

  // Store in httpOnly cookies so callback can use them
  const cookieOpts = 'HttpOnly; SameSite=Lax; Path=/; Max-Age=300';
  res.setHeader('Set-Cookie', [
    `oauth_cid=${encodeURIComponent(clientId)}; ${cookieOpts}`,
    `oauth_cs=${encodeURIComponent(clientSecret)}; ${cookieOpts}`
  ]);

  const params = querystring.stringify({
    client_id:     clientId,
    redirect_uri:  OAUTH_REDIRECT,
    response_type: 'code',
    scope:         OAUTH_SCOPES,
    access_type:   'offline',
    prompt:        'consent'
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});

// Step 2 — Google redirects back with ?code=
app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  const closeWithError = (msg) => res.send(
    `<script>window.opener&&window.opener.postMessage({type:'youtube-auth-error',error:${JSON.stringify(msg)}},'*');window.close();</script>`
  );

  if (error || !code) return closeWithError(error || 'cancelled');

  const clientId     = decodeURIComponent(req.cookies.oauth_cid     || '');
  const clientSecret = decodeURIComponent(req.cookies.oauth_cs      || '');

  if (!clientId || !clientSecret) return closeWithError('Session expired — please try connecting again');

  try {
    // Exchange code for tokens
    const tokenBody = querystring.stringify({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  OAUTH_REDIRECT,
      grant_type:    'authorization_code'
    });

    const tokenData = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) }
      }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
      });
      r.on('error', reject); r.write(tokenBody); r.end();
    });

    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Fetch channel info
    const channelData = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'www.googleapis.com',
        path: '/youtube/v3/channels?part=snippet&mine=true',
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });

    const channel     = channelData.items?.[0];
    const channelName = channel?.snippet?.title || 'My Channel';
    const avatar      = channel?.snippet?.thumbnails?.default?.url || '';

    // Store for polling fallback (in case postMessage is blocked)
    const tokenPayload = {
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      channelName,
      avatar
    };
    pendingTokens.set('latest', tokenPayload);
    // Auto-clear after 2 minutes if not picked up
    setTimeout(() => pendingTokens.delete('latest'), 120000);

    res.send(`<!DOCTYPE html><html><body><script>
      try {
        window.opener && window.opener.postMessage({
          type:         'youtube-auth-success',
          accessToken:  ${JSON.stringify(tokenData.access_token)},
          refreshToken: ${JSON.stringify(tokenData.refresh_token || '')},
          channelName:  ${JSON.stringify(channelName)},
          avatar:       ${JSON.stringify(avatar)}
        }, '*');
      } catch(e) {}
      setTimeout(() => window.close(), 500);
    </script><p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#22c55e;">✓ Connected! You can close this window.</p></body></html>`);

  } catch(err) {
    console.error('OAuth error:', err.message);
    closeWithError(err.message);
  }
});

// ─── YouTube Upload ───────────────────────────────────────
app.post('/upload-youtube', upload.single('video'), async (req, res) => {
  try {
    const { accessToken, title, description, category } = req.body;
    if (!req.file)    return res.status(400).json({ error: 'Missing video file' });
    if (!accessToken) return res.status(401).json({ error: 'Not authenticated — connect YouTube in Settings' });

    console.log(`YouTube upload — "${title}", ${req.file.size} bytes`);

    const metadata = {
      snippet: { title, description, categoryId: category || '27', tags: ['swing trading','stock market education','technical analysis'] },
      status:  { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    };

    const boundary = '---DJRBoundary9265358979';
    const CRLF = '\r\n';
    const metaPart = Buffer.from(
      `--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}` +
      JSON.stringify(metadata) + `${CRLF}--${boundary}${CRLF}Content-Type: video/mp4${CRLF}${CRLF}`
    );
    const body = Buffer.concat([metaPart, req.file.buffer, Buffer.from(`${CRLF}--${boundary}--`)]);

    const result = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'www.googleapis.com',
        path: '/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
          'Content-Length': body.length
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
          catch(e) { resolve({ status: res.statusCode, body: { raw: text } }); }
        });
      });
      r.on('error', reject); r.write(body); r.end();
    });

    if (result.status === 401) return res.status(401).json({ error: 'Token expired — reconnect YouTube in Settings' });
    if (result.status >= 400) {
      const msg = result.body?.error?.message || result.body?.raw || 'Upload failed';
      return res.status(result.status).json({ error: msg });
    }

    console.log('Upload success — id:', result.body.id);
    res.json({ success: true, videoId: result.body.id, url: `https://youtu.be/${result.body.id}` });

  } catch(err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Video server running on port ${PORT}`));
