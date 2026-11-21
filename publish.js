import { put, del, list } from '@vercel/blob';
import zlib from 'zlib';
import { applyCors, verifyToken, readToken, getAdminPassword } from './_lib/security.js';

const BLOB_NAME = 'mbl-hse-live-data.json';
const PART_PREFIX = 'mbl-hse-upload/';

/**
 * Vercel caps a single serverless request body at ~4.5 MB, which is what made
 * the old "one giant JSON POST" publish silently fail as soon as the Excel data
 * or photos grew. The client now gzips the payload, base64-encodes it and sends
 * it in ordered chunks; each chunk is well under the platform limit. Parts are
 * staged in Blob storage and assembled here on the final chunk.
 */
export const config = {
  api: {
    bodyParser: { sizeLimit: '4mb' },
  },
};

function partName(uploadId, index) {
  return `${PART_PREFIX}${uploadId}/${String(index).padStart(5, '0')}.part`;
}

async function cleanupParts(uploadId) {
  try {
    const { blobs } = await list({ prefix: `${PART_PREFIX}${uploadId}/`, limit: 1000 });
    await Promise.all((blobs || []).map((b) => del(b.url).catch(() => null)));
  } catch (_e) {
    /* best effort */
  }
}

async function readAllParts(uploadId, total) {
  const { blobs } = await list({ prefix: `${PART_PREFIX}${uploadId}/`, limit: 1000 });
  const byName = new Map((blobs || []).map((b) => [b.pathname, b]));
  const out = [];
  for (let i = 0; i < total; i++) {
    const name = partName(uploadId, i);
    const meta = byName.get(name);
    if (!meta) throw new Error(`Missing upload part ${i + 1} of ${total}`);
    const r = await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Could not read upload part ${i + 1}`);
    out.push(await r.text());
  }
  return out.join('');
}

function decodePayload(base64, encoding) {
  const raw = Buffer.from(base64, 'base64');
  const json = encoding === 'gzip' ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Payload is not a data object');
  }
  return parsed;
}

async function writeLive(payloadObj) {
  const payload = {
    ...payloadObj,
    updatedAt: new Date().toISOString(),
    publishedBy: 'admin',
  };
  const blob = await put(BLOB_NAME, JSON.stringify(payload), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    allowOverwrite: true,
  });
  return { url: blob.url, updatedAt: payload.updatedAt };
}

export default async function handler(req, res) {
  if (!applyCors(req, res, 'POST')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!getAdminPassword()) {
    return res.status(503).json({
      ok: false,
      error: 'Publishing is not configured. Set the ADMIN_PASSWORD environment variable.',
    });
  }
  if (!verifyToken(readToken(req))) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please unlock admin again.' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({
      ok: false,
      code: 'no_storage',
      error:
        'Shared storage is not connected yet, so there is nowhere to publish the data. In Vercel open Storage \u2192 Create \u2192 Blob, connect the store to this project, then redeploy and publish again.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid body' });
  }

  try {
    // ---- Chunked transfer (current client) ----
    if (typeof body.chunk === 'string') {
      const total = Number(body.total);
      const index = Number(body.index);
      const uploadId = String(body.uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const encoding = body.encoding === 'gzip' ? 'gzip' : 'raw';

      if (!uploadId || !Number.isInteger(total) || total < 1 || total > 400) {
        return res.status(400).json({ ok: false, error: 'Bad upload descriptor' });
      }
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        return res.status(400).json({ ok: false, error: 'Bad chunk index' });
      }

      // Single chunk: no staging needed.
      if (total === 1) {
        const result = await writeLive(decodePayload(body.chunk, encoding));
        return res.status(200).json({ ok: true, ...result });
      }

      await put(partName(uploadId, index), body.chunk, {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'text/plain',
        allowOverwrite: true,
      });

      if (index < total - 1) {
        return res.status(200).json({ ok: true, received: index + 1, total });
      }

      try {
        const base64 = await readAllParts(uploadId, total);
        const result = await writeLive(decodePayload(base64, encoding));
        return res.status(200).json({ ok: true, ...result });
      } finally {
        await cleanupParts(uploadId);
      }
    }

    // ---- Legacy single-shot JSON body (kept for compatibility) ----
    const result = await writeLive(body);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('publish api error', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}
