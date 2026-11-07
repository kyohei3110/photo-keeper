// Googleフォト（Picker API）連携の写真保存サービス
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// --- .env を簡易読み込み（依存を増やさないため自前） ---
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) {}

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BASE_URL = 'http://localhost:3000',
  ALLOWED_EMAILS = '',
  SESSION_SECRET = crypto.randomBytes(32).toString('hex'),
  PORT = 3000,
} = process.env;

const allowed = ALLOWED_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
].join(' ');
const PICKER = 'https://photospicker.googleapis.com/v1';

// --- 保存先 ---
const DATA_DIR = path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const loadIndex = () => {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; }
};
const saveIndex = (items) => {
  fs.writeFileSync(INDEX_FILE + '.tmp', JSON.stringify(items, null, 2));
  fs.renameSync(INDEX_FILE + '.tmp', INDEX_FILE);
};

// --- アプリ ---
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: BASE_URL.startsWith('https://'),
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'ログインしてください' });
  next();
};

// アクセストークン取得（期限切れならリフレッシュ）
async function getAccessToken(req) {
  const t = req.session.tokens;
  if (!t) throw new Error('no tokens');
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) throw new Error('再ログインが必要です');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: t.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('トークン更新に失敗しました。再ログインしてください');
  t.accessToken = j.access_token;
  t.expiresAt = Date.now() + j.expires_in * 1000;
  return t.accessToken;
}

// --- 認証 ---
app.get('/auth/login', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です（.env を確認）');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) return res.status(400).send('不正なリクエストです');
    delete req.session.oauthState;

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await r.json();
    if (!r.ok) return res.status(400).send('認証に失敗しました: ' + (tok.error_description || tok.error));

    const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    })).json();
    const email = (u.email || '').toLowerCase();
    if (!allowed.includes(email)) return res.status(403).send(`このアカウント(${email})は許可されていません`);

    req.session.user = { email, name: u.name || email, picture: u.picture };
    req.session.tokens = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
    };
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('ログイン処理でエラーが発生しました');
  }
});

app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// --- Googleフォト Picker ---
// 1) セッション作成 → ユーザーに pickerUri を開かせる
app.post('/api/picker/start', requireLogin, async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const r = await fetch(`${PICKER}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickingConfig: { maxItemCount: '200' } }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'Picker開始に失敗しました' });
    res.json({
      id: j.id,
      pickerUri: j.pickerUri + '/autoclose',
      pollIntervalMs: Math.max(2000, parseFloat(j.pollingConfig?.pollInterval || '5') * 1000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2) 選択完了をポーリング
app.get('/api/picker/:id', requireLogin, async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const r = await fetch(`${PICKER}/sessions/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || '状態取得に失敗しました' });
    res.json({ mediaItemsSet: !!j.mediaItemsSet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const extFromMime = (m = '') =>
  ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/gif': '.gif',
     'video/mp4': '.mp4', 'video/quicktime': '.mov' }[m.toLowerCase()] || '');

// 3) 選ばれた写真をダウンロードして保存
app.post('/api/picker/:id/import', requireLogin, async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const sid = req.params.id;

    // 一覧取得（ページング）
    const items = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ sessionId: sid, pageSize: '100' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await fetch(`${PICKER}/mediaItems?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ error: j.error?.message || '一覧取得に失敗しました' });
      items.push(...(j.mediaItems || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);

    const index = loadIndex();
    const have = new Set(index.map((x) => x.googleId));
    let saved = 0, skipped = 0, failed = 0;

    for (const it of items) {
      if (have.has(it.id)) { skipped++; continue; }
      try {
        const isVideo = it.type === 'VIDEO';
        // baseUrl は Authorization ヘッダー付きで取得。=d で元データ（動画は =dv）
        const resp = await fetch(it.mediaFile.baseUrl + (isVideo ? '=dv' : '=d'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok || !resp.body) throw new Error('download ' + resp.status);

        const id = crypto.randomUUID();
        const origName = it.mediaFile.filename || '';
        const ext = path.extname(origName) || extFromMime(it.mediaFile.mimeType);
        const file = id + ext;
        await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(path.join(PHOTO_DIR, file)));

        index.push({
          id,
          googleId: it.id,
          file,
          name: origName || file,
          type: isVideo ? 'VIDEO' : 'PHOTO',
          mimeType: it.mediaFile.mimeType,
          takenAt: it.createTime || null,
          savedAt: new Date().toISOString(),
        });
        saved++;
      } catch (e) {
        console.error('import failed', it.id, e.message);
        failed++;
      }
    }
    saveIndex(index);

    // 後始末：Pickerセッション削除
    fetch(`${PICKER}/sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});

    res.json({ saved, skipped, failed, total: items.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- 保存済み写真 ---
app.get('/api/photos', requireLogin, (req, res) => {
  const list = loadIndex().sort((a, b) => (b.takenAt || b.savedAt).localeCompare(a.takenAt || a.savedAt));
  res.json({ photos: list });
});

app.get('/files/:file', requireLogin, (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(PHOTO_DIR, file);
  if (!fs.existsSync(full)) return res.sendStatus(404);
  res.sendFile(full);
});

app.delete('/api/photos/:id', requireLogin, (req, res) => {
  const index = loadIndex();
  const hit = index.find((x) => x.id === req.params.id);
  if (!hit) return res.sendStatus(404);
  try { fs.unlinkSync(path.join(PHOTO_DIR, hit.file)); } catch (_) {}
  saveIndex(index.filter((x) => x.id !== hit.id));
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`photo-keeper: ${BASE_URL} (port ${PORT})`));
