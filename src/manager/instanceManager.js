import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import { getAvatarInstancesCollection } from '../db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_PROJECT_DIR = path.resolve(__dirname, '../../');

// On VPS, instances are created under /root/projects/avatar-instances
// On local dev, under BASE_PROJECT_DIR/instances
const INSTANCES_ROOT_DIR = process.env.INSTANCES_ROOT_DIR || 
    (process.platform === 'linux' && fs.existsSync('/root/projects')
        ? '/root/projects/avatar-instances'
        : path.join(BASE_PROJECT_DIR, 'instances'));

/**
 * Execute a PM2 command defensively.
 */
async function runPm2(cmd, customEnv = {}) {
    try {
        const { stdout, stderr } = await execPromise(`pm2 ${cmd}`, {
            env: { ...process.env, ...customEnv },
        });
        return { success: true, stdout, stderr };
    } catch (err) {
        logger.warn(`[InstanceManager] PM2 command "${cmd}" warning/error: ${err.message}`);
        return { success: false, error: err.message, stderr: err.stderr };
    }
}

/**
 * Checks if a port is truly available on the host network.
 */
function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => {
                tester.once('close', () => resolve(true)).close();
            })
            .listen(port, '0.0.0.0');
    });
}

/**
 * Copies base project files to an isolated instance directory.
 */
function cloneProjectForInstance(instanceDir) {
    if (!fs.existsSync(instanceDir)) {
        fs.mkdirSync(instanceDir, { recursive: true });
    }

    // List of directories/files to copy
    const itemsToCopy = ['src', 'public', 'package.json', 'ecosystem.config.cjs'];

    for (const item of itemsToCopy) {
        const srcPath = path.join(BASE_PROJECT_DIR, item);
        const destPath = path.join(instanceDir, item);
        if (fs.existsSync(srcPath)) {
            if (fs.lstatSync(srcPath).isDirectory()) {
                fs.cpSync(srcPath, destPath, { recursive: true });
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    // Symlink node_modules to save disk space and enable instant startup
    const nodeModulesSrc = path.join(BASE_PROJECT_DIR, 'node_modules');
    const nodeModulesDest = path.join(instanceDir, 'node_modules');
    if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesDest)) {
        try {
            fs.symlinkSync(nodeModulesSrc, nodeModulesDest, 'junction');
        } catch (symErr) {
            logger.warn(`[InstanceManager] Symlink node_modules fallback: ${symErr.message}`);
        }
    }
}

/**
 * Finds the next available port for a new instance, starting at 5101.
 */
export async function getNextAvailablePort() {
    try {
        const col = getAvatarInstancesCollection();
        const instances = await col.find({}, { projection: { port: 1 } }).toArray();
        const dbUsedPorts = new Set(instances.map((i) => i.port).filter(Boolean));

        let port = 5101;
        while (true) {
            if (!dbUsedPorts.has(port) && port !== 5001 && port !== 3000 && port !== 3001) {
                const available = await isPortFree(port);
                if (available) {
                    return port;
                }
            }
            port++;
        }
    } catch (err) {
        logger.error('[InstanceManager] Error calculating next port:', err);
        return 5105;
    }
}

/**
 * Creates or provisions an avatar instance on the VPS with a full isolated cloned project.
 */
export async function createOrProvisionInstance({
    instanceId,
    userId,
    username,
    name,
    avatarName = 'me',
    port,
    isDefault = false,
}) {
    if (!instanceId) throw new Error('instanceId is required');
    const cleanInstanceId = instanceId.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');

    const col = getAvatarInstancesCollection();
    const existing = await col.findOne({ instanceId: cleanInstanceId });

    let assignedPort = port || existing?.port;
    if (!assignedPort || !(await isPortFree(assignedPort))) {
        assignedPort = await getNextAvailablePort();
    }

    // 1. Prepare isolated instance project workspace
    const instanceDir = path.join(INSTANCES_ROOT_DIR, cleanInstanceId);
    const profileDir = path.join(instanceDir, 'browser-profile');
    const downloadsDir = path.join(instanceDir, 'downloads');

    // Clone base project into instance directory
    cloneProjectForInstance(instanceDir);

    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(downloadsDir, { recursive: true });

    // 2. Write dedicated .env for this instance
    const envContent = [
        `PORT=${assignedPort}`,
        `INSTANCE_ID=${cleanInstanceId}`,
        `USER_ID=${userId || ''}`,
        `AVATAR_NAME=${avatarName || 'me'}`,
        `PROFILE_DIR=${profileDir}`,
        `DOWNLOADS_DIR=${downloadsDir}`,
        `MONGODB_URI=${config.mongodbUri}`,
        `MONGODB_NAME=${config.mongodbName}`,
        `JWT_SECRET=${config.jwtSecret}`,
        `HEADLESS=true`,
        `NODE_ENV=production`,
        `R2_ACCOUNT_ID=${process.env.R2_ACCOUNT_ID || ''}`,
        `R2_ACCESS_KEY_ID=${process.env.R2_ACCESS_KEY_ID || ''}`,
        `R2_SECRET_ACCESS_KEY=${process.env.R2_SECRET_ACCESS_KEY || ''}`,
        `R2_BUCKET_NAME=${process.env.R2_BUCKET_NAME || 'dealer-versal'}`,
        `R2_PUBLIC_DOMAIN=${process.env.R2_PUBLIC_DOMAIN || 'https://pub-75ebbb525c7a4d16a42a0b939e098133.r2.dev'}`,
    ].join('\n');

    fs.writeFileSync(path.join(instanceDir, '.env'), envContent, 'utf8');

    // 3. Start PM2 process in instance's own directory
    const processName = `avatar-inst-${cleanInstanceId}`;
    const serverScript = path.join(instanceDir, 'src', 'server.js');

    const envObj = {
        PORT: String(assignedPort),
        INSTANCE_ID: cleanInstanceId,
        USER_ID: String(userId || ''),
        AVATAR_NAME: avatarName || 'me',
        PROFILE_DIR: profileDir,
        DOWNLOADS_DIR: downloadsDir,
        MONGODB_URI: config.mongodbUri,
        MONGODB_NAME: config.mongodbName,
        JWT_SECRET: config.jwtSecret,
        HEADLESS: 'true',
        NODE_ENV: 'production',
    };

    // Delete existing process if running to ensure fresh process registration
    await runPm2(`delete ${processName} || true`);

    // Start PM2 pointing to the instance's isolated workspace
    const startCmd = `start "${serverScript}" --name "${processName}" --cwd "${instanceDir}" --time --max-memory-restart 600M`;
    const pm2Result = await runPm2(startCmd, envObj);
    await runPm2('save');

    if (!pm2Result.success && !pm2Result.stdout) {
        logger.error(`[InstanceManager] Failed to start PM2 process for ${cleanInstanceId}:`, pm2Result.error);
    }

    // 4. If set as default, unset other defaults for this user
    if (isDefault && (userId || username)) {
        await col.updateMany(
            {
                $or: [{ userId: String(userId) }, { username }],
                instanceId: { $ne: cleanInstanceId },
            },
            { $set: { isDefault: false, updatedAt: new Date() } }
        );
    }

    const publicBaseUrl = process.env.PUBLIC_SERVICE_URL || 'https://video-gen.dealerversal.com';
    const instanceDoc = {
        instanceId: cleanInstanceId,
        userId: userId ? String(userId) : existing?.userId || null,
        username: username || existing?.username || null,
        name: name || existing?.name || `Avatar Instance ${cleanInstanceId}`,
        avatarName: avatarName || existing?.avatarName || 'me',
        port: assignedPort,
        status: 'running',
        processName,
        projectDir: instanceDir,
        profileDir,
        downloadsDir,
        serviceUrl: `${publicBaseUrl}/${cleanInstanceId}`,
        loginUrl: `${publicBaseUrl}/${cleanInstanceId}/flow-login`,
        isDefault: Boolean(isDefault),
        updatedAt: new Date(),
    };

    if (!existing) {
        instanceDoc.createdAt = new Date();
    }

    await col.updateOne({ instanceId: cleanInstanceId }, { $set: instanceDoc }, { upsert: true });

    logger.info(`[InstanceManager] Provisioned isolated instance "${cleanInstanceId}" on port ${assignedPort} at ${instanceDir}`);
    return instanceDoc;
}

/**
 * Stops an instance PM2 process.
 */
export async function stopInstance(instanceId) {
    const cleanInstanceId = instanceId.toLowerCase().trim();
    const processName = `avatar-inst-${cleanInstanceId}`;
    await runPm2(`stop ${processName}`);
    await runPm2('save');

    const col = getAvatarInstancesCollection();
    await col.updateOne(
        { instanceId: cleanInstanceId },
        { $set: { status: 'stopped', updatedAt: new Date() } }
    );
    return { success: true, status: 'stopped' };
}

/**
 * Starts a stopped instance PM2 process.
 */
export async function startInstance(instanceId) {
    const cleanInstanceId = instanceId.toLowerCase().trim();
    const col = getAvatarInstancesCollection();
    const inst = await col.findOne({ instanceId: cleanInstanceId });

    if (!inst) {
        throw new Error(`Instance "${cleanInstanceId}" not found.`);
    }

    const instanceDir = inst.projectDir || path.join(INSTANCES_ROOT_DIR, cleanInstanceId);
    const serverScript = path.join(instanceDir, 'src', 'server.js');
    const processName = `avatar-inst-${cleanInstanceId}`;

    const envObj = {
        PORT: String(inst.port),
        INSTANCE_ID: cleanInstanceId,
        USER_ID: String(inst.userId || ''),
        AVATAR_NAME: inst.avatarName || 'me',
        PROFILE_DIR: inst.profileDir,
        DOWNLOADS_DIR: inst.downloadsDir,
        MONGODB_URI: config.mongodbUri,
        MONGODB_NAME: config.mongodbName,
        JWT_SECRET: config.jwtSecret,
        HEADLESS: 'true',
        NODE_ENV: 'production',
    };

    await runPm2(`delete ${processName} || true`);
    const startCmd = `start "${serverScript}" --name "${processName}" --cwd "${instanceDir}" --time --max-memory-restart 600M`;
    await runPm2(startCmd, envObj);
    await runPm2('save');

    await col.updateOne(
        { instanceId: cleanInstanceId },
        { $set: { status: 'running', updatedAt: new Date() } }
    );
    return { success: true, status: 'running' };
}

/**
 * Restarts an instance PM2 process.
 */
export async function restartInstance(instanceId) {
    const cleanInstanceId = instanceId.toLowerCase().trim();
    const processName = `avatar-inst-${cleanInstanceId}`;
    const result = await runPm2(`restart ${processName}`);

    // If restart failed because process wasn't registered, run startInstance
    if (!result.success) {
        return await startInstance(cleanInstanceId);
    }

    const col = getAvatarInstancesCollection();
    await col.updateOne(
        { instanceId: cleanInstanceId },
        { $set: { status: 'running', updatedAt: new Date() } }
    );
    return { success: true, status: 'running' };
}

/**
 * Deletes an instance, removes PM2 process, workspace folder, and DB record.
 */
export async function deleteInstance(instanceId) {
    const cleanInstanceId = instanceId.toLowerCase().trim();
    const processName = `avatar-inst-${cleanInstanceId}`;

    // 1. Delete PM2 process
    await runPm2(`delete ${processName} || true`);
    await runPm2('save');

    // 2. Remove instance workspace folder cleanly
    const instanceDir = path.join(INSTANCES_ROOT_DIR, cleanInstanceId);
    if (fs.existsSync(instanceDir)) {
        try {
            fs.rmSync(instanceDir, { recursive: true, force: true });
        } catch (rmErr) {
            logger.warn(`[InstanceManager] Error deleting workspace ${instanceDir}: ${rmErr.message}`);
        }
    }

    // 3. Remove DB record
    const col = getAvatarInstancesCollection();
    await col.deleteOne({ instanceId: cleanInstanceId });

    logger.info(`[InstanceManager] Deleted instance "${cleanInstanceId}" and cleaned up workspace.`);
    return { success: true, message: `Instance ${cleanInstanceId} deleted.` };
}

/**
 * Unified action dispatcher.
 */
export async function handleInstanceAction(instanceId, action) {
    if (action === 'start') return await startInstance(instanceId);
    if (action === 'stop') return await stopInstance(instanceId);
    if (action === 'restart') return await restartInstance(instanceId);
    if (action === 'delete') return await deleteInstance(instanceId);
    throw new Error(`Unknown action: ${action}`);
}

/**
 * Gets live status and health of an instance.
 */
export async function getInstanceDetails(instanceId) {
    const cleanInstanceId = instanceId.toLowerCase().trim();
    const col = getAvatarInstancesCollection();
    const inst = await col.findOne({ instanceId: cleanInstanceId });
    if (!inst) return null;

    let pm2Status = 'unknown';
    try {
        const { stdout } = await execPromise(`pm2 jlist`);
        const list = JSON.parse(stdout || '[]');
        const p = list.find((item) => item.name === inst.processName);
        if (p) {
            pm2Status = p.pm2_env?.status || 'unknown';
        }
    } catch (e) { }

    return {
        ...inst,
        pm2Status,
        status: pm2Status === 'online' ? 'running' : inst.status,
    };
}

export const checkInstanceStatus = getInstanceDetails;
