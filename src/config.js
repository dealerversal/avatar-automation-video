// src/config.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
    port: parseInt(process.env.PORT, 10),
    mongodbUri: process.env.MONGODB_URI,
    mongodbName: process.env.MONGODB_NAME,
    jwtSecret: process.env.JWT_SECRET || 'dealerversal_super_admin_jwt_secret_2026',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15d',
    browser: {
        profileDir: process.env.PROFILE_DIR || path.join(__dirname, '..', 'browser-profile'),
        headless: process.env.HEADLESS !== 'false',
        timeoutMs: parseInt(process.env.BROWSER_TIMEOUT_MS, 10),
        slowMo: parseInt(process.env.SLOW_MO_MS, 10),
    },
};
