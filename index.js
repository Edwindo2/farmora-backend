import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import publicRoutes from './src/routes/public.js';
import adminRoutes, { UPLOAD_DIR } from './src/routes/admin.js';
import accountRoutes from './src/routes/account.js';
import { prisma } from './src/db.js';

const PORT = process.env.PORT || 5050;
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-Farmora-Client'] }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: false }));
// Render's health check: only answers ok once the database is reachable too.
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    console.error('Health check: database unreachable', err.message);
    res.status(503).json({ ok: false, db: 'down' });
  }
});
// The customer API is served at /api/v1 (use this from mobile apps: it stays stable) and at /api (the website).
for (const base of ['/api/v1', '/api']) {
  app.use(`${base}/account`, accountRoutes);
  app.use(base, publicRoutes);
}
app.use('/api/admin', adminRoutes);

// Express 5 forwards errors thrown in async route handlers here.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

app.listen(PORT, () => console.log(`Farmora API running on http://localhost:${PORT}`));
