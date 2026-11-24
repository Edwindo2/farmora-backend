import { prisma } from './db.js';

// Contact and location details shown on the website and in emails. Edited in the admin (Location & contact).
// These defaults are placeholders, used until the admin saves real details.
export const SITE_DEFAULTS = {
  email: 'hello@farmora.com',
  phone: '+234 000 000 0000',
  phone2: '', // optional second number
  whatsapp: '',
  address: '',
  city: 'Lagos',
  state: 'Lagos',
  country: 'Nigeria',
  hours: 'Mon – Sat · 8am – 6pm WAT',
  mapUrl: '',
  hub: 'Lagos', // city orders ship from, used in the delivery section
  facebook: '',
  instagram: '',
  youtube: '',
  linkedin: '',
  tiktok: '',
};

const LIMITS = { email: 120, phone: 40, phone2: 40, whatsapp: 40, address: 200, city: 80, state: 80, country: 80, hours: 120, mapUrl: 500, hub: 80, facebook: 300, instagram: 300, youtube: 300, linkedin: 300, tiktok: 300 };

let cache = null;

export async function getSite() {
  if (cache) return cache;
  const row = await prisma.setting.findUnique({ where: { key: 'site' } });
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { /* corrupt row: fall back to defaults */ }
  cache = { ...SITE_DEFAULTS, ...saved };
  return cache;
}

// Validates and saves the details. Returns { site } or { errors }.
export async function saveSite(body = {}) {
  const errors = [];
  const next = { ...(await getSite()) };
  for (const [k, max] of Object.entries(LIMITS)) {
    if (body[k] !== undefined) next[k] = String(body[k] ?? '').trim().slice(0, max);
  }
  if (!/^\S+@\S+\.\S+$/.test(next.email)) errors.push('Enter a valid email address.');
  if (!next.city) errors.push('City is required.');
  if (!next.country) errors.push('Country is required.');
  if (next.mapUrl && !/^https:\/\/\S+$/.test(next.mapUrl)) errors.push('The map link must start with https://');
  for (const k of ['facebook', 'instagram', 'youtube', 'linkedin', 'tiktok']) {
    if (next[k] && !/^https:\/\/\S+$/.test(next[k])) errors.push(`The ${k[0].toUpperCase() + k.slice(1)} link must start with https://`);
  }
  for (const k of ['phone', 'phone2', 'whatsapp']) {
    if (next[k] && !/^[+\d][\d\s()-]{5,}$/.test(next[k])) errors.push(`Enter a valid ${k === 'whatsapp' ? 'WhatsApp' : 'phone'} number, e.g. +234 801 234 5678.`);
  }
  if (errors.length) return { errors };
  await prisma.setting.upsert({ where: { key: 'site' }, update: { value: JSON.stringify(next) }, create: { key: 'site', value: JSON.stringify(next) } });
  cache = next;
  return { site: next };
}

// Public FAQ, grouped by category in the admin's order.
export async function getFaqGroups() {
  const items = await prisma.faqItem.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  const groups = [];
  for (const it of items) {
    let g = groups.find(x => x.group === it.category);
    if (!g) groups.push((g = { group: it.category, items: [] }));
    g.items.push({ q: it.question, a: it.answer });
  }
  return groups;
}

/* ---------- display currencies for international buyers ---------- */
// Rates are "1 USD = x". Prices are always charged in USD (or NGN in Nigeria); these are for display only.
export const FX_DEFAULTS = { GBP: 0.79, EUR: 0.92, CAD: 1.37, AED: 3.67 };
export const FX_CODES = ['GBP', 'EUR', 'CAD', 'AED', 'AUD', 'CNY', 'INR', 'ZAR', 'GHS', 'KES'];
let fxCache = null;

export async function getFx() {
  if (fxCache) return fxCache;
  const row = await prisma.setting.findUnique({ where: { key: 'fx' } });
  let saved = null;
  try { saved = row ? JSON.parse(row.value) : null; } catch { /* fall back */ }
  fxCache = { rates: saved?.rates || FX_DEFAULTS, updatedAt: row?.updatedAt || null };
  return fxCache;
}

// body.rates: { GBP: 0.79, ... }; an empty or 0 value removes that currency.
export async function saveFx(body = {}) {
  const rates = {};
  for (const code of FX_CODES) {
    const v = Number(body.rates?.[code]);
    if (Number.isFinite(v) && v > 0 && v < 100000) rates[code] = Math.round(v * 10000) / 10000;
  }
  const row = await prisma.setting.upsert({ where: { key: 'fx' }, update: { value: JSON.stringify({ rates }) }, create: { key: 'fx', value: JSON.stringify({ rates }) } });
  fxCache = { rates, updatedAt: row.updatedAt };
  return fxCache;
}

/* ---------- bank transfer details ---------- */
// Kept apart from the public site settings: only shown to a signed-in customer whose order is ready to pay.
export const BANK_FIELDS = {
  bankName: 60, accountName: 100, accountNumber: 20, // Naira account
  usdBankName: 60, usdAccountName: 100, usdAccountNumber: 34, usdSwift: 20, // optional dollar (domiciliary) account
  note: 400, // extra instructions shown to the customer
};
let bankCache = null;

export async function getBank() {
  if (bankCache) return bankCache;
  const row = await prisma.setting.findUnique({ where: { key: 'bank' } });
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { /* corrupt row */ }
  bankCache = Object.fromEntries(Object.keys(BANK_FIELDS).map(k => [k, saved[k] || '']));
  return bankCache;
}

export async function saveBank(body = {}) {
  const next = { ...(await getBank()) };
  for (const [k, max] of Object.entries(BANK_FIELDS)) if (body[k] !== undefined) next[k] = String(body[k] ?? '').trim().slice(0, max);
  const errors = [];
  const ngn = [next.bankName, next.accountName, next.accountNumber];
  if (ngn.some(Boolean) && !ngn.every(Boolean)) errors.push('Fill in the bank name, account name and account number for the Naira account.');
  if (next.accountNumber && !/^\d{10}$/.test(next.accountNumber)) errors.push('A Nigerian account number (NUBAN) has 10 digits.');
  const usd = [next.usdBankName, next.usdAccountName, next.usdAccountNumber];
  if (usd.some(Boolean) && !usd.every(Boolean)) errors.push('Fill in the bank name, account name and account number for the dollar account, or leave all three empty.');
  if (errors.length) return { errors };
  await prisma.setting.upsert({ where: { key: 'bank' }, update: { value: JSON.stringify(next) }, create: { key: 'bank', value: JSON.stringify(next) } });
  bankCache = next;
  return { bank: next };
}

// The account to show for an order's currency, or null if none is set up.
export async function bankFor(currency) {
  const b = await getBank();
  if (currency === 'USD') return b.usdAccountNumber ? { bankName: b.usdBankName, accountName: b.usdAccountName, accountNumber: b.usdAccountNumber, swift: b.usdSwift, note: b.note, currency: 'USD' } : null;
  return b.accountNumber ? { bankName: b.bankName, accountName: b.accountName, accountNumber: b.accountNumber, note: b.note, currency: 'NGN' } : null;
}
