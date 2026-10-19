'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createApiRouter } = require('./routes/api');
const { AppError } = require('./errors');

function createApp(db, { live, log = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // CSRF defence in depth: the session cookie is SameSite=Strict, and every
  // state-changing request must be JSON (which a cross-site HTML form cannot send).
  app.use('/api', (req, res, next) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (mutating && hasBody && !req.is('application/json')) {
      return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON'));
    }
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', createApiRouter(db, { live }));
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));

  // Serve the built frontend if present (single-process production mode).
  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
    }
    if (err.code === 'SQLITE_BUSY') {
      return res.status(503).json({ error: { code: 'BUSY', message: 'The system is busy, please retry' } });
    }
    log.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp };
