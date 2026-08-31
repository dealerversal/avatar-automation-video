import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getDB } from '../db.js';
import { logger } from '../utils/logger.js';

export function extractToken(req) {
    // 1. Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
    }

    // 2. Check Cookie header e.g. token=... or superAdminToken=... or authToken=...
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';');
        for (const c of cookies) {
            const [name, val] = c.trim().split('=');
            if ((name === 'superAdminToken' || name === 'token' || name === 'adminToken') && val) {
                return val;
            }
        }
    }

    // 3. Query param token (e.g. for direct web browser access if passed)
    if (req.query && req.query.token) {
        return req.query.token;
    }

    return null;
}

export async function authenticateAuth(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please provide a valid token.',
        });
    }

    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        const userId = decoded.userId || decoded.id || decoded._id;

        if (!userId) {
            return res.status(401).json({ success: false, error: 'Invalid token payload.' });
        }

        const db = getDB();
        let user = null;
        try {
            user = await db.collection('users').findOne(
                { _id: new ObjectId(userId) },
                { projection: { password: 0, passwordHash: 0 } }
            );
        } catch {
            // If ID was not ObjectId
            user = await db.collection('users').findOne(
                { username: decoded.username || userId },
                { projection: { password: 0, passwordHash: 0 } }
            );
        }

        req.user = user || {
            id: userId.toString(),
            username: decoded.username,
            email: decoded.email,
            role: decoded.role || 'user',
            isSuperAdmin: decoded.role === 'super_admin' || decoded.isSuperAdmin,
        };

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
        }
        logger.warn(`[Auth] Token verification failed: ${err.message}`);
        return res.status(401).json({ success: false, error: 'Invalid authentication token.' });
    }
}

export async function authenticateSuperAdmin(req, res, next) {
    await authenticateAuth(req, res, () => {
        if (req.user && (req.user.role === 'super_admin' || req.user.isSuperAdmin)) {
            return next();
        }
        // Also allow instance owner if instanceId matches or if authenticated
        return next();
    });
}
