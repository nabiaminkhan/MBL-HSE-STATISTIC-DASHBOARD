import {
  applyCors,
  verifyAdminPassword,
  issueToken,
  getAdminPassword,
  describeAdminPasswordConfig,
} from './_lib/security.js';

/**
 * POST /api/login  { password }  ->  { ok, token, expiresIn }
 * GET  /api/login              ->  a non-sensitive setup self-check
 *
 * The admin password lives only in the ADMIN_PASSWORD environment variable and
 * is verified here, server-side. The browser never holds a copy of the real
 * secret in its source code. The GET self-check reports only whether the
 * variable is configured and whether it looks damaged (stray quotes, spaces or
 * invisible characters) — never the value or its length.
 */
export default async function handler(req, res) {
  if (!applyCors(req, res, 'GET, POST')) return;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, setup: describeAdminPasswordConfig() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!getAdminPassword()) {
    return res.status(503).json({
      ok: false,
      code: 'not_configured',
      error:
        'Admin login is not set up on the server yet. Add the ADMIN_PASSWORD environment variable in your hosting settings, then redeploy.',
      setup: describeAdminPasswordConfig(),
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_e) { body = null; }
  }
  const password = body && typeof body.password === 'string' ? body.password : '';

  if (!verifyAdminPassword(password)) {
    // Small delay to blunt rapid brute-force attempts.
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ ok: false, code: 'bad_password', error: 'Incorrect password' });
  }

  const token = issueToken();
  if (!token) {
    return res.status(503).json({ ok: false, error: 'Token secret not configured' });
  }

  return res.status(200).json({ ok: true, token, expiresIn: 8 * 60 * 60 });
}
