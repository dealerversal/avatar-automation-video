import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { authenticateAuth } from '../middlewares/superAdminAuth.js';

const router = express.Router();

function generateToken(userId, username, email, role = 'user', isSuperAdmin = false) {
    return jwt.sign(
        { userId: userId.toString(), username, email, role, isSuperAdmin },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
    );
}

// POST /api/auth/login (or /api/super-admin/login)
router.post('/login', async (req, res) => {
    try {
        const { email, username, password } = req.body;
        const identifier = (email || username || '').toLowerCase().trim();

        if (!identifier || !password) {
            return res.status(400).json({ success: false, error: 'Email/Username and password are required.' });
        }

        const db = getDB();
        const users = db.collection('users');

        const user = await users.findOne({
            $or: [
                { email: identifier },
                { username: identifier },
            ],
        });

        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid username/email or password.' });
        }

        const hashToCheck = user.password || user.passwordHash;
        const isMatch = await bcrypt.compare(password, hashToCheck);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid username/email or password.' });
        }

        const isSuperAdmin = user.role === 'super_admin' || user.isSuperAdmin === true;
        const token = generateToken(user._id, user.username, user.email, user.role || 'user', isSuperAdmin);

        logger.info(`[AuthRoute] Successful login for user: ${user.username} (${user.email})`);

        res.cookie('superAdminToken', token, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 15 * 24 * 60 * 60 * 1000,
            sameSite: 'lax',
            path: '/',
        });

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user._id.toString(),
                username: user.username,
                email: user.email,
                name: user.name || user.username,
                role: user.role || 'user',
                isSuperAdmin,
            },
        });
    } catch (error) {
        logger.error('[AuthRoute] Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/auth/me (or /api/super-admin/me)
router.get('/me', authenticateAuth, (req, res) => {
    res.json({
        success: true,
        user: req.user,
    });
});

export default router;
