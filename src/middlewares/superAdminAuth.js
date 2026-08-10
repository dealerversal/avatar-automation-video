import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getDB } from '../db.js';
import { logger } from '../utils/logger.js';

function extractToken(req) {
    // 1. Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
    }

    // 2. Check Cookie header e.g. superAdminToken=...
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';');
        for (const c of cookies) {
            const [name, val] = c.trim().split('=');
            if (name === 'superAdminToken' && val) {
                return val;
            }
        }
    }

    return null;
}

export async function authenticateSuperAdmin(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please log in as Super Admin.',
        });
    }

    try {
        const decoded = jwt.verify(token, config.jwtSecret);

        if (!decoded.userId || (decoded.role !== 'super_admin' && !decoded.isSuperAdmin)) {
            return res.status(403).json({
                success: false,
                error: 'Forbidden: Super Admin privileges required.',
            });
        }

        const db = getDB();
        const superAdmins = db.collection('super_admins');

        let objectId;
        try {
            objectId = new ObjectId(decoded.userId);
        } catch {
            return res.status(401).json({ success: false, error: 'Invalid super admin token payload.' });
        }

        const admin = await superAdmins.findOne(
            { _id: objectId },
            { projection: { passwordHash: 0, password: 0 } }
        );

        if (!admin) {
            return res.status(401).json({ success: false, error: 'Super Admin account not found.' });
        }

        req.user = {
            id: admin._id.toString(),
            username: admin.username,
            email: admin.email,
            role: admin.role || 'super_admin',
        };

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
        }
        logger.warn(`[SuperAdminAuth] Token verification failed: ${err.message}`);
        return res.status(401).json({ success: false, error: 'Invalid authentication token.' });
    }
}
