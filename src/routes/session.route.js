import express from 'express';
import { SessionManager } from '../services/sessionManager.js';
import { logger } from '../utils/logger.js';
import { authenticateSuperAdmin } from '../middlewares/superAdminAuth.js';

const router = express.Router();

// Apply Super Admin / User authentication
router.use(authenticateSuperAdmin);

// GET /api/session/status
router.get('/status', async (req, res) => {
    try {
        const result = await SessionManager.checkStatus();
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Status check error:', error);
        res.status(500).json({ success: false, authenticated: false, message: error.message });
    }
});

// POST /api/session/cookies - Import or update cookies directly
router.post('/cookies', async (req, res) => {
    try {
        const { cookies, storageState } = req.body || {};
        const result = await SessionManager.importSession({ cookies: cookies || req.body, storageState });
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Import cookies error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/verify - Run a live headless verification on Google FX Flow
router.post('/verify', async (req, res) => {
    try {
        const result = await SessionManager.checkStatus();
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Verify session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/import - Backward compatible import endpoint
router.post('/import', async (req, res) => {
    try {
        const result = await SessionManager.importSession(req.body);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Import session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/upload-zip - Direct ZIP extraction into profile
router.post('/upload-zip', express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'multipart/form-data', 'application/octet-stream', '*/*'], limit: '500mb' }), async (req, res) => {
    try {
        let zipBuffer = req.body;
        if (req.body && req.body.zipBase64) {
            zipBuffer = Buffer.from(req.body.zipBase64, 'base64');
        }

        if (!zipBuffer || zipBuffer.length === 0) {
            return res.status(400).json({ success: false, error: 'No zip file data received' });
        }
        const result = await SessionManager.uploadProfileZip(zipBuffer);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Upload zip error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/reset or POST /api/session/clear
router.post(['/reset', '/clear'], async (req, res) => {
    try {
        const result = await SessionManager.clearSession();
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Clear/Reset session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
