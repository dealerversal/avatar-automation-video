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
        logger.info(`[DB] Connecting to MongoDB via native driver...`);
        console.log(`\n🗄️  [DB] Connecting to MongoDB (native driver)...`);

        clientInstance = new MongoClient(uri, {
            serverSelectionTimeoutMS: 10000,
        });

        await clientInstance.connect();
        const dbName = config.mongodbName;
        dbInstance = clientInstance.db(dbName);

        // Create index on itemId
        await dbInstance.collection('generation_jobs').createIndex({ itemId: 1 }, { unique: true });

        // Create indexes on super_admins collection
        await dbInstance.collection('super_admins').createIndex({ email: 1 }, { unique: true });
        await dbInstance.collection('super_admins').createIndex({ username: 1 }, { unique: true });

        logger.info(`[DB] Connected to MongoDB native driver successfully.`);
        console.log(`✅ [DB] Connected to MongoDB (collection: generation_jobs) successfully.\n`);
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
