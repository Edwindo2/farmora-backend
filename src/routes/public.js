import { Router } from 'express';
import { prisma, makeReference, toMajor } from '../db.js';
import { CONTACT_TOPICS, SHIPPING_METHODS, STATUS_TEXT } from '../constants.js';
import { orderReceivedEmail, newOrderAlert } from '../mailer.js';
import { getSite, getFaqGroups, getFx } from '../settings.js';
import { requireCustomer, optionalCustomer } from '../auth.js';

const r = Router();
const isWholesale = c => c?.accountType === 'wholesale' && c?.wholesaleStatus === 'approved';
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

// Storefront shape for a pack size. Approved wholesale accounts get wholesale prices where they're set.
const sizeOut = (v, wholesale, product) => ({
  id: v.code,
  label: v.label,
  image: asset(packImage(product, v.label)),
  ngn: toMajor(wholesale && v.wholesaleNgn != null ? v.wholesaleNgn : v.priceNgn),
  usd: toMajor(wholesale && v.wholesaleUsd != null ? v.wholesaleUsd : v.priceUsd),
  ...(wholesale && (v.wholesaleNgn != null || v.wholesaleUsd != null) ? { retailNgn: toMajor(v.priceNgn), retailUsd: toMajor(v.priceUsd), wholesale: true } : {}),
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
      sizes: p.variants.map(v => sizeOut(v, isWholesale(req.customer), p)),
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
    sizes: p.variants.map(v => sizeOut(v, isWholesale(req.customer), p)),
  });
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
    if (!variant || !(qty > 0 && qty <= 1000)) return res.status(400).json({ errors: ['One of the items is no longer available.'] });
    const ws = isWholesale(req.customer);
    const unit = local
      ? (ws && variant.wholesaleNgn != null ? variant.wholesaleNgn : variant.priceNgn)
      : (ws && variant.wholesaleUsd != null ? variant.wholesaleUsd : variant.priceUsd);
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
