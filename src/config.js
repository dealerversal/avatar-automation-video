// src/config.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
    port: parseInt(process.env.PORT || '5001', 10),
    instanceId: process.env.INSTANCE_ID || 'default',
    mongodbUri: process.env.MONGODB_URI || 'mongodb://dealvercel:juicehead2410@72.60.118.141:27017/dealerversal?authSource=admin',
    mongodbName: process.env.MONGODB_NAME || 'dealerversal',
    jwtSecret: process.env.JWT_SECRET || 'mQCVnXcgqLZrOptjDLGGYFDrKsgkj1GQck5ijx82LhAlyY4ltwAIeru5uqJWQ97dQahj6jGm6AW8pxjidHl6D-3re0U5RA_oBt3KPpT3BlbkFJisPCLss7ao8HT94ROiBSeXv-w38jIDgPMLfC6_cmXIbmt9vOneQrH_AEKKOZc8L85TCSn3yxUA',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15d',
    downloadsDir: process.env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads'),
    browser: {
        profileDir: process.env.PROFILE_DIR || path.join(__dirname, '..', 'browser-profile'),
        headless: process.env.HEADLESS !== 'false',
        timeoutMs: parseInt(process.env.BROWSER_TIMEOUT_MS || '240000', 10),
        slowMo: parseInt(process.env.SLOW_MO_MS || '50', 10),
    },
};
