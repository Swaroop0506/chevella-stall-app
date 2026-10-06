import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { notFound, errorHandler } from './middleware/common.js';

import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import contactRoutes from './routes/contacts.js';
import publicRoutes from './routes/public.js';
import leadRoutes from './routes/leads.js';
import appRoutes from './routes/app.js';
import statsRoutes from './routes/stats.js';

const app = express();

// Behind nginx/Caddy in production — needed for correct req.ip in the rate limiters.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

app.use(cors({
  origin(origin, cb) {
    // Server-to-server calls and the Android app send no Origin at all.
    if (!origin) return cb(null, true);
    if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} is not in CORS_ORIGINS`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

app.use((req, _res, next) => {
  if (config.env !== 'test') {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  }
  next();
});

const v1 = express.Router();
v1.use('/auth', authRoutes);
v1.use('/events', eventRoutes);
v1.use('/leads', leadRoutes);
v1.use('/public', publicRoutes);
v1.use('/app', appRoutes);
v1.use('/', contactRoutes);   // /events/:id/contacts and /contacts/:id/*
v1.use('/', statsRoutes);     // /stats/*, /files/*, /health

app.use('/api/v1', v1);

// Bare /health for load balancers and docker healthchecks.
app.get('/health', (_req, res) => res.json({ ok: true, service: 'cf-api' }));

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[cf-api] listening on :${config.port}  (${config.env})`);
  console.log(`[cf-api] contact QRs will point at ${config.publicBaseUrl}/c/<code>`);
  console.log(`[cf-api] OCR service at ${config.ocrUrl}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[cf-api] ${sig} — draining`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

export default app;
