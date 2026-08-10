import express from 'express';
import { SessionManager } from '../services/sessionManager.js';
import { logger } from '../utils/logger.js';
import { authenticateSuperAdmin } from '../middlewares/superAdminAuth.js';

const router = express.Router();

// Apply Super Admin authentication to all session management endpoints
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

// POST /api/session/import
router.post('/import', async (req, res) => {
    try {
        const result = await SessionManager.importSession(req.body);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Import session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/upload-zip
router.post('/upload-zip', express.raw({ type: 'application/zip', limit: '100mb' }), async (req, res) => {
    try {
        if (!req.body || req.body.length === 0) {
            return res.status(400).json({ success: false, error: 'No zip file data received' });
        }
        const result = await SessionManager.uploadProfileZip(req.body);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Upload zip error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/clear
router.post('/clear', async (req, res) => {
    try {
        const result = await SessionManager.clearSession();
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Clear session error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
