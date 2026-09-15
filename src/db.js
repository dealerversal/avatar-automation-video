// src/db.js
import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { logger } from './utils/logger.js';

let dbInstance = null;
let clientInstance = null;

export async function connectDB() {
    if (dbInstance) return dbInstance;

    try {
        const uri = config.mongodbUri;
        logger.info(`[DB] Connecting to MongoDB (${config.mongodbName})...`);
        console.log(`\n🗄️  [DB] Connecting to MongoDB (${config.mongodbName})...`);

        clientInstance = new MongoClient(uri, {
            serverSelectionTimeoutMS: 10000,
        });

        await clientInstance.connect();
        const dbName = config.mongodbName;
        dbInstance = clientInstance.db(dbName);

        // Create index on itemId and instanceId
        await dbInstance.collection('generation_jobs').createIndex({ itemId: 1 }, { unique: true });
        await dbInstance.collection('generation_jobs').createIndex({ instanceId: 1, createdAt: -1 });

        // Ensure index on avatar_instances
        await dbInstance.collection('avatar_instances').createIndex({ instanceId: 1 }, { unique: true });
        await dbInstance.collection('avatar_instances').createIndex({ userId: 1 });
        await dbInstance.collection('avatar_instances').createIndex({ username: 1 });

        logger.info(`[DB] Connected to MongoDB (${dbName}) successfully.`);
        console.log(`✅ [DB] Connected to MongoDB (${dbName}) successfully.\n`);
        return dbInstance;
    } catch (err) {
        logger.error(`[DB] MongoDB connection error:`, err);
        console.error(`❌ [DB] MongoDB connection error:`, err.message);
        throw err;
    }
}

export function getDB() {
    if (!dbInstance) {
        throw new Error('Database not connected. Call connectDB() first.');
    }
    return dbInstance;
}

export function getJobsCollection() {
    return getDB().collection('generation_jobs');
}

export function getAvatarInstancesCollection() {
    return getDB().collection('avatar_instances');
}

export async function getActiveProxyFromDB() {
    try {
        const db = getDB();
        const proxies = await db.collection('system_proxies').find({ enabled: true }).toArray();
        if (!proxies || proxies.length === 0) return null;
        const proxy = proxies[Math.floor(Math.random() * proxies.length)];
        const server = (proxy.source === 'webshare' || proxy.webshareId || proxy.port >= 10000)
            ? `http://p.webshare.io:${proxy.port}`
            : `http://${proxy.host}:${proxy.port}`;
        return {
            server,
            username: proxy.username || '',
            password: proxy.password || '',
            proxyId: proxy._id?.toString(),
            countryCode: proxy.countryCode || '',
            displayHost: `${proxy.host}:${proxy.port}`,
        };
    } catch (err) {
        logger.warn(`[DB] Could not load proxy from DB: ${err.message}`);
        return null;
    }
}

