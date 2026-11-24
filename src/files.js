import express from 'express';
import { prisma } from './db.js';

// Uploads arrive as the raw request body (the browser sends the File directly) and are kept in MongoDB,
// so profile photos and KYC documents survive Render redeploys.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];
export const rawUpload = (types, limit) => express.raw({ type: types, limit });

export async function saveFile(req, res, { kind, types, customerId, maxMb }) {
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!types.includes(mime)) { res.status(400).json({ error: `Upload a ${types.includes('application/pdf') ? 'JPG, PNG, WebP or PDF' : 'JPG, PNG or WebP'} file.` }); return null; }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) { res.status(400).json({ error: 'The file was empty.' }); return null; }
  if (buf.length > maxMb * 1024 * 1024) { res.status(413).json({ error: `Files can be up to ${maxMb} MB.` }); return null; }
  return prisma.storedFile.create({ data: { kind, mime, size: buf.length, data: buf, customerId } });
}

export async function sendFile(res, id, where = {}) {
  const f = id && (await prisma.storedFile.findFirst({ where: { id: String(id), ...where } }));
  if (!f) return res.status(404).json({ error: 'File not found.' });
  res.set('Content-Type', f.mime);
  res.set('Cache-Control', where.kind === 'avatar' ? 'public, max-age=604800, immutable' : 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(f.data));
}

export const removeFile = id => (id ? prisma.storedFile.deleteMany({ where: { id } }) : null);
export const avatarUrl = id => (id ? `/api/avatars/${id}` : null);

export const KYC_ID_TYPES = ['National ID (NIN)', 'International passport', "Driver's licence", "Voter's card", 'CAC certificate (business)'];
// A customer whose KYC was never submitted has no kycStatus field.
export const kycStatusOf = c => c.kycStatus || 'none';
