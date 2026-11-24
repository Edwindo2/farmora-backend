import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma, toMajor } from '../db.js';
import { STATUS_TEXT } from '../constants.js';
import { asset, packImage } from './public.js';
import { setCustomerSession, clearCustomerSession, requireCustomer, linkLimiter, loginLimiter, customerToken, isAppClient } from '../auth.js';
import { canPay, createPaymentLink, confirmTransaction, paymentsEnabled } from '../flutterwave.js';
import { customerLoginEmail, customerActivateEmail, newWholesaleAlert, kycSubmittedAlert, transferReportedAlert, appUrl } from '../mailer.js';
import { bankFor } from '../settings.js';
import { rawUpload, saveFile, removeFile, avatarUrl, IMAGE_TYPES, DOC_TYPES, KYC_ID_TYPES, kycStatusOf } from '../files.js';

// Customer accounts and dashboard. Customers register with a password (or use a one-time email link),
// then see their orders, tracking and tracking history.
const r = Router();
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const LINK_MINUTES = 20;

// Send a sign-in link. Always answers the same way so nobody can probe which emails have ordered.
r.post('/login-link', linkLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });

  const customer = await prisma.customer.findUnique({ where: { email } });
  if (customer) {
    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.customerLoginToken.create({
      data: { customerId: customer.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + LINK_MINUTES * 60 * 1000) },
    });
    customerLoginEmail(customer, appUrl(`/account/verify?token=${token}`));
  }
  res.json({ ok: true });
});

// Exchange the link's token for a 30-day session cookie.
r.post('/verify', async (req, res) => {
  const token = String(req.body?.token || '');
  const row = token && (await prisma.customerLoginToken.findUnique({ where: { tokenHash: hash(token) }, include: { customer: true } }));
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    return res.status(400).json({ error: 'This sign-in link has expired or was already used. Please request a new one.' });
  }
  await prisma.customerLoginToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  // confirming the email also activates a password chosen at registration
  const pending = row.customer.pendingPasswordHash;
  await prisma.customer.update({
    where: { id: row.customer.id },
    data: { lastLoginAt: new Date(), ...(pending ? { passwordHash: pending, pendingPasswordHash: null } : {}) },
  });
  setCustomerSession(res, row.customer);
  res.json({ ok: true, ...(isAppClient(req) ? { token: customerToken(row.customer) } : {}) });
});

const isEmail = v => /^\S+@\S+\.\S+$/.test(v);
const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const PASSWORD_MIN = 8;
// Password rules (the sign-up form shows the same list): 8+ characters, with a letter and a number.
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < PASSWORD_MIN) return `Use a password of at least ${PASSWORD_MIN} characters.`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Your password needs at least one letter and one number.';
  return null;
}

async function sendLink(customer, kind) {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.customerLoginToken.create({
    data: { customerId: customer.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + LINK_MINUTES * 60 * 1000) },
  });
  const link = appUrl(`/account/verify?token=${token}`);
  return kind === 'activate' ? customerActivateEmail(customer, link) : customerLoginEmail(customer, link);
}

// Create an account. If the email already has guest orders, we email a link to confirm it's theirs
// before linking anything, so nobody can see another person's orders by registering with their email.
r.post('/register', loginLimiter, async (req, res) => {
  const b = req.body || {};
  const email = clean(b.email).toLowerCase();
  const errors = [];
  if (!clean(b.name, 120)) errors.push('Your name is required.');
  if (!isEmail(email)) errors.push('Enter a valid email address.');
  if (clean(b.phone, 40).replace(/\D/g, '').length < 7) errors.push('Enter a phone or WhatsApp number.');
  const pwProblem = passwordProblem(b.password);
  if (pwProblem) errors.push(pwProblem);
  const accountType = ['wholesale', 'distributor', 'international'].includes(b.accountType) ? b.accountType : 'wholesale';
  const country = clean(b.country, 80) || (accountType === 'international' ? '' : 'Nigeria');
  if (!country) errors.push('Country is required.');
  if (accountType === 'international' && /^nigeria$/i.test(country)) errors.push('International accounts are for buyers outside Nigeria. Choose Wholesale instead.');
  if (accountType === 'distributor' && !clean(b.area)) errors.push('Tell us the states or areas you will cover.');
  if (errors.length) return res.status(400).json({ errors });

  const company = clean(b.company) || null;
  const data = {
    name: clean(b.name), phone: clean(b.phone, 40), company, country, accountType,
    buyerType: accountType !== 'individual' || company ? 'business' : 'individual',
    // wholesale and distributor accounts start pending until the admin approves them
    wholesaleStatus: ['wholesale', 'distributor'].includes(accountType) ? 'pending' : 'none',
    ...(accountType === 'distributor' ? { area: clean(b.area, 200), monthlyVolume: clean(b.monthlyVolume, 120) || null } : {}),
  };
  const existing = await prisma.customer.findUnique({ where: { email } });
  if (existing?.passwordHash) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  if (existing) {
    // guest customer: keep the password aside until they confirm the email
    await prisma.customer.update({ where: { id: existing.id }, data: { ...data, pendingPasswordHash: await bcrypt.hash(String(b.password), 10) } });
    await sendLink(existing, 'activate');
    return res.status(202).json({ verify: true });
  }
  const customer = await prisma.customer.create({ data: { ...data, email, passwordHash: await bcrypt.hash(String(b.password), 10), lastLoginAt: new Date() } });
  if (['wholesale', 'distributor'].includes(accountType)) newWholesaleAlert(customer);
  setCustomerSession(res, customer);
  res.status(201).json({ ok: true, ...(isAppClient(req) ? { token: customerToken(customer) } : {}) });
});

r.post('/login', loginLimiter, async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const customer = email && (await prisma.customer.findUnique({ where: { email } }));
  const ok = customer?.passwordHash && (await bcrypt.compare(String(req.body?.password || ''), customer.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Wrong email or password. You can also sign in with an email link.' });
  await prisma.customer.update({ where: { id: customer.id }, data: { lastLoginAt: new Date() } });
  setCustomerSession(res, customer);
  res.json({ ok: true, ...(isAppClient(req) ? { token: customerToken(customer) } : {}) });
});

r.post('/logout', (_req, res) => {
  clearCustomerSession(res);
  res.json({ ok: true });
});

r.use(requireCustomer);

// Profile plus the delivery details from the latest order, used to pre-fill the next order form.
r.get('/me', async (req, res) => {
  const c = req.customer;
  const last = await prisma.order.findFirst({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' } });
  res.json({
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    buyerType: c.buyerType,
    country: c.country,
    hasPassword: Boolean(c.passwordHash),
    accountType: c.accountType,
    wholesaleStatus: c.wholesaleStatus,
    area: c.area,
    monthlyVolume: c.monthlyVolume,
    avatarUrl: avatarUrl(c.avatarId),
    kycStatus: kycStatusOf(c),
    kycNote: c.kycNote,
    since: c.createdAt,
    lastDelivery: last && {
      type: last.deliveryType,
      country: last.country,
      state: last.state,
      city: last.city,
      address: last.address,
      port: last.port,
      shippingMethod: last.shippingMethod,
      payment: last.paymentMethod,
    },
  });
});

const summary = o => ({
  reference: o.reference,
  status: o.status,
  statusText: STATUS_TEXT[o.status],
  createdAt: o.createdAt,
  deliveryType: o.deliveryType,
  destination: [o.city, o.state, o.country].filter(Boolean).join(', '),
  currency: o.currency,
  total: toMajor(o.total),
  subtotal: toMajor(o.subtotal),
  deliveryFee: toMajor(o.deliveryFee),
  quoteNeeded: o.quoteNeeded,
  paymentStatus: o.paymentStatus,
  currentLocation: o.currentLocation,
  locationUpdatedAt: o.locationUpdatedAt,
  trackingNumber: o.trackingNumber,
  itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
  items: o.items.map(i => ({
    name: i.productName, size: i.variantLabel, qty: i.quantity,
    image: i.variant?.product ? asset(packImage(i.variant.product, i.variantLabel)) : null,
    // for reorder / buy again; null when that pack size is no longer sold
    productId: i.variant?.active && i.variant.product?.active ? i.variant.product.slug : null,
    sizeId: i.variant?.active && i.variant.product?.active ? i.variant.code : null,
  })),
});

r.get('/orders', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { customerId: req.customer.id },
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { variant: { include: { product: true } } } } },
  });
  res.json(orders.map(summary));
});

r.get('/orders/:reference', async (req, res) => {
  const o = await prisma.order.findFirst({
    where: { reference: String(req.params.reference).toUpperCase(), customerId: req.customer.id },
    include: {
      items: { include: { variant: { include: { product: true } } } },
      events: { where: { public: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  res.json({
    ...summary(o),
    deliveryFee: toMajor(o.deliveryFee),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    paidAt: o.paidAt,
    canPay: canPay(o),
    payOnline: paymentsEnabled(),
    // bank details only once the order is confirmed and waiting for payment
    bank: canPay(o) ? await bankFor(o.currency) : null,
    transferSentAt: o.transferSentAt,
    trackingNumber: o.trackingNumber,
    port: o.port,
    address: o.address,
    notes: o.notes,
    items: o.items.map(i => ({
      name: i.productName,
      size: i.variantLabel,
      qty: i.quantity,
      unitPrice: toMajor(i.unitPrice),
      lineTotal: toMajor(i.lineTotal),
      // used by "Reorder"; null when that pack size no longer exists
      productId: i.variant?.active && i.variant.product.active ? i.variant.product.slug : null,
      sizeId: i.variant?.active && i.variant.product.active ? i.variant.code : null,
    })),
    events: o.events.map(e => ({ status: e.status, note: e.note, location: e.location, at: e.createdAt })),
  });
});

// Pay a confirmed order online: returns the Flutterwave checkout link.
r.post('/orders/:reference/pay', async (req, res) => {
  const o = await prisma.order.findFirst({ where: { reference: String(req.params.reference).toUpperCase(), customerId: req.customer.id } });
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (!canPay(o)) return res.status(400).json({ error: o.paymentStatus === 'paid' ? 'This order is already paid.' : 'This order can be paid once we have confirmed the final price and delivery cost.' });
  if (!paymentsEnabled()) return res.status(503).json({ error: 'Online payment is not switched on yet. Please pay by bank transfer using the details we emailed you, or contact us.' });
  try { res.json({ link: await createPaymentLink(o, req.customer) }); }
  catch (err) { console.error('Flutterwave payment link:', err.message); res.status(502).json({ error: 'We could not start the payment. Please try again in a moment.' }); }
});

// The customer says they've paid by bank transfer. We note it and alert the admin, who checks and marks it paid.
r.post('/orders/:reference/transfer-sent', async (req, res) => {
  const o = await prisma.order.findFirst({ where: { reference: String(req.params.reference).toUpperCase(), customerId: req.customer.id } });
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (!canPay(o)) return res.status(400).json({ error: o.paymentStatus === 'paid' ? 'This order is already paid.' : 'This order is not ready for payment yet.' });
  const payer = clean(req.body?.payer, 120);
  const updated = await prisma.order.update({
    where: { id: o.id },
    data: {
      transferSentAt: new Date(), paymentMethod: 'Bank transfer',
      events: { create: { status: o.status, note: `You told us you paid by bank transfer${payer ? ` from ${payer}` : ''}. We'll confirm as soon as it arrives.`, public: true, createdBy: 'customer' } },
    },
  });
  transferReportedAlert(updated, req.customer, payer);
  res.json({ ok: true, transferSentAt: updated.transferSentAt });
});

// Back from Flutterwave checkout: check the transaction and mark the order paid if it went through.
r.post('/orders/:reference/verify-payment', async (req, res) => {
  const o = await prisma.order.findFirst({ where: { reference: String(req.params.reference).toUpperCase(), customerId: req.customer.id } });
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.paymentStatus === 'paid') return res.json({ paid: true });
  const id = String(req.body?.transactionId || '');
  if (!id || !paymentsEnabled()) return res.json({ paid: false });
  try {
    const result = await confirmTransaction(id);
    res.json({ paid: Boolean(result.ok && result.order?.reference === o.reference), message: result.reason });
  } catch (err) { console.error('Flutterwave verify:', err.message); res.json({ paid: false, message: 'We could not confirm the payment yet. If you were charged, it will update shortly.' }); }
});

// Update name, phone and company.
r.patch('/me', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) { data.name = clean(b.name); if (!data.name) return res.status(400).json({ error: 'Your name is required.' }); }
  if (b.phone !== undefined) { data.phone = clean(b.phone, 40); if (data.phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Enter a phone or WhatsApp number.' }); }
  if (b.company !== undefined) data.company = clean(b.company) || null;
  if (b.country !== undefined) data.country = clean(b.country, 80) || null;
  const c = await prisma.customer.update({ where: { id: req.customer.id }, data });
  res.json({ name: c.name, phone: c.phone, company: c.company, country: c.country });
});

// Set or change the password. Changing needs the current one; setting one for the first time doesn't
// (the customer is already signed in through an email link).
r.post('/password', async (req, res) => {
  const { current = '', password = '' } = req.body || {};
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (req.customer.passwordHash && !(await bcrypt.compare(String(current), req.customer.passwordHash))) {
    return res.status(400).json({ error: 'Your current password is not correct.' });
  }
  await prisma.customer.update({ where: { id: req.customer.id }, data: { passwordHash: await bcrypt.hash(String(password), 10), pendingPasswordHash: null } });
  res.json({ ok: true });
});

// Tracking history: every public status update across the customer's orders, newest first.
r.get('/activity', async (req, res) => {
  const events = await prisma.orderStatusEvent.findMany({
    where: { public: true, order: { customerId: req.customer.id } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { order: { select: { reference: true, status: true, trackingNumber: true, city: true, country: true, currentLocation: true } } },
  });
  res.json(events.map(e => ({
    id: e.id, status: e.status, note: e.note, location: e.location, at: e.createdAt, currentLocation: e.order.currentLocation,
    reference: e.order.reference, currentStatus: e.order.status, trackingNumber: e.order.trackingNumber,
    destination: [e.order.city, e.order.country].filter(Boolean).join(', '),
  })));
});

/* ---------- saved addresses ---------- */
function addressData(b = {}) {
  const local = b.deliveryType === 'local';
  const d = {
    label: clean(b.label, 40) || 'Home',
    deliveryType: local ? 'local' : 'international',
    fullName: clean(b.fullName),
    phone: clean(b.phone, 40),
    country: local ? 'Nigeria' : clean(b.country, 80),
    state: local ? clean(b.state, 80) : clean(b.state, 80) || null,
    city: clean(b.city, 80),
    address: clean(b.address, 300) || null,
    port: local ? null : clean(b.port, 120) || null,
    isDefault: Boolean(b.isDefault),
  };
  const errors = [];
  if (!d.fullName) errors.push('Recipient name is required.');
  if (d.phone.replace(/\D/g, '').length < 7) errors.push('A phone number is required.');
  if (!d.city) errors.push('City is required.');
  if (local) {
    if (!d.state) errors.push('State is required.');
    if (!d.address) errors.push('Street address is required.');
  } else {
    if (!d.country) errors.push('Country is required.');
    if (!d.port) errors.push('Destination port or airport is required.');
  }
  return { d, errors };
}

r.get('/addresses', async (req, res) => {
  res.json(await prisma.address.findMany({ where: { customerId: req.customer.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }));
});

r.post('/addresses', async (req, res) => {
  const { d, errors } = addressData(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const count = await prisma.address.count({ where: { customerId: req.customer.id } });
  if (count >= 20) return res.status(400).json({ errors: ['You can save up to 20 addresses.'] });
  if (d.isDefault || count === 0) {
    d.isDefault = true;
    await prisma.address.updateMany({ where: { customerId: req.customer.id }, data: { isDefault: false } });
  }
  res.status(201).json(await prisma.address.create({ data: { ...d, customerId: req.customer.id } }));
});

r.patch('/addresses/:id', async (req, res) => {
  const existing = await prisma.address.findFirst({ where: { id: req.params.id, customerId: req.customer.id } });
  if (!existing) return res.status(404).json({ error: 'Address not found.' });
  const { d, errors } = addressData({ ...existing, ...req.body });
  if (errors.length) return res.status(400).json({ errors });
  if (d.isDefault) await prisma.address.updateMany({ where: { customerId: req.customer.id }, data: { isDefault: false } });
  res.json(await prisma.address.update({ where: { id: existing.id }, data: d }));
});

r.delete('/addresses/:id', async (req, res) => {
  const existing = await prisma.address.findFirst({ where: { id: req.params.id, customerId: req.customer.id } });
  if (!existing) return res.status(404).json({ error: 'Address not found.' });
  await prisma.address.delete({ where: { id: existing.id } });
  if (existing.isDefault) {
    const next = await prisma.address.findFirst({ where: { customerId: req.customer.id }, orderBy: { createdAt: 'desc' } });
    if (next) await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  res.json({ ok: true });
});

// Ask for a wholesale account (from the dashboard). The admin approves or declines it.
r.post('/wholesale-apply', async (req, res) => {
  const c = req.customer;
  if (c.wholesaleStatus === 'approved') return res.json({ wholesaleStatus: 'approved' });
  const company = clean(req.body?.company) || c.company;
  if (!company) return res.status(400).json({ error: 'Please enter your business or company name.' });
  const updated = await prisma.customer.update({ where: { id: c.id }, data: { accountType: 'wholesale', wholesaleStatus: 'pending', company, buyerType: 'business' } });
  newWholesaleAlert(updated, clean(req.body?.note, 600));
  res.json({ wholesaleStatus: 'pending' });
});

/* ---------- wishlist ---------- */
// Saved per pack size. Older entries saved the whole product; those come back with sizeId null.
r.get('/wishlist', async (req, res) => {
  const [packs, legacy] = await Promise.all([
    prisma.savedPack.findMany({ where: { customerId: req.customer.id, product: { active: true } }, orderBy: { createdAt: 'desc' }, include: { product: true } }),
    prisma.wishlistItem.findMany({ where: { customerId: req.customer.id, product: { active: true } }, orderBy: { createdAt: 'desc' }, include: { product: true } }),
  ]);
  res.json([
    ...packs.map(i => ({ productId: i.product.slug, sizeId: i.sizeCode, addedAt: i.createdAt })),
    ...legacy.map(i => ({ productId: i.product.slug, sizeId: null, addedAt: i.createdAt })),
  ]);
});

r.post('/wishlist', async (req, res) => {
  const product = await prisma.product.findFirst({ where: { slug: String(req.body?.productId || ''), active: true }, include: { variants: true } });
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const sizeCode = req.body?.sizeId ? String(req.body.sizeId) : null;
  if (sizeCode) {
    if (!product.variants.some(v => v.code === sizeCode)) return res.status(404).json({ error: 'Pack size not found.' });
    const found = await prisma.savedPack.findFirst({ where: { customerId: req.customer.id, productId: product.id, sizeCode } });
    if (!found) await prisma.savedPack.create({ data: { customerId: req.customer.id, productId: product.id, sizeCode } });
  } else {
    await prisma.wishlistItem.upsert({
      where: { customerId_productId: { customerId: req.customer.id, productId: product.id } },
      update: {},
      create: { customerId: req.customer.id, productId: product.id },
    });
  }
  res.status(201).json({ ok: true });
});

// DELETE /wishlist/:productId?size=code removes one pack size; without ?size it removes an old whole-product entry.
r.delete('/wishlist/:productId', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { slug: String(req.params.productId) } });
  if (product) {
    if (req.query.size) await prisma.savedPack.deleteMany({ where: { customerId: req.customer.id, productId: product.id, sizeCode: String(req.query.size) } });
    else await prisma.wishlistItem.deleteMany({ where: { customerId: req.customer.id, productId: product.id } });
  }
  res.json({ ok: true });
});

/* ---------- profile photo ---------- */
r.post('/avatar', rawUpload(IMAGE_TYPES, '3mb'), async (req, res) => {
  const f = await saveFile(req, res, { kind: 'avatar', types: IMAGE_TYPES, customerId: req.customer.id, maxMb: 2 });
  if (!f) return;
  await prisma.customer.update({ where: { id: req.customer.id }, data: { avatarId: f.id } });
  await removeFile(req.customer.avatarId);
  res.status(201).json({ avatarUrl: avatarUrl(f.id) });
});

r.delete('/avatar', async (req, res) => {
  await prisma.customer.update({ where: { id: req.customer.id }, data: { avatarId: null } });
  await removeFile(req.customer.avatarId);
  res.json({ avatarUrl: null });
});

/* ---------- KYC (identity verification) ---------- */
const kycOut = c => ({
  status: kycStatusOf(c), idType: c.kycIdType, idNumber: c.kycIdNumber, note: c.kycNote,
  hasDocument: Boolean(c.kycDocId), hasExtra: Boolean(c.kycExtraId),
  submittedAt: c.kycSubmittedAt, reviewedAt: c.kycReviewedAt, idTypes: KYC_ID_TYPES,
});
r.get('/kyc', (req, res) => res.json(kycOut(req.customer)));

// Step 1: upload each document; returns its id. Step 2: submit the form with those ids.
r.post('/kyc/files', rawUpload(DOC_TYPES, '6mb'), async (req, res) => {
  if (req.customer.kycStatus === 'approved') return res.status(400).json({ error: 'Your account is already verified.' });
  const f = await saveFile(req, res, { kind: 'kyc', types: DOC_TYPES, customerId: req.customer.id, maxMb: 5 });
  if (f) res.status(201).json({ id: f.id });
});

r.post('/kyc', async (req, res) => {
  const c = req.customer;
  if (c.kycStatus === 'approved') return res.status(400).json({ error: 'Your account is already verified.' });
  if (c.kycStatus === 'pending') return res.status(400).json({ error: 'Your documents are already being reviewed.' });
  const b = req.body || {};
  const idType = clean(b.idType, 60);
  const idNumber = clean(b.idNumber, 40);
  const errors = [];
  if (!KYC_ID_TYPES.includes(idType)) errors.push('Choose the type of ID.');
  if (idNumber.length < 4) errors.push('Enter the ID number.');
  const own = async id => id && (await prisma.storedFile.findFirst({ where: { id: String(id), customerId: c.id, kind: 'kyc' } }));
  const doc = await own(b.documentId);
  const extra = b.extraId ? await own(b.extraId) : null;
  if (!doc) errors.push('Upload a photo or scan of the ID.');
  if (b.extraId && !extra) errors.push('The second document did not upload. Please try again.');
  if (errors.length) return res.status(400).json({ errors });
  // replace any earlier (rejected) documents
  for (const old of [c.kycDocId, c.kycExtraId]) if (old && old !== doc.id && old !== extra?.id) await removeFile(old);
  const updated = await prisma.customer.update({
    where: { id: c.id },
    data: { kycStatus: 'pending', kycIdType: idType, kycIdNumber: idNumber, kycDocId: doc.id, kycExtraId: extra?.id || null, kycNote: null, kycSubmittedAt: new Date(), kycReviewedAt: null },
  });
  kycSubmittedAlert(updated);
  res.json(kycOut(updated));
});

/* ---------- messages from Farmora ---------- */
r.get('/notices', async (req, res) => {
  const list = await prisma.customerNotice.findMany({ where: { customerId: req.customer.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(list.map(n => ({ id: n.id, title: n.title, body: n.body, link: n.link, read: Boolean(n.readAt), at: n.createdAt })));
});

r.post('/notices/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 100) : null;
  await prisma.customerNotice.updateMany({
    where: { customerId: req.customer.id, ...(ids ? { id: { in: ids } } : {}), OR: [{ readAt: null }, { readAt: { isSet: false } }] },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

export default r;
