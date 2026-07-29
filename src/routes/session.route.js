// src/routes/session.route.js
import express from 'express';
import { SessionManager } from '../services/sessionManager.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// GET /api/session/status
router.get('/status', async (req, res) => {
    try {
        const result = await SessionManager.checkStatus();
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Status check error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/session/import
router.post('/import', async (req, res) => {
    try {
        const { cookies, storageState } = req.body;
        const inputData = storageState || cookies;

        if (!inputData) {
            return res.status(400).json({
                success: false,
                error: 'Missing cookies or storageState in request body.',
            });
        }

        const result = await SessionManager.importSession(inputData);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[SessionRoute] Import session error:', error);
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
