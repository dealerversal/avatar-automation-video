// src/gateway.js
import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { connectDB, getAvatarInstancesCollection } from './db.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import {
    createOrProvisionInstance,
    handleInstanceAction,
    checkInstanceStatus,
    getNextAvailablePort,
} from './manager/instanceManager.js';
import { authenticateAuth } from './middlewares/superAdminAuth.js';

const app = express();

app.set('trust proxy', 1);
app.use(cors());

// Parse JSON body only for manager API (do NOT consume stream for reverse proxy)
app.use('/api/manager', express.json({ limit: '100mb' }));
app.use('/api/manager', express.urlencoded({ extended: true }));

// Cache of instanceId -> port (invalidated/refreshed periodically)
const instancePortCache = new Map();

async function getInstancePort(instanceId) {
    if (instancePortCache.has(instanceId)) {
        return instancePortCache.get(instanceId);
    }
    try {
        const col = getAvatarInstancesCollection();
        const inst = await col.findOne({ instanceId: instanceId.toLowerCase() });
        if (inst && inst.port) {
            instancePortCache.set(instanceId, inst.port);
            return inst.port;
        }
    } catch (err) {
        logger.error(`[Gateway] Error fetching port for ${instanceId}:`, err);
    }
    return null;
}

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    res.json({
        status: 'ok',
        service: 'avatar-gateway',
        gatewayPort: config.port,
        cachedInstances: Array.from(instancePortCache.keys()),
        timestamp: new Date().toISOString(),
    });
});

// ── Instance Manager API ──────────────────────────────────────────────────────
const managerRouter = express.Router();

// Authenticate manager routes
managerRouter.use(authenticateAuth);

managerRouter.get('/next-port', async (_req, res) => {
    try {
        const port = await getNextAvailablePort();
        res.json({ success: true, nextPort: port });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

managerRouter.get('/list', async (req, res) => {
    try {
        const col = getAvatarInstancesCollection();
        const query = req.query.username ? { username: req.query.username } : {};
        const list = await col.find(query).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, items: list });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

managerRouter.get('/status/:instanceId', async (req, res) => {
    try {
        const status = await checkInstanceStatus(req.params.instanceId);
        res.json({ success: true, data: status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

managerRouter.post('/create', async (req, res) => {
    try {
        const result = await createOrProvisionInstance(req.body);
        // Refresh cache
        if (result?.instance?.instanceId && result?.instance?.port) {
            instancePortCache.set(result.instance.instanceId, result.instance.port);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

managerRouter.post('/action', async (req, res) => {
    try {
        const { instanceId, action } = req.body;
        if (!instanceId || !action) {
            return res.status(400).json({ success: false, error: 'instanceId and action are required' });
        }
        const result = await handleInstanceAction(instanceId, action);
        if (action === 'delete') {
            instancePortCache.delete(instanceId);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.use('/api/manager', managerRouter);

// ── Dynamic Reverse Proxy ────────────────────────────────────────────────────
// Handles /:instanceId/* and /:instanceId
app.use(async (req, res, next) => {
    const rawPath = req.url; // e.g. "/inst_test_01/flow-login?token=abc" or "/inst_test_01"
    const pathParts = req.path.split('/').filter(Boolean); // ["inst_test_01", "flow-login"]

    if (pathParts.length === 0) {
        // Root path
        return res.json({
            message: 'DealerVersal Avatar Automation Gateway',
            service: 'avatar-gateway',
            health: '/health',
        });
    }

    const firstSegment = pathParts[0];

    // Check if firstSegment is an instance
    let targetPort = await getInstancePort(firstSegment);

    if (!targetPort) {
        // Check if there's a default instance running on port 5101
        if (firstSegment === 'flow-login' || firstSegment === 'api' || firstSegment === 'downloads') {
            // Default instance fallback
            targetPort = 5101;
            // Leave URL unmodified
            return proxyRequest(req, res, targetPort, req.url);
        }
        return res.status(404).json({
            success: false,
            error: `Avatar instance "${firstSegment}" not found or not active.`,
        });
    }

    // Strip the /:instanceId prefix
    const subPath = '/' + pathParts.slice(1).join('/');
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetUrl = (subPath === '/' ? '' : subPath) + queryString || '/';

    return proxyRequest(req, res, targetPort, targetUrl);
});

/**
 * Native HTTP streaming reverse proxy.
 */
function proxyRequest(req, res, targetPort, targetPath) {
    const options = {
        hostname: '127.0.0.1',
        port: targetPort,
        path: targetPath,
        method: req.method,
        headers: {
            ...req.headers,
            host: `127.0.0.1:${targetPort}`,
            'x-forwarded-host': req.headers.host,
            'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
        },
        timeout: 300000, // 5 min timeout for video generation
    };

    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        logger.error(`[Gateway Proxy Error] targetPort=${targetPort} path=${targetPath}: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({
                success: false,
                error: `Failed to connect to avatar instance process on port ${targetPort} (${err.message})`,
            });
        }
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({ success: false, error: 'Avatar instance request timed out' });
        }
    });

    req.pipe(proxyReq, { end: true });
}

// ── Start Server ─────────────────────────────────────────────────────────────
async function startGateway() {
    try {
        await connectDB();
        
        // Pre-populate instance cache from DB
        const col = getAvatarInstancesCollection();
        const allInstances = await col.find({}).toArray();
        for (const inst of allInstances) {
            if (inst.instanceId && inst.port) {
                instancePortCache.set(inst.instanceId, inst.port);
            }
        }
        logger.info(`[Gateway] Loaded ${instancePortCache.size} avatar instances into cache.`);

        const server = http.createServer(app);

        // Handle WebSocket / Upgrade proxy if required
        server.on('upgrade', async (req, socket, head) => {
            const pathParts = (req.url || '').split('?')[0].split('/').filter(Boolean);
            if (pathParts.length > 0) {
                const firstSeg = pathParts[0];
                const port = await getInstancePort(firstSeg);
                if (port) {
                    const subPath = '/' + pathParts.slice(1).join('/');
                    const proxyReq = http.request({
                        hostname: '127.0.0.1',
                        port,
                        path: subPath,
                        method: req.method,
                        headers: req.headers,
                    });
                    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
                        socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
                        proxySocket.pipe(socket);
                        socket.pipe(proxySocket);
                    });
                    proxyReq.on('error', () => socket.destroy());
                    proxyReq.end();
                    return;
                }
            }
            socket.destroy();
        });

        server.listen(config.port, () => {
            logger.info(`⚡ Avatar Dynamic Gateway running on http://localhost:${config.port}`);
            logger.info(`🩺 Gateway Health: http://localhost:${config.port}/health`);
        });
    } catch (err) {
        logger.error('[Gateway] Startup failed:', err);
        process.exit(1);
    }
}

startGateway();

export default app;
