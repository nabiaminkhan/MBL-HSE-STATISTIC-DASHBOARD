import { list } from '@vercel/blob';
import { applyCors } from './_lib/security.js';

const BLOB_NAME = 'mbl-hse-live-data.json';

/** GET /api/data -> the latest published dashboard snapshot (public, read-only). */
export default async function handler(req, res) {
  if (!applyCors(req, res, 'GET')) return;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(200).json({
        ok: false,
        mode: 'local',
        message: 'Shared storage not configured yet. Using built-in data.',
      });
    }

    const { blobs } = await list({ prefix: BLOB_NAME, limit: 5 });
    const match = (blobs || []).find((b) => b.pathname === BLOB_NAME) || (blobs || [])[0];

    if (!match || !match.url) {
      return res.status(200).json({
        ok: false,
        mode: 'empty',
        message: 'No published data yet. Admin must click Publish once.',
      });
    }

    const r = await fetch(`${match.url}${match.url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'Failed to read published data' });
    }
    const data = await r.json();
    return res.status(200).json({
      ok: true,
      mode: 'remote',
      updatedAt: data.updatedAt || match.uploadedAt || null,
      data,
    });
  } catch (err) {
    console.error('data api error', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}
