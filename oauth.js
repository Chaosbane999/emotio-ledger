// Minimal OAuth 2.1 provider so MCP clients that require OAuth (claude.ai,
// ChatGPT etc.) can connect to /mcp. Dynamic client registration, PKCE
// (S256), authorization codes, bearer access tokens. The consent step is the
// admin passcode — the same one that signs in to the app — so an OAuth token
// carries exactly what knowing the passcode carries: admin, money visible.
const crypto = require('crypto');
const { db, get } = require('./db');

const ENV_PASSCODE = process.env.APP_PASSCODE || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://capacity.emotioflow.com').replace(/\/$/, '');

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const rand = () => crypto.randomBytes(32).toString('hex');
const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Same verification as the login gate: scrypt record from the database, env
// passcode as the fresh-install fallback.
function passcodeOk(candidate) {
  const rec = get('passcode_hash') || '';
  if (rec) {
    const [salt, want] = rec.split(':');
    if (!salt || !want) return false;
    const got = crypto.scryptSync(String(candidate), salt, 32).toString('hex');
    const a = Buffer.from(got, 'hex'); const b = Buffer.from(want, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ENV_PASSCODE) return true;
  const a = Buffer.from(String(candidate)); const b = Buffer.from(ENV_PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function asMetadata(req, res) {
  res.json({
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${PUBLIC_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['mcp'],
  });
}

function prMetadata(req, res) {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
}

function register(req, res) {
  const b = req.body || {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) =>
    /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) : [];
  if (!uris.length) {
    return res.status(400).json({ error: 'invalid_client_metadata',
      error_description: 'redirect_uris (https) required' });
  }
  const id = rand();
  db.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES (?,?,?)')
    .run(id, String(b.client_name || '').slice(0, 100), JSON.stringify(uris));
  res.status(201).json({
    client_id: id,
    client_name: b.client_name || '',
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

function clientAndUri(clientId, redirectUri) {
  const c = db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId || '');
  if (!c) return null;
  if (!JSON.parse(c.redirect_uris).includes(redirectUri || '')) return null;
  return c;
}

function authorizeForm(req, res) {
  const q = req.query;
  const c = clientAndUri(q.client_id, q.redirect_uri);
  if (!c || q.response_type !== 'code') {
    return res.status(400).send('<p>Invalid authorization request.</p>');
  }
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge',
    'code_challenge_method', 'scope', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] || '')}">`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>EmotioHours — allow access</title></head>
    <body style="font-family:-apple-system,sans-serif;background:#f0f5f4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
    <form method="POST" action="/oauth/authorize" style="background:#fff;border:1px solid #e2e8e6;border-radius:16px;padding:40px;width:340px;text-align:center;box-shadow:0 4px 14px rgba(40,44,52,.06)">
      <div style="font-weight:700;font-size:24px">Emotio<span style="color:#14867d">Hours</span></div>
      <p style="color:#6d7480;font-size:14px"><strong>${esc(c.name || 'An application')}</strong>
        wants read-only access to capacity, plans and logged time — including
        rates and contract values. Enter the admin passcode to allow it.</p>
      ${hidden}
      <input type="password" name="passcode" placeholder="Admin passcode" autofocus style="width:100%;padding:9px 12px;border:1px solid #e2e8e6;border-radius:9px;margin:12px 0;text-align:center;box-sizing:border-box">
      <button type="submit" style="width:100%;background:#14867d;color:#fff;border:none;border-radius:9px;padding:10px;font-size:14px;font-weight:600;cursor:pointer">Allow access</button>
    </form></body></html>`);
}

function authorizeSubmit(req, res) {
  const b = req.body || {};
  const c = clientAndUri(b.client_id, b.redirect_uri);
  if (!c) return res.status(400).send('<p>Invalid authorization request.</p>');
  if (!passcodeOk(b.passcode || '')) {
    return res.status(401).send('<p>Wrong passcode. <a href="javascript:history.back()">Try again</a>.</p>');
  }
  const code = rand();
  db.prepare('INSERT INTO oauth_codes (code, client_id, redirect_uri, challenge, expires) VALUES (?,?,?,?,?)')
    .run(code, b.client_id, b.redirect_uri, b.code_challenge || null,
      Date.now() + 10 * 60 * 1000);
  const url = new URL(b.redirect_uri);
  url.searchParams.set('code', code);
  if (b.state) url.searchParams.set('state', b.state);
  res.redirect(url.toString());
}

function token(req, res) {
  const b = req.body || {};
  const issue = (clientId) => {
    const access = rand(); const refresh = rand();
    const ins = db.prepare('INSERT INTO oauth_tokens (token, kind, client_id) VALUES (?,?,?)');
    ins.run(access, 'access', clientId);
    ins.run(refresh, 'refresh', clientId);
    res.json({ access_token: access, token_type: 'bearer',
      expires_in: 31536000, refresh_token: refresh, scope: 'mcp' });
  };
  if (b.grant_type === 'authorization_code') {
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code=?').get(b.code || '');
    if (!row || row.used || row.expires < Date.now() ||
        row.client_id !== (b.client_id || '') ||
        (b.redirect_uri && row.redirect_uri !== b.redirect_uri)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (row.challenge && s256(b.code_verifier || '') !== row.challenge) {
      return res.status(400).json({ error: 'invalid_grant',
        error_description: 'PKCE verification failed' });
    }
    db.prepare('UPDATE oauth_codes SET used=1 WHERE code=?').run(row.code);
    return issue(row.client_id);
  }
  if (b.grant_type === 'refresh_token') {
    const row = db.prepare("SELECT * FROM oauth_tokens WHERE token=? AND kind='refresh'")
      .get(b.refresh_token || '');
    if (!row) return res.status(400).json({ error: 'invalid_grant' });
    return issue(row.client_id);
  }
  res.status(400).json({ error: 'unsupported_grant_type' });
}

function isValidToken(token) {
  if (!token) return false;
  return !!db.prepare("SELECT 1 FROM oauth_tokens WHERE token=? AND kind='access'").get(token);
}

module.exports = { asMetadata, prMetadata, register, authorizeForm, authorizeSubmit, token, isValidToken, PUBLIC_URL };
