import express, { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { passwordResetEmail, orderStatusEmail, wholesaleStatusEmail, kycStatusEmail, noticeEmail, adminUrl } from '../mailer.js';
import { sendFile, avatarUrl, kycStatusOf } from '../files.js';
import { prisma, toMajor, toMinor } from '../db.js';
import { requireAdmin, setSession, clearSession, loginLimiter } from '../auth.js';
import { getSite, saveSite, getFx, saveFx, FX_CODES } from '../settings.js';
import { NEXT_STATUS, ORDER_STATUSES, PAYMENT_STATUSES, MESSAGE_STATUSES, STATUS_TEXT } from '../constants.js';

const r = Router();
export const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

/* ---------- session ---------- */
r.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  const ok = admin && (await bcrypt.compare(String(req.body?.password || ''), admin.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  setSession(res, admin);
  res.json({ email: admin.email, name: admin.name, role: admin.role });
});

r.post('/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

/* ---------- forgot / reset password ---------- */
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
// A token that hasn't been used yet. On MongoDB an optional field may be missing instead of null, so match both.
const UNUSED = { OR: [{ usedAt: null }, { usedAt: { isSet: false } }] };

// Always answers the same way, so this can't be used to find out which emails have accounts.
r.post('/forgot-password', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const admin = email && (await prisma.adminUser.findUnique({ where: { email } }));
  if (admin) {
    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.deleteMany({ where: { adminId: admin.id, ...UNUSED } });
    await prisma.passwordResetToken.create({
      data: { adminId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
    });
    passwordResetEmail(admin.email, adminUrl(`/reset-password?token=${token}`));
  }
  res.json({ ok: true, message: 'If that email belongs to an admin account, a reset link is on its way.' });
});

r.post('/reset-password', loginLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
  const row = token && (await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(String(token)) } }));
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: row.adminId }, data: { passwordHash: await bcrypt.hash(String(password), 10) } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.deleteMany({ where: { adminId: row.adminId, ...UNUSED } }),
  ]);
  res.json({ ok: true });
});

r.use(requireAdmin);
r.get('/me', (req, res) => res.json(req.admin));

/* ---------- overview ---------- */
const DAY = 24 * 60 * 60 * 1000;
const pct = (now, before) => (before ? Math.round(((now - before) / before) * 1000) / 10 : now ? 100 : 0);

r.get('/stats', async (_req, res) => {
  const now = Date.now();
  const d30 = new Date(now - 30 * DAY), d60 = new Date(now - 60 * DAY);
  const [pendingKyc, pendingApplications, byStatus, newMessages, customers, paid, paid30, paidPrev, orders30, ordersPrev, recent, items, recentOrders, topRaw] = await Promise.all([
    prisma.customer.count({ where: { kycStatus: 'pending' } }),
    prisma.customer.count({ where: { wholesaleStatus: 'pending' } }),
    prisma.order.groupBy({ by: ['status'], _count: true }),
    prisma.contactMessage.count({ where: { status: 'new' } }),
    prisma.customer.count(),
    prisma.order.groupBy({ by: ['currency'], where: { paymentStatus: 'paid' }, _sum: { total: true } }),
    prisma.order.groupBy({ by: ['currency'], where: { paymentStatus: 'paid', createdAt: { gte: d30 } }, _sum: { total: true } }),
    prisma.order.groupBy({ by: ['currency'], where: { paymentStatus: 'paid', createdAt: { gte: d60, lt: d30 } }, _sum: { total: true } }),
    prisma.order.count({ where: { createdAt: { gte: d30 } } }),
    prisma.order.count({ where: { createdAt: { gte: d60, lt: d30 } } }),
    prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: { customer: true } }),
    prisma.orderItem.groupBy({ by: ['productName'], where: { order: { status: { not: 'cancelled' } } }, _sum: { quantity: true } }),
    prisma.order.findMany({ where: { createdAt: { gte: d30 } }, select: { createdAt: true } }),
    prisma.customer.findMany({ include: { orders: { where: { status: { not: 'cancelled' } }, select: { total: true, currency: true } } } }),
  ]);

  const counts = Object.fromEntries(ORDER_STATUSES.map(s => [s, 0]));
  byStatus.forEach(b => (counts[b.status] = b._count));
  const totalOrders = Object.values(counts).reduce((a, b) => a + b, 0);
  const sum = (rows, cur) => toMajor(rows.find(r => r.currency === cur)?._sum.total || 0);

  // orders per day for the last 30 days (oldest first)
  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now - (29 - i) * DAY);
    return { date: d.toISOString().slice(0, 10), orders: 0 };
  });
  recentOrders.forEach(o => {
    const k = o.createdAt.toISOString().slice(0, 10);
    const row = daily.find(d => d.date === k);
    if (row) row.orders++;
  });

  const topCustomers = topRaw
    .map(c => ({
      name: c.name, email: c.email, phone: c.phone,
      orders: c.orders.length,
      ngn: toMajor(c.orders.filter(o => o.currency === 'NGN').reduce((a, o) => a + (o.total || 0), 0)),
      usd: toMajor(c.orders.filter(o => o.currency === 'USD').reduce((a, o) => a + (o.total || 0), 0)),
    }))
    .filter(c => c.orders > 0)
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 6);

  const live = totalOrders - counts.cancelled;
  res.json({
    counts,
    totalOrders,
    open: counts.received + counts.confirmed + counts.paid + counts.processing,
    newMessages,
    customers,
    pendingApplications,
    pendingKyc,
    revenue: { NGN: sum(paid, 'NGN'), USD: sum(paid, 'USD') },
    trend: {
      NGN: pct(sum(paid30, 'NGN'), sum(paidPrev, 'NGN')),
      USD: pct(sum(paid30, 'USD'), sum(paidPrev, 'USD')),
      orders: pct(orders30, ordersPrev),
    },
    orders30,
    deliveredRate: live ? Math.round((counts.delivered / live) * 100) : 0,
    salesByProduct: items.map(i => ({ name: i.productName, units: i._sum.quantity || 0 })).sort((a, b) => b.units - a.units),
    daily,
    topCustomers,
    recent: recent.map(listRow),
  });
});

// Notifications + activity for the right-hand panel.
r.get('/feed', async (_req, res) => {
  const [orders, messages, events, customers, applications, payments, kyc] = await Promise.all([
    prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { customer: true } }),
    prisma.contactMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.orderStatusEvent.findMany({ where: { createdBy: { not: 'customer' } }, orderBy: { createdAt: 'desc' }, take: 6, include: { order: { select: { reference: true } } } }),
    prisma.customer.findMany({ orderBy: { updatedAt: 'desc' }, take: 5 }),
    prisma.customer.findMany({ where: { wholesaleStatus: 'pending' }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.order.findMany({ where: { paymentStatus: 'paid', paidAt: { not: null } }, orderBy: { paidAt: 'desc' }, take: 5, include: { customer: true } }),
    prisma.customer.findMany({ where: { kycStatus: 'pending' }, orderBy: { kycSubmittedAt: 'desc' }, take: 5 }),
  ]);
  const notifications = [
    ...orders.map(o => ({ type: 'order', text: `New order ${o.reference} from ${o.customer.name}`, link: `/orders/${o.reference}`, at: o.createdAt })),
    ...messages.map(m => ({ type: 'message', text: `${m.status === 'new' ? 'New message' : 'Message'} from ${m.name}: ${m.topic}`, link: '/messages', at: m.createdAt })),
    ...applications.map(c => ({ type: 'customers', text: `${c.accountType === 'distributor' ? 'Distributor' : 'Wholesale'} application from ${c.company || c.name}`, link: '/customers', at: c.createdAt, action: true })),
    ...kyc.map(c => ({ type: 'kyc', text: `KYC documents from ${c.company || c.name} to review`, link: '/kyc', at: c.kycSubmittedAt, action: true })),
    ...payments.map(o => ({ type: 'wallet', text: `Payment received for ${o.reference} from ${o.customer.name}`, link: `/orders/${o.reference}`, at: o.paidAt })),
  ].sort((a, b) => b.at - a.at).slice(0, 8);
  res.json({
    notifications,
    activities: events.map(e => ({ text: `${e.order.reference} marked ${e.status}`, by: e.createdBy, link: `/orders/${e.order.reference}`, at: e.createdAt })),
    contacts: customers.map(c => ({ name: c.name, email: c.email, phone: c.phone })),
  });
});

/* ---------- orders ---------- */
function listRow(o) {
  return {
    reference: o.reference,
    createdAt: o.createdAt,
    customer: o.customer?.name,
    email: o.customer?.email,
    deliveryType: o.deliveryType,
    destination: [o.city, o.state, o.country].filter(Boolean).join(', '),
    currency: o.currency,
    total: toMajor(o.total),
    quoteNeeded: o.quoteNeeded,
    status: o.status,
    paymentStatus: o.paymentStatus,
  };
}

r.get('/orders', async (req, res) => {
  const { status, q } = req.query;
  const where = {};
  if (ORDER_STATUSES.includes(status)) where.status = status;
  if (q) {
    const term = String(q).trim();
    where.OR = [
      // MongoDB string matching is case-sensitive unless mode is 'insensitive'
      { reference: { contains: term, mode: 'insensitive' } },
      { customer: { name: { contains: term, mode: 'insensitive' } } },
      { customer: { email: { contains: term, mode: 'insensitive' } } },
      { city: { contains: term, mode: 'insensitive' } },
    ];
  }
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { customer: true } });
  res.json(orders.map(listRow));
});

async function orderDetail(reference) {
  const o = await prisma.order.findUnique({
    where: { reference },
    include: { customer: true, items: true, events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!o) return null;
  return {
    ...listRow(o),
    customer: { name: o.customer.name, email: o.customer.email, phone: o.customer.phone, company: o.customer.company, buyerType: o.customer.buyerType },
    country: o.country, state: o.state, city: o.city, address: o.address, port: o.port, shippingMethod: o.shippingMethod,
    subtotal: toMajor(o.subtotal), deliveryFee: toMajor(o.deliveryFee), total: toMajor(o.total),
    paymentMethod: o.paymentMethod, trackingNumber: o.trackingNumber, neededBy: o.neededBy,
    currentLocation: o.currentLocation, locationUpdatedAt: o.locationUpdatedAt,
    notes: o.notes, adminNotes: o.adminNotes,
    next: NEXT_STATUS[o.status],
    items: o.items.map(i => ({ id: i.id, name: i.productName, size: i.variantLabel, qty: i.quantity, unitPrice: toMajor(i.unitPrice), lineTotal: toMajor(i.lineTotal) })),
    events: o.events.map(e => ({ status: e.status, note: e.note, location: e.location, public: e.public, by: e.createdBy, at: e.createdAt })),
  };
}

r.get('/orders/:reference', async (req, res) => {
  const o = await orderDetail(req.params.reference);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  res.json(o);
});

// Update an order: move it along the workflow, set delivery fee / tracking / payment, add notes.
r.patch('/orders/:reference', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { reference: req.params.reference }, include: { items: true } });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const { status, note, notifyCustomer = true, deliveryFee, paymentStatus, trackingNumber, adminNotes, itemPrices } = req.body || {};
  // where the goods are now (typed by admin until tracking is automated)
  const location = req.body?.location !== undefined ? String(req.body.location).trim().slice(0, 160) : undefined;
  const moved = location && location !== order.currentLocation;
  if (moved) { data.currentLocation = location; data.locationUpdatedAt = new Date(); }
  const data = {};

  // admin can price "quote on request" lines: { [itemId]: unitPrice }
  let items = order.items;
  if (itemPrices && typeof itemPrices === 'object') {
    for (const it of order.items) {
      if (itemPrices[it.id] === undefined || itemPrices[it.id] === '') continue;
      const unit = toMinor(itemPrices[it.id]);
      await prisma.orderItem.update({ where: { id: it.id }, data: { unitPrice: unit, lineTotal: unit * it.quantity } });
    }
    items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    const missing = items.some(i => i.lineTotal == null);
    data.quoteNeeded = missing;
    data.subtotal = missing ? null : items.reduce((s, i) => s + i.lineTotal, 0);
  }
  if (deliveryFee !== undefined) data.deliveryFee = deliveryFee === '' || deliveryFee === null ? null : toMinor(deliveryFee);
  const subtotal = data.subtotal !== undefined ? data.subtotal : order.subtotal;
  const fee = data.deliveryFee !== undefined ? data.deliveryFee : order.deliveryFee;
  data.total = subtotal == null ? null : subtotal + (fee || 0);

  if (trackingNumber !== undefined) data.trackingNumber = String(trackingNumber).trim() || null;
  if (adminNotes !== undefined) data.adminNotes = String(adminNotes).slice(0, 4000) || null;
  if (paymentStatus !== undefined) {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) return res.status(400).json({ error: 'Invalid payment status.' });
    data.paymentStatus = paymentStatus;
  }

  const events = [];
  if (status && status !== order.status) {
    if (!NEXT_STATUS[order.status].includes(status)) {
      return res.status(400).json({ error: `An order that is "${order.status}" can't move to "${status}".` });
    }
    if (status === 'confirmed' && data.total == null) {
      return res.status(400).json({ error: 'Set prices for every item before confirming, so the customer gets a total.' });
    }
    data.status = status;
    if (status === 'paid') data.paymentStatus = 'paid';
    events.push({ status, note: String(note || '').trim() || STATUS_TEXT[status], public: Boolean(notifyCustomer), createdBy: req.admin.email });

    // stock: reserve on confirm, release if a confirmed order is cancelled
    const reserved = ['confirmed', 'paid', 'processing'].includes(order.status);
    if (status === 'confirmed' || (status === 'cancelled' && reserved)) {
      const sign = status === 'confirmed' ? -1 : 1;
      for (const it of items) {
        if (!it.variantId) continue;
        const v = await prisma.productVariant.findUnique({ where: { id: it.variantId } });
        if (v?.stock != null) await prisma.productVariant.update({ where: { id: v.id }, data: { stock: Math.max(0, v.stock + sign * it.quantity) } });
      }
    }
  } else if ((note && String(note).trim()) || moved) {
    events.push({ status: order.status, note: String(note || '').trim() || `Your order is now at ${location}.`, public: moved ? true : Boolean(notifyCustomer), createdBy: req.admin.email });
  }
  if (moved && events[0]) { events[0].location = location; if (data.status) events[0].public = true; }

  const updated = await prisma.order.update({ where: { id: order.id }, data: { ...data, events: { create: events } }, include: { customer: true } });
  const shared = events.find(e => e.public);
  if (shared) orderStatusEmail(updated, updated.customer, shared.status, shared.note);
  res.json(await orderDetail(order.reference));
});

/* ---------- products ---------- */
r.get('/products', async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { sortOrder: 'asc' }, include: { variants: { orderBy: { sortOrder: 'asc' } } } });
  res.json(products.map(p => ({
    id: p.id, slug: p.slug, name: p.name, tag: p.tag, description: p.description, active: p.active, image: p.image,
    variants: p.variants.map(v => ({ id: v.id, code: v.code, label: v.label, sku: v.sku, ngn: toMajor(v.priceNgn), usd: toMajor(v.priceUsd), wholesaleNgn: toMajor(v.wholesaleNgn), wholesaleUsd: toMajor(v.wholesaleUsd), distributorNgn: toMajor(v.distributorNgn), distributorUsd: toMajor(v.distributorUsd), stock: v.stock, active: v.active })),
  })));
});

const slugify = v => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const IMAGE_PATH = /^\/(products|uploads|bg|journey)\/[\w.-]+\.(jpe?g|png|webp)$/i;

// Reads name/tag/description/image/active/sortOrder from the body. `create` makes name, tag and description required.
function productData(body = {}, create = false) {
  const data = {};
  const errors = [];
  for (const [k, max] of [['name', 120], ['tag', 80], ['description', 1000]]) {
    if (body[k] !== undefined || create) {
      data[k] = clean(body[k], max);
      if (!data[k]) errors.push(`${k[0].toUpperCase() + k.slice(1)} is required.`);
    }
  }
  if (body.image !== undefined) {
    data.image = clean(body.image) || null;
    if (data.image && !IMAGE_PATH.test(data.image)) errors.push('Upload an image or leave it empty.');
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) data.sortOrder = Math.round(Number(body.sortOrder));
  return { data, errors };
}

// Reads label/prices/stock/active for a pack size. Prices come in whole naira/dollars.
function variantData(body = {}, create = false) {
  const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
  const data = {};
  const errors = [];
  if (body.label !== undefined || create) {
    data.label = clean(body.label, 60);
    if (!data.label) errors.push('Pack size name is required, e.g. "5 litres".');
  }
  if (body.ngn !== undefined) data.priceNgn = toMinor(num(body.ngn));
  if (body.usd !== undefined) data.priceUsd = toMinor(num(body.usd));
  if (body.wholesaleNgn !== undefined) data.wholesaleNgn = toMinor(num(body.wholesaleNgn));
  if (body.wholesaleUsd !== undefined) data.wholesaleUsd = toMinor(num(body.wholesaleUsd));
  if (body.distributorNgn !== undefined) data.distributorNgn = toMinor(num(body.distributorNgn));
  if (body.distributorUsd !== undefined) data.distributorUsd = toMinor(num(body.distributorUsd));
  if (body.stock !== undefined) data.stock = num(body.stock) == null ? null : Math.round(num(body.stock));
  if (body.active !== undefined) data.active = Boolean(body.active);
  for (const k of ['priceNgn', 'priceUsd', 'wholesaleNgn', 'wholesaleUsd', 'distributorNgn', 'distributorUsd', 'stock']) {
    if (data[k] != null && (Number.isNaN(data[k]) || data[k] < 0)) errors.push('Prices and stock must be positive numbers.');
  }
  return { data, errors: [...new Set(errors)] };
}

r.post('/products', async (req, res) => {
  const { data, errors } = productData(req.body, true);
  if (errors.length) return res.status(400).json({ errors });
  let slug = slugify(req.body.slug || data.name) || 'oil';
  for (let n = 2; await prisma.product.findUnique({ where: { slug } }); n++) slug = `${slugify(data.name)}-${n}`;
  const last = await prisma.product.aggregate({ _max: { sortOrder: true } });
  const product = await prisma.product.create({ data: { ...data, slug, sortOrder: data.sortOrder ?? (last._max.sortOrder ?? -1) + 1 } });
  res.status(201).json(product);
});

r.patch('/products/:id', async (req, res) => {
  const { data, errors } = productData(req.body);
  if (errors.length) return res.status(400).json({ errors });
  res.json(await prisma.product.update({ where: { id: req.params.id }, data }));
});

// Past orders keep their own copy of names and prices, so deleting an oil never changes order history.
r.delete('/products/:id', async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

r.post('/products/:id/variants', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const { data, errors } = variantData(req.body, true);
  if (errors.length) return res.status(400).json({ errors });
  const base = slugify(data.label).replace(/-/g, '') || 'pack';
  let code = base;
  for (let n = 2; await prisma.productVariant.findFirst({ where: { productId: product.id, code } }); n++) code = `${base}${n}`;
  let sku = `${product.slug}-${code}`.toUpperCase();
  for (let n = 2; await prisma.productVariant.findUnique({ where: { sku } }); n++) sku = `${product.slug}-${code}-${n}`.toUpperCase();
  const last = await prisma.productVariant.aggregate({ where: { productId: product.id }, _max: { sortOrder: true } });
  const v = await prisma.productVariant.create({ data: { ...data, productId: product.id, code, sku, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  res.status(201).json({ id: v.id });
});

r.patch('/variants/:id', async (req, res) => {
  const { data, errors } = variantData(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const v = await prisma.productVariant.update({ where: { id: req.params.id }, data });
  res.json({ id: v.id, label: v.label, ngn: toMajor(v.priceNgn), usd: toMajor(v.priceUsd), wholesaleNgn: toMajor(v.wholesaleNgn), wholesaleUsd: toMajor(v.wholesaleUsd), distributorNgn: toMajor(v.distributorNgn), distributorUsd: toMajor(v.distributorUsd), stock: v.stock, active: v.active });
});

r.delete('/variants/:id', async (req, res) => {
  await prisma.productVariant.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Product photo upload: the raw image is the request body. Saved to /uploads and served from there.
const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
r.post('/uploads', express.raw({ type: Object.keys(UPLOAD_TYPES), limit: '6mb' }), async (req, res) => {
  const ext = UPLOAD_TYPES[req.headers['content-type']];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Upload a JPG, PNG or WebP image under 6 MB.' });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), req.body);
  res.status(201).json({ url: `/uploads/${name}` });
});

/* ---------- location & contact ---------- */
r.get('/settings', async (_req, res) => res.json(await getSite()));
r.put('/settings', async (req, res) => {
  const { site, errors } = await saveSite(req.body);
  if (errors) return res.status(400).json({ errors });
  res.json(site);
});

/* ---------- FAQ ---------- */
function faqData(body = {}, create = false) {
  const data = {};
  const errors = [];
  for (const [k, max, label] of [['category', 60, 'Category'], ['question', 300, 'Question'], ['answer', 3000, 'Answer']]) {
    if (body[k] !== undefined || create) {
      data[k] = clean(body[k], max);
      if (!data[k]) errors.push(`${label} is required.`);
    }
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  return { data, errors };
}

r.get('/faq', async (_req, res) => {
  res.json(await prisma.faqItem.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }));
});

r.post('/faq', async (req, res) => {
  const { data, errors } = faqData(req.body, true);
  if (errors.length) return res.status(400).json({ errors });
  const last = await prisma.faqItem.aggregate({ _max: { sortOrder: true } });
  res.status(201).json(await prisma.faqItem.create({ data: { ...data, sortOrder: (last._max.sortOrder ?? -1) + 1 } }));
});

r.patch('/faq/:id', async (req, res) => {
  const { data, errors } = faqData(req.body);
  if (errors.length) return res.status(400).json({ errors });
  res.json(await prisma.faqItem.update({ where: { id: req.params.id }, data }));
});

r.delete('/faq/:id', async (req, res) => {
  await prisma.faqItem.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Saves a new order: body.ids is every FAQ id in the order they should appear.
r.post('/faq/reorder', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  await prisma.$transaction(ids.map((id, i) => prisma.faqItem.update({ where: { id }, data: { sortOrder: i } })));
  res.json({ ok: true });
});

/* ---------- reviews, news, newsletter ---------- */
function reviewData(b = {}, create = false) {
  const data = {}; const errors = [];
  if (b.name !== undefined || create) { data.name = clean(b.name, 80); if (!data.name) errors.push('Customer name is required.'); }
  if (b.quote !== undefined || create) { data.quote = clean(b.quote, 600); if (!data.quote) errors.push('Review text is required.'); }
  if (b.place !== undefined) data.place = clean(b.place, 80) || null;
  if (b.rating !== undefined) data.rating = Math.min(5, Math.max(1, Math.round(Number(b.rating) || 5)));
  if (b.active !== undefined) data.active = Boolean(b.active);
  return { data, errors };
}
function newsData(b = {}, create = false) {
  const data = {}; const errors = [];
  if (b.title !== undefined || create) { data.title = clean(b.title, 140); if (!data.title) errors.push('Title is required.'); }
  if (b.summary !== undefined || create) { data.summary = clean(b.summary, 600); if (!data.summary) errors.push('Summary is required.'); }
  if (b.image !== undefined) { data.image = clean(b.image) || null; if (data.image && !IMAGE_PATH.test(data.image)) errors.push('Upload an image or leave it empty.'); }
  if (b.link !== undefined) { data.link = clean(b.link, 500) || null; if (data.link && !/^(https:\/\/|\/)\S*$/.test(data.link)) errors.push('The link must start with https:// or /'); }
  if (b.active !== undefined) data.active = Boolean(b.active);
  return { data, errors };
}
for (const [path, model, parse] of [['reviews', 'review', reviewData], ['news', 'newsPost', newsData]]) {
  r.get(`/${path}`, async (_req, res) => res.json(await prisma[model].findMany({ orderBy: { createdAt: 'desc' } })));
  r.post(`/${path}`, async (req, res) => {
    const { data, errors } = parse(req.body, true);
    if (errors.length) return res.status(400).json({ errors });
    res.status(201).json(await prisma[model].create({ data }));
  });
  r.patch(`/${path}/:id`, async (req, res) => {
    const { data, errors } = parse(req.body);
    if (errors.length) return res.status(400).json({ errors });
    res.json(await prisma[model].update({ where: { id: req.params.id }, data }));
  });
  r.delete(`/${path}/:id`, async (req, res) => {
    await prisma[model].delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  });
}
r.get('/newsletter', async (_req, res) => res.json(await prisma.newsletterSubscriber.findMany({ orderBy: { createdAt: 'desc' } })));
r.delete('/newsletter/:id', async (req, res) => {
  await prisma.newsletterSubscriber.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ---------- messages & customers ---------- */
r.get('/messages', async (req, res) => {
  const where = MESSAGE_STATUSES.includes(req.query.status) ? { status: req.query.status } : { status: { not: 'archived' } };
  res.json(await prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }));
});

r.patch('/messages/:id', async (req, res) => {
  if (!MESSAGE_STATUSES.includes(req.body?.status)) return res.status(400).json({ error: 'Invalid status.' });
  res.json(await prisma.contactMessage.update({ where: { id: req.params.id }, data: { status: req.body.status } }));
});

r.get('/customers', async (_req, res) => {
  const list = await prisma.customer.findMany({ orderBy: { createdAt: 'desc' }, take: 300, include: { _count: { select: { orders: true } } } });
  res.json(list.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, company: c.company, buyerType: c.buyerType, country: c.country, accountType: c.accountType, wholesaleStatus: c.wholesaleStatus, area: c.area, monthlyVolume: c.monthlyVolume, avatarUrl: avatarUrl(c.avatarId), kycStatus: kycStatusOf(c), registered: Boolean(c.passwordHash), orders: c._count.orders, createdAt: c.createdAt })));
});

// Approve or decline a wholesale or distributor account. The customer is emailed either way.
r.patch('/customers/:id', async (req, res) => {
  const status = req.body?.wholesaleStatus;
  if (!['approved', 'rejected', 'none', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid wholesale status.' });
  const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: 'Customer not found.' });
  // distributors stay distributors when approved; everyone else becomes a wholesale account
  const accountType = before.accountType === 'distributor' ? 'distributor' : 'wholesale';
  const c = await prisma.customer.update({
    where: { id: req.params.id },
    data: { wholesaleStatus: status, ...(status === 'approved' ? { accountType, buyerType: 'business' } : {}) },
  });
  if (status === 'approved' || status === 'rejected') wholesaleStatusEmail(c, status);
  res.json({ id: c.id, wholesaleStatus: c.wholesaleStatus, accountType: c.accountType });
});

/* ---------- KYC review ---------- */
// Documents stay stored after a decision, so they can be looked at again at any time.
const kycRow = c => ({
  id: c.id, name: c.name, email: c.email, phone: c.phone, company: c.company, accountType: c.accountType, country: c.country,
  avatarUrl: avatarUrl(c.avatarId), status: kycStatusOf(c), idType: c.kycIdType, idNumber: c.kycIdNumber, note: c.kycNote,
  submittedAt: c.kycSubmittedAt, reviewedAt: c.kycReviewedAt,
  document: c.kycDocId ? `/api/admin/files/${c.kycDocId}` : null,
  extra: c.kycExtraId ? `/api/admin/files/${c.kycExtraId}` : null,
});
r.get('/kyc', async (_req, res) => {
  const list = await prisma.customer.findMany({ where: { kycStatus: { in: ['pending', 'approved', 'rejected'] } }, orderBy: { kycSubmittedAt: 'desc' }, take: 500 });
  res.json(list.map(kycRow));
});

r.get('/files/:id', (req, res) => sendFile(res, req.params.id));

r.patch('/kyc/:id', async (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  if (status === 'rejected' && !note) return res.status(400).json({ error: 'Tell the customer why, so they can fix it.' });
  const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!before?.kycDocId) return res.status(404).json({ error: 'No KYC documents for this customer.' });
  const c = await prisma.customer.update({ where: { id: before.id }, data: { kycStatus: status, kycNote: status === 'rejected' ? note : null, kycReviewedAt: new Date() } });
  if (status !== 'pending') {
    kycStatusEmail(c, status, note);
    await prisma.customerNotice.create({ data: {
      customerId: c.id,
      title: status === 'approved' ? 'Your account is verified' : 'Please re-upload your KYC documents',
      body: status === 'approved' ? 'Your identity documents were checked and approved.' : `We could not verify your documents. ${note}`,
      link: '/account?tab=kyc',
    } });
  }
  res.json(kycRow(c));
});

/* ---------- messages to customers ---------- */
const AUDIENCES = {
  all: ['All customers', {}],
  wholesale: ['Wholesale customers', { accountType: 'wholesale' }],
  distributor: ['Distributors', { accountType: 'distributor' }],
  international: ['International customers', { accountType: 'international' }],
  verified: ['Verified (KYC approved)', { kycStatus: 'approved' }],
};

r.get('/broadcasts', async (_req, res) => {
  const [list, customers] = await Promise.all([
    prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { notices: { where: { readAt: { not: null } } } } } } }),
    prisma.customer.findMany({ where: { passwordHash: { not: null } }, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true, company: true, accountType: true } }),
  ]);
  const counts = {};
  for (const k of Object.keys(AUDIENCES)) counts[k] = await prisma.customer.count({ where: { passwordHash: { not: null }, ...AUDIENCES[k][1] } });
  res.json({
    audiences: Object.entries(AUDIENCES).map(([id, [label]]) => ({ id, label, count: counts[id] })),
    customers,
    sent: list.map(b => ({ id: b.id, title: b.title, body: b.body, audience: b.audience, audienceLabel: b.audienceLabel, recipients: b.recipients, read: b._count.notices, emailed: b.emailed, sentBy: b.sentBy, at: b.createdAt })),
  });
});

// Send to a group (audience) or to one customer (audience "customer" + customerId). Shows in their dashboard; optional email.
r.post('/broadcasts', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  const body = String(b.body || '').trim().slice(0, 4000);
  if (!title || !body) return res.status(400).json({ error: 'Add a title and a message.' });
  let recipients, audienceLabel;
  if (b.audience === 'customer') {
    const c = b.customerId && (await prisma.customer.findUnique({ where: { id: String(b.customerId) } }));
    if (!c) return res.status(400).json({ error: 'Choose a customer.' });
    recipients = [c];
    audienceLabel = `${c.name} (${c.email})`;
  } else if (AUDIENCES[b.audience]) {
    recipients = await prisma.customer.findMany({ where: { passwordHash: { not: null }, ...AUDIENCES[b.audience][1] } });
    audienceLabel = AUDIENCES[b.audience][0];
  } else return res.status(400).json({ error: 'Choose who to send to.' });
  if (!recipients.length) return res.status(400).json({ error: 'No customers in that group yet.' });

  const email = Boolean(b.email);
  const sent = await prisma.broadcast.create({ data: { title, body, audience: b.audience, audienceLabel, recipients: recipients.length, emailed: email, sentBy: req.admin.email } });
  await prisma.customerNotice.createMany({ data: recipients.map(c => ({ customerId: c.id, broadcastId: sent.id, title, body })) });
  // emails go out one by one in the background so the request returns straight away
  if (email) (async () => { for (const c of recipients) await noticeEmail(c, title, body); })();
  res.status(201).json({ id: sent.id, recipients: recipients.length });
});

r.delete('/broadcasts/:id', async (req, res) => {
  await prisma.customerNotice.deleteMany({ where: { broadcastId: req.params.id } });
  await prisma.broadcast.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

/* ---------- display currencies ---------- */
r.get('/fx', async (_req, res) => res.json({ ...(await getFx()), codes: FX_CODES }));
r.put('/fx', async (req, res) => res.json({ ...(await saveFx(req.body)), codes: FX_CODES }));

export default r;
