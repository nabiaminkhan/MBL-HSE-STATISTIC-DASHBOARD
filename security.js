import crypto from 'node:crypto';

/**
 * Shared security helpers for the MBL HSE API routes.
 *
 * Design notes
 * ------------
 * - The admin password NEVER ships in client code and is never hard-coded here.
 *   It must be provided through the ADMIN_PASSWORD environment variable.
 * - Clients authenticate once against /api/login and receive a short-lived
 *   HMAC token. Write endpoints only accept that token, so the raw password is
 *   not replayed on every publish request.
 * - CORS is restricted to the deployment's own origin (plus anything explicitly
 *   allow-listed via ALLOWED_ORIGINS), instead of the previous wildcard.
 */

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Normalise a configured secret.
 *
 * Pasting a value into a hosting dashboard very often adds an invisible
 * trailing space or newline, and some people wrap the value in quotes because
 * they think it is required. Both used to cause a permanent "Incorrect
 * password", so they are cleaned up here.
 */
function normaliseSecret(raw) {
  if (raw === undefined || raw === null) return '';
  let v = String(raw);
  // Strip zero-width / BOM characters and surrounding whitespace.
  v = v.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  // Strip one matching pair of surrounding quotes.
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

export function getAdminPassword() {
  const pass = normaliseSecret(process.env.ADMIN_PASSWORD);
  return pass ? pass : null;
}

/**
 * Non-sensitive description of how ADMIN_PASSWORD is configured, used by the
 * built-in self check. It never returns the password or its length.
 */
export function describeAdminPasswordConfig() {
  const raw = process.env.ADMIN_PASSWORD;
  const present = raw !== undefined && raw !== null && String(raw) !== '';
  const cleaned = normaliseSecret(raw);
  return {
    configured: !!cleaned,
    variablePresent: present,
    hadSurroundingWhitespace: present && String(raw) !== String(raw).trim(),
    hadSurroundingQuotes: present && /^(["']).*\1$/s.test(String(raw).trim()),
    hadInvisibleCharacters: present && /[\u200B-\u200D\uFEFF]/.test(String(raw)),
    tokenSecretConfigured: !!normaliseSecret(process.env.AUTH_TOKEN_SECRET),
    blobStorageConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
  };
}

function getTokenSecret() {
  // A dedicated secret is preferred; fall back to the admin password so that a
  // minimal deployment (password only) still produces unforgeable tokens.
  return normaliseSecret(process.env.AUTH_TOKEN_SECRET) || getAdminPassword() || '';
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time password check against the environment value.
 *
 * The submitted password is trimmed the same way as the configured one, because
 * phone keyboards and password managers frequently append a space.
 */
export function verifyAdminPassword(provided) {
  const expected = getAdminPassword();
  if (!expected) return false;
  if (typeof provided !== 'string' || !provided) return false;
  const candidate = normaliseSecret(provided);
  if (!candidate) return false;
  if (safeEqual(candidate, expected)) return true;
  // Also accept the raw text exactly as typed, in case the real password
  // legitimately begins or ends with a space.
  return safeEqual(provided, expected);
}

/** Issue an opaque `<expiry>.<hmac>` session token. */
export function issueToken(ttlMs = TOKEN_TTL_MS) {
  const secret = getTokenSecret();
  if (!secret) return null;
  const exp = Date.now() + ttlMs;
  const nonce = crypto.randomBytes(8).toString('hex');
  const body = `${exp}.${nonce}`;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

/** Validate a token produced by issueToken(). */
export function verifyToken(token) {
  const secret = getTokenSecret();
  if (!secret || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${exp}.${nonce}`).digest('hex');
  try {
    return safeEqual(sig, expected);
  } catch (_e) {
    return false;
  }
}

/** Read the bearer/`X-Admin-Token` credential from a request. */
export function readToken(req) {
  const header = req.headers['x-admin-token'] || '';
  if (header) return String(header);
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function allowedOrigins(req) {
  const list = new Set();
  const configured = process.env.ALLOWED_ORIGINS || '';
  configured
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .forEach((o) => list.add(o));

  // The deployment always trusts its own host (covers *.vercel.app previews and
  // any custom domain) without needing extra configuration.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    list.add(`${proto}://${host}`);
    if (/^localhost(:\d+)?$/i.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host)) {
      list.add(`http://${host}`);
    }
  }
  return list;
}

/**
 * Apply a strict CORS policy.
 * Returns false when the caller's Origin is cross-site and not allow-listed,
 * in which case the handler must stop (the response is already finished).
 */
export function applyCors(req, res, methods) {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', `${methods}, OPTIONS`);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const origin = req.headers.origin;
  if (origin) {
    const clean = String(origin).replace(/\/$/, '');
    if (!allowedOrigins(req).has(clean)) {
      res.status(403).json({ ok: false, error: 'Origin not allowed' });
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', clean);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  return true;
}
