import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

import path from 'path';
import { config } from './config.js';
import { connectDB } from './db.js';
import { logger } from './utils/logger.js';
import { registry } from './mcp/registry.js';
import fxFlowRouter from './routes/fxFlow.route.js';
import sessionRouter from './routes/session.route.js';

// ── Register MCP Tools ────────────────────────────────────────────────────────
import { GoogleFxFlowTool } from './tools/googleFxFlow.js';

registry.register(new GoogleFxFlowTool());

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();

// Enable trust proxy for Nginx reverse proxy
app.set('trust proxy', 1);

// Middleware: CORS & Static Files
app.use(cors());
app.use('/downloads', express.static(path.join(process.cwd(), 'downloads')));
app.use(express.static(path.join(process.cwd(), 'public')));

// Middleware: JSON body parser
app.use(express.json({ limit: '2mb' }));

// Middleware: Request ID
app.use((req, _res, next) => {
    req.requestId = uuidv4();
    next();
});

// Middleware: Request logger
app.use((req, _res, next) => {
    logger.info(`[Server] ${req.method} ${req.path} [${req.requestId}]`);
    next();
});

// Middleware: Rate limiting (100 requests per 15 minutes per IP)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// ── Routes ────────────────────────────────────────────────────────────────────

// Login & Session Manager UI Page
app.get(['/login', '/setup-session'], (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
});

// Health check
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'google-fx-flow-automation',
        timestamp: new Date().toISOString(),
        tools: registry.getToolNames(),
    });
});

// Primary API routes
app.use('/api/fx-flow', fxFlowRouter);
app.use('/api/session', sessionRouter);

// 404 handler
app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
    logger.error('[Server] Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start Server & Connect MongoDB ────────────────────────────────────────────
async function startServer() {
    try {
        await connectDB();
        
        app.listen(config.port, () => {
            logger.info(`🚀 Google FX Flow Automation Server running on http://localhost:${config.port}`);
            logger.info(`📋 Registered tools: ${registry.getToolNames().join(', ')}`);
            logger.info(`🩺 Health: http://localhost:${config.port}/health`);
            logger.info(`🔑 Login Page: http://localhost:${config.port}/login`);
            logger.info(`📡 API Generate: POST http://localhost:${config.port}/api/fx-flow/generate`);
            logger.info(`📡 API Status:   GET  http://localhost:${config.port}/api/fx-flow/status/:itemId`);
        });
    } catch (err) {
        logger.error(`[Server] Startup failed:`, err);
        process.exit(1);
    }
}

startServer();

export default app;

