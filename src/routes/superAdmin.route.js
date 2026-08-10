import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDB } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { authenticateSuperAdmin } from '../middlewares/superAdminAuth.js';

const router = express.Router();

function generateToken(superAdminId, username, email, role = 'super_admin') {
    return jwt.sign(
        { userId: superAdminId.toString(), username, email, role, isSuperAdmin: true },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
    );
}

// POST /api/super-admin/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required.' });
        }

        const db = getDB();
        const superAdmins = db.collection('super_admins');

        const admin = await superAdmins.findOne({ email: email.toLowerCase().trim() });
        if (!admin) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        const hashToCheck = admin.passwordHash || admin.password;
        const isMatch = await bcrypt.compare(password, hashToCheck);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        const token = generateToken(admin._id, admin.username, admin.email, admin.role || 'super_admin');

        await superAdmins.updateOne(
            { _id: admin._id },
            { $set: { currentToken: token, updatedAt: new Date() } }
        );

        logger.info(`[SuperAdminRoute] Successful login for super admin: ${admin.email}`);

        // Set HttpOnly cookie for extra security
        res.cookie('superAdminToken', token, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 15 * 24 * 60 * 60 * 1000, // 15 days
            sameSite: 'lax',
            path: '/',
        });

        res.json({
            success: true,
            message: 'Super Admin login successful',
            token,
            user: {
                id: admin._id.toString(),
                username: admin.username,
                email: admin.email,
                name: admin.name || admin.username,
                role: admin.role || 'super_admin',
            },
        });
    } catch (error) {
        logger.error('[SuperAdminRoute] Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/super-admin/me
router.get('/me', authenticateSuperAdmin, (req, res) => {
    res.json({
        success: true,
        user: req.user,
    });
});

export default router;
