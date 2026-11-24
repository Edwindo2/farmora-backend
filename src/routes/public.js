import { Router } from 'express';
import { prisma, makeReference, toMajor } from '../db.js';
import { CONTACT_TOPICS, SHIPPING_METHODS, STATUS_TEXT } from '../constants.js';
import { orderReceivedEmail, newOrderAlert } from '../mailer.js';
import { confirmTransaction, paymentsEnabled } from '../flutterwave.js';
import { getSite, getFaqGroups, getFx } from '../settings.js';
import { requireCustomer, optionalCustomer } from '../auth.js';

const r = Router();
// Price tier of the signed-in customer: approved distributors and wholesale accounts get their own prices.
const tierOf = c => (c?.wholesaleStatus === 'approved' && ['wholesale', 'distributor'].includes(c.accountType) ? c.accountType : null);
// Unit price (minor units) for a pack size and tier. Distributor price falls back to wholesale, then the normal price.
const unitPrice = (v, tier, local) => {
  const [base, w, d] = local ? [v.priceNgn, v.wholesaleNgn, v.distributorNgn] : [v.priceUsd, v.wholesaleUsd, v.distributorUsd];
  if (tier === 'distributor') return d ?? w ?? base;
  if (tier === 'wholesale') return w ?? base;
  return base;
};
// Full URL for an image path when PUBLIC_URL is set (needed by mobile apps); relative paths otherwise.
export const asset = p => (p && p.startsWith('/') && process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}${p}` : p || null);

// Photo for a pack size. Red palm oil has bottle/jerrycan photos by volume; other oils use their own photo.
export function packImage(product, label) {
  if (product.slug === 'red-palm-oil') {
    const m = String(label).match(/([\d.]+)\s*(l|litre|liter)/i);
    const litres = m ? Number(m[1]) : null;
    if (litres != null && litres <= 2) return '/home/pack-bottle.jpg';
    if (litres != null && litres <= 10) return '/home/pack-jerrycan.jpg';
    if (litres != null && litres <= 30) return '/home/pack-25l.jpg';
  }
  return product.image || '/home/pack-25l.jpg';
}

// Storefront shape for a pack size. Approved distributors and wholesale accounts get their own prices where set;
// `tier` tells the storefront that the price shown is theirs (prices are hidden from everyone else).
const sizeOut = (v, tier, product) => ({
  id: v.code,
  label: v.label,
  image: asset(packImage(product, v.label)),
  ngn: toMajor(unitPrice(v, tier, true)),
  usd: toMajor(unitPrice(v, tier, false)),
  ...(tier ? { tier, retailNgn: toMajor(v.priceNgn), retailUsd: toMajor(v.priceUsd), wholesale: true } : {}),
  inStock: v.stock == null || v.stock > 0,
});
const isEmail = v => /^\S+@\S+\.\S+$/.test(String(v || ''));
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// Contact/location details and the FAQ for the website.
r.get('/site', async (_req, res) => {
  const [reviews, news] = await Promise.all([
    prisma.review.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' }, take: 12 }),
    prisma.newsPost.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);
  const fx = await getFx();
  res.json({
    apiVersion: 1,
    fx: fx.rates,
    contact: await getSite(),
    faq: await getFaqGroups(),
    reviews: reviews.map(r => ({ id: r.id, name: r.name, place: r.place, quote: r.quote, rating: r.rating })),
    news: news.map(n => ({ id: n.id, title: n.title, summary: n.summary, image: asset(n.image), link: n.link, date: n.createdAt })),
  });
});

// Catalog for the storefront. Prices are returned in whole units (naira / dollars).
r.get('/products', optionalCustomer, async (req, res) => {
  const products = await prisma.product.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    include: { variants: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
  });
  res.json(
    products.map(p => ({
      id: p.slug,
      name: p.name,
      tag: p.tag,
      description: p.description,
      image: asset(p.image),
      sizes: p.variants.map(v => sizeOut(v, tierOf(req.customer), p)),
    })),
  );
});

// One product by slug, for the product page.
r.get('/products/:slug', optionalCustomer, async (req, res) => {
  const p = await prisma.product.findFirst({
    where: { slug: String(req.params.slug), active: true },
    include: { variants: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
  });
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  res.json({
    id: p.slug, name: p.name, tag: p.tag, description: p.description, image: asset(p.image),
    sizes: p.variants.map(v => sizeOut(v, tierOf(req.customer), p)),
  });
});

const MIN_QTY = 5; // minimum order: 5 packs, gallons or drums of each pack size

// Flutterwave tells us about payments here. The "verif-hash" header must match FLW_SECRET_HASH,
// and the transaction is checked with Flutterwave before anything is marked paid.
r.post('/payments/flutterwave/webhook', async (req, res) => {
  if (!paymentsEnabled() || !process.env.FLW_SECRET_HASH || req.get('verif-hash') !== process.env.FLW_SECRET_HASH) return res.status(401).end();
  const id = req.body?.data?.id;
  if (id) {
    try { await confirmTransaction(id); } catch (err) { console.error('Flutterwave webhook:', err.message); }
  }
  res.status(200).end();
});

// Place an order. Customers must be signed in, so every order shows in their dashboard.
r.post('/orders', requireCustomer, async (req, res) => {
  const { customer: form = {}, delivery = {}, items = [], notes = '', payment = '', neededBy = '' } = req.body || {};
  // the account's email is always used; name/phone/company come from the form or the account
  const customer = { ...form, email: req.customer.email, name: form.name || req.customer.name, phone: form.phone || req.customer.phone, company: form.company || req.customer.company };
  const errors = [];
  const local = delivery.type === 'local';

  if (!['local', 'international'].includes(delivery.type)) errors.push('Choose local or international delivery.');
  if (!str(customer.name)) errors.push('Name is required.');
  if (!isEmail(customer.email)) errors.push('A valid email is required.');
  if (str(customer.phone).replace(/\D/g, '').length < 7) errors.push('A phone or WhatsApp number is required.');
  if (customer.buyerType === 'business' && !str(customer.company)) errors.push('Company name is required for business orders.');
  if (local) {
    if (!str(delivery.state)) errors.push('State is required.');
    if (!str(delivery.city)) errors.push('City is required.');
    if (!str(delivery.address)) errors.push('Delivery address is required.');
  } else {
    if (!str(delivery.country)) errors.push('Country is required.');
    if (!str(delivery.city)) errors.push('City is required.');
    if (!str(delivery.port)) errors.push('Destination port or airport is required.');
  }
  if (!Array.isArray(items) || items.length === 0) errors.push('Add at least one product.');
  if (errors.length) return res.status(400).json({ errors });

  // Price every line from the database, never from the client.
  const currency = local ? 'NGN' : 'USD';
  const lines = [];
  for (const item of items) {
    const variant = await prisma.productVariant.findFirst({
      where: { code: String(item.sizeId), active: true, product: { slug: String(item.productId), active: true } },
      include: { product: true },
    });
    const qty = Number.parseInt(item.qty, 10);
    if (!variant) return res.status(400).json({ errors: ['One of the items is no longer available.'] });
    if (!(qty >= MIN_QTY && qty <= 100000)) return res.status(400).json({ errors: [`The minimum order is ${MIN_QTY} of each pack size (${variant.label}).`] });
    // prices are only shown to approved distributors and wholesale accounts; everyone else gets a quote
    const tier = tierOf(req.customer);
    const unit = tier ? unitPrice(variant, tier, local) : null;
    lines.push({
      variantId: variant.id,
      productName: variant.product.name,
      variantLabel: variant.label,
      quantity: qty,
      unitPrice: unit,
      lineTotal: unit == null ? null : unit * qty,
    });
  }
  const quoteNeeded = lines.some(l => l.unitPrice == null);
  const subtotal = quoteNeeded ? null : lines.reduce((s, l) => s + l.lineTotal, 0);

  const person = await prisma.customer.update({
    where: { id: req.customer.id },
    data: {
      name: str(customer.name), phone: str(customer.phone, 50), company: str(customer.company) || undefined,
      buyerType: customer.buyerType === 'business' ? 'business' : 'individual',
      country: req.customer.country || (local ? 'Nigeria' : str(delivery.country)),
    },
  });

  // retry on the (very unlikely) reference collision
  let order;
  for (let attempt = 0; attempt < 5 && !order; attempt++) {
    try {
      order = await prisma.order.create({
        data: {
          reference: makeReference('FM'),
          customerId: person.id,
          deliveryType: local ? 'local' : 'international',
          country: local ? 'Nigeria' : str(delivery.country),
          state: local ? str(delivery.state) : null,
          city: str(delivery.city),
          address: local ? str(delivery.address, 500) : null,
          port: local ? null : str(delivery.port),
          shippingMethod: local ? null : SHIPPING_METHODS[delivery.shipping] || (['air', 'fob', 'cif', 'advise'].includes(delivery.shipping) ? delivery.shipping : 'advise'),
          currency,
          subtotal,
          total: subtotal,
          quoteNeeded,
          paymentMethod: str(payment, 100) || null,
          neededBy: neededBy && !Number.isNaN(Date.parse(neededBy)) ? new Date(neededBy) : null,
          notes: str(notes, 2000) || null,
          items: { create: lines },
          events: { create: { status: 'received', note: STATUS_TEXT.received, createdBy: 'customer' } },
        },
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
    }
  }

  // emails are sent in the background; a slow mail server never delays the customer
  orderReceivedEmail(order, person, lines);
  newOrderAlert(order, person);

  res.status(201).json({ id: order.reference, reference: order.reference, subtotal: toMajor(subtotal), currency, quoteNeeded });
});

// Public order tracking: needs the reference and the email used on the order.
r.get('/orders/track', async (req, res) => {
  const reference = str(req.query.reference, 20).toUpperCase();
  const email = str(req.query.email).toLowerCase();
  const order = await prisma.order.findUnique({
    where: { reference },
    include: { customer: true, items: true, events: { where: { public: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!order || order.customer.email !== email) return res.status(404).json({ error: 'We could not find an order with that reference and email.' });

  res.json({
    reference: order.reference,
    status: order.status,
    statusText: STATUS_TEXT[order.status],
    createdAt: order.createdAt,
    deliveryType: order.deliveryType,
    destination: [order.city, order.state, order.country].filter(Boolean).join(', '),
    currency: order.currency,
    subtotal: toMajor(order.subtotal),
    deliveryFee: toMajor(order.deliveryFee),
    total: toMajor(order.total),
    quoteNeeded: order.quoteNeeded,
    paymentStatus: order.paymentStatus,
    trackingNumber: order.trackingNumber,
    items: order.items.map(i => ({ name: i.productName, size: i.variantLabel, qty: i.quantity, lineTotal: toMajor(i.lineTotal) })),
    events: order.events.map(e => ({ status: e.status, note: e.note, at: e.createdAt })),
  });
});

// Footer newsletter sign-up. Same answer whether or not the email was already on the list.
r.post('/newsletter', async (req, res) => {
  const email = str(req.body?.email, 120).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  await prisma.newsletterSubscriber.upsert({ where: { email }, update: {}, create: { email } });
  res.status(201).json({ ok: true });
});

// Contact form.
r.post('/contact', async (req, res) => {
  const { name, email, phone, topic, message } = req.body || {};
  const errors = [];
  if (!str(name)) errors.push('Name is required.');
  if (!isEmail(email)) errors.push('A valid email is required.');
  if (str(message, 4000).length < 5) errors.push('Please write a short message.');
  if (errors.length) return res.status(400).json({ errors });

  const known = await prisma.customer.findUnique({ where: { email: str(email).toLowerCase() } });
  const msg = await prisma.contactMessage.create({
    data: {
      reference: makeReference('MSG'),
      customerId: known?.id ?? null,
      name: str(name),
      email: str(email).toLowerCase(),
      phone: str(phone, 50) || null,
      topic: CONTACT_TOPICS.includes(topic) ? topic : CONTACT_TOPICS[0],
      message: str(message, 4000),
    },
  });
  res.status(201).json({ id: msg.reference });
});

export default r;
