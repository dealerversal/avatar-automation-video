// src/config.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
    port: parseInt(process.env.PORT || '5001', 10),
    mongodbUri: process.env.MONGODB_URI || 'mongodb://dealvercel:juicehead2410@72.60.118.141:27017/dv-content-genrator?authSource=admin',
    browser: {
        profileDir: process.env.PROFILE_DIR || path.join(__dirname, '..', 'browser-profile'),
        headless: process.env.HEADLESS !== 'false',
        timeoutMs: parseInt(process.env.BROWSER_TIMEOUT_MS || '240000', 10),
        slowMo: parseInt(process.env.SLOW_MO_MS || '50', 10),
    },
};
