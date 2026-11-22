import jwt from 'jsonwebtoken';
import { prisma } from './db.js';

const COOKIE = 'farmora_admin';
const SECRET = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set in .env');
  return process.env.JWT_SECRET;
};

export function setSession(res, admin) {
  const token = jwt.sign({ sub: admin.id, email: admin.email, role: admin.role }, SECRET(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// Express middleware: only signed-in admins get through.
export async function requireAdmin(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies?.[COOKIE] || '', SECRET());
    const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin) throw new Error('gone');
    req.admin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in.' });
  }
}

// Very small in-memory limiter for the login route (per IP).
const attempts = new Map();
export function loginLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  if (a.length >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  a.push(now);
  attempts.set(key, a);
  next();
}

/* ---------- customer "My orders" session (signed in by email link) ---------- */
const CUSTOMER_COOKIE = 'farmora_customer';
const CUSTOMER_DAYS = 30;

// The same signed token works as a browser cookie (website) or an "Authorization: Bearer" header (mobile app).
export function customerToken(customer) {
  return jwt.sign({ sub: customer.id, kind: 'customer' }, SECRET(), { expiresIn: `${CUSTOMER_DAYS}d` });
}
const bearer = req => (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
const customerJwt = req => bearer(req) || req.cookies?.[CUSTOMER_COOKIE] || '';
// Apps send "X-Farmora-Client: app" and get the token in the response body instead of relying on cookies.
export const isAppClient = req => req.get('x-farmora-client') === 'app';

export function setCustomerSession(res, customer) {
  const token = customerToken(customer);
  res.cookie(CUSTOMER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: CUSTOMER_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearCustomerSession(res) {
  res.clearCookie(CUSTOMER_COOKIE, { path: '/' });
}

export async function requireCustomer(req, res, next) {
  try {
    const payload = jwt.verify(customerJwt(req), SECRET());
    if (payload.kind !== 'customer') throw new Error('wrong kind');
    const customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
    if (!customer) throw new Error('gone');
    req.customer = customer;
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in.' });
  }
}

// Like requireCustomer, but lets signed-out visitors through (req.customer is then null).
export async function optionalCustomer(req, _res, next) {
  req.customer = null;
  try {
    const payload = jwt.verify(customerJwt(req), SECRET());
    if (payload.kind === 'customer') req.customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
  } catch { /* not signed in */ }
  next();
}

// Limits sign-in link requests: 5 per email and 20 per IP every 15 minutes.
const linkHits = new Map();
export function linkLimiter(req, res, next) {
  const now = Date.now();
  const keys = [`ip:${req.ip}`, `em:${String(req.body?.email || '').trim().toLowerCase()}`];
  const limits = [20, 5];
  for (let i = 0; i < keys.length; i++) {
    const hits = (linkHits.get(keys[i]) || []).filter(t => now - t < 15 * 60 * 1000);
    if (hits.length >= limits[i]) return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
    hits.push(now);
    linkHits.set(keys[i], hits);
  }
  next();
}
