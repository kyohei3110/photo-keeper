// Googleフォト（Picker API）→ Googleドライブに保存する個人用サービス
// サーバー側にはデータを持たない（無料ホスティングでも写真が消えない）
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// --- .env を簡易読み込み ---
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
  DRIVE_FOLDER_NAME = 'フォトキーパー',
} = process.env;

const allowed = ALLOWED_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  'https://www.googleapis.com/auth/drive.file', // このアプリが作ったファイルだけ触れる
].join(' ');
const PICKER = 'https://photospicker.googleapis.com/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MAX_BYTES = 150 * 1024 * 1024; // 1ファイルの上限（無料枠のメモリ対策）
const ID_RE = /^[A-Za-z0-9_-]+$/;

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
async function getAccessToken(sess) {
  const t = sess.tokens;
  if (!t) throw new Error('再ログインが必要です');
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
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です');
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

    // 付与されたスコープが足りているか確認（チェックを外された場合）
    const granted = (tok.scope || '').split(' ');
    if (!granted.includes('https://www.googleapis.com/auth/drive.file') ||
        !granted.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly')) {
      return res.status(400).send('Googleフォトとドライブの両方の許可が必要です。もう一度ログインして、すべてにチェックを入れてください');
    }

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

// --- Googleドライブ ---
async function drive(token, url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return r;
}

// 保存先フォルダ（なければ作る）。drive.file スコープなので、このアプリが作ったものだけ見える
async function ensureFolder(sess, token) {
  if (sess.folderId) return sess.folderId;
  const q = `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await drive(token, `${DRIVE}/files?` + new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' }));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'ドライブのフォルダ確認に失敗しました');
  let id = j.files?.[0]?.id;
  if (!id) {
    const c = await drive(token, `${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    const cj = await c.json();
    if (!c.ok) throw new Error(cj.error?.message || 'ドライブのフォルダ作成に失敗しました');
    id = cj.id;
  }
  sess.folderId = id;
  return id;
}

async function listFolder(sess, token) {
  const folderId = await ensureFolder(sess, token);
  const files = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,createdTime,appProperties)',
      pageSize: '1000',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await drive(token, `${DRIVE}/files?${p}`);
    const j = await r.json();
    if (!r.ok) {
      if (r.status === 404) delete sess.folderId;
      throw new Error(j.error?.message || '一覧取得に失敗しました');
    }
    files.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function uploadToDrive(token, folderId, { name, mime, gid, takenAt, data }) {
  const init = await drive(token, `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime || 'application/octet-stream',
      'X-Upload-Content-Length': String(data.length),
    },
    body: JSON.stringify({ name, parents: [folderId], appProperties: { gid, takenAt: takenAt || '' } }),
  });
  if (!init.ok) throw new Error('upload init ' + init.status);
  const loc = init.headers.get('location');
  const put = await fetch(loc, {
    method: 'PUT',
    headers: { 'Content-Type': mime || 'application/octet-stream', 'Content-Length': String(data.length) },
    body: data,
  });
  if (!put.ok) throw new Error('upload ' + put.status);
}

// --- Googleフォト Picker ---
app.post('/api/picker/start', requireLogin, async (req, res) => {
  try {
    const token = await getAccessToken(req.session);
    await ensureFolder(req.session, token); // 先にフォルダを用意
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

app.get('/api/picker/:id', requireLogin, async (req, res) => {
  try {
    const token = await getAccessToken(req.session);
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

// 取り込みはバックグラウンドで実行し、進捗をポーリングで返す（長時間リクエストを避ける）
const jobs = new Map(); // sessionId(picker) -> progress

app.post('/api/picker/:id/import', requireLogin, async (req, res) => {
  const sid = req.params.id;
  if (jobs.get(sid) && !jobs.get(sid).finished) return res.json({ started: true });
  const sess = req.session;
  const job = { total: 0, done: 0, saved: 0, skipped: 0, failed: 0, finished: false, error: null, owner: sess.user.email };
  jobs.set(sid, job);
  res.json({ started: true });

  (async () => {
    try {
      let token = await getAccessToken(sess);
      const folderId = await ensureFolder(sess, token);

      const items = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({ sessionId: sid, pageSize: '100' });
        if (pageToken) q.set('pageToken', pageToken);
        const r = await fetch(`${PICKER}/mediaItems?${q}`, { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || '一覧取得に失敗しました');
        items.push(...(j.mediaItems || []));
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      job.total = items.length;

      const have = new Set((await listFolder(sess, token)).map((f) => f.appProperties?.gid).filter(Boolean));

      for (const it of items) {
        const gid = crypto.createHash('sha1').update(it.id).digest('hex');
        try {
          if (have.has(gid)) { job.skipped++; continue; }
          token = await getAccessToken(sess);
          const isVideo = it.type === 'VIDEO';
          const resp = await fetch(it.mediaFile.baseUrl + (isVideo ? '=dv' : '=d'), {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) throw new Error('download ' + resp.status);
          const len = Number(resp.headers.get('content-length') || 0);
          if (len > MAX_BYTES) throw new Error('too large');
          const data = Buffer.from(await resp.arrayBuffer());
          if (data.length > MAX_BYTES) throw new Error('too large');
          await uploadToDrive(token, folderId, {
            name: it.mediaFile.filename || `${it.id.slice(0, 12)}`,
            mime: it.mediaFile.mimeType,
            gid,
            takenAt: it.createTime,
            data,
          });
          have.add(gid);
          job.saved++;
        } catch (e) {
          console.error('import failed', e.message);
          job.failed++;
        } finally {
          job.done++;
        }
      }
      fetch(`${PICKER}/sessions/${encodeURIComponent(sid)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    } catch (e) {
      console.error(e);
      job.error = e.message;
    } finally {
      job.finished = true;
      setTimeout(() => jobs.delete(sid), 10 * 60 * 1000);
    }
  })();
});

app.get('/api/picker/:id/progress', requireLogin, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== req.session.user.email) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// --- 保存済み写真（ドライブ上のフォルダを一覧） ---
app.get('/api/photos', requireLogin, async (req, res) => {
  try {
    const token = await getAccessToken(req.session);
    const files = await listFolder(req.session, token);
    const photos = files
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: (f.mimeType || '').startsWith('video/') ? 'VIDEO' : 'PHOTO',
        mimeType: f.mimeType,
        takenAt: f.appProperties?.takenAt || f.createdTime,
      }))
      .sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
    res.json({ photos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 原本（動画のRange再生にも対応）
app.get('/files/:id', requireLogin, async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.sendStatus(400);
    const token = await getAccessToken(req.session);
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await drive(token, `${DRIVE}/files/${req.params.id}?alt=media`, { headers });
    res.status(r.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (!r.body) return res.end();
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    if (!res.headersSent) res.sendStatus(500); else res.end();
  }
});

// サムネイル（なければ原本へ）
app.get('/thumb/:id', requireLogin, async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.sendStatus(400);
    const token = await getAccessToken(req.session);
    const m = await (await drive(token, `${DRIVE}/files/${req.params.id}?fields=thumbnailLink`)).json();
    if (m.thumbnailLink) {
      const r = await fetch(m.thumbnailLink.replace(/=s\d+$/, '=s400'));
      if (r.ok && r.body) {
        res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return await pipeline(Readable.fromWeb(r.body), res);
      }
    }
    res.redirect(`/files/${req.params.id}`);
  } catch (e) {
    if (!res.headersSent) res.sendStatus(500); else res.end();
  }
});

app.delete('/api/photos/:id', requireLogin, async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.sendStatus(400);
    const token = await getAccessToken(req.session);
    const r = await drive(token, `${DRIVE}/files/${req.params.id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) return res.status(502).json({ error: '削除に失敗しました' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`photo-keeper: ${BASE_URL} (port ${PORT})`));
