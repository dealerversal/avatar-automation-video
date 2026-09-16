#!/usr/bin/env node

/**
 * sync-all-instances.js
 * Propagates updated base codebase (src, public, package.json, ecosystem.config.cjs)
 * and harmonizes .env configurations from /root/projects/avatar-automation-video
 * to all active instance project workspaces in /root/projects/avatar-instances/
 * and restarts PM2 processes with updated environment variables.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_PROJECT_DIR = path.resolve(__dirname, '../');

const INSTANCES_ROOT_DIR = process.env.INSTANCES_ROOT_DIR ||
    (process.platform === 'linux' && fs.existsSync('/root/projects')
        ? '/root/projects/avatar-instances'
        : path.join(BASE_PROJECT_DIR, 'instances'));

console.log(`[SyncInstances] Base project dir: ${BASE_PROJECT_DIR}`);
console.log(`[SyncInstances] Instances root dir: ${INSTANCES_ROOT_DIR}`);

if (!fs.existsSync(INSTANCES_ROOT_DIR)) {
    console.log('[SyncInstances] No instances directory found. Nothing to sync.');
    process.exit(0);
}

function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            const key = trimmed.substring(0, eqIdx).trim();
            const val = trimmed.substring(eqIdx + 1).trim();
            env[key] = val;
        }
    }
    return env;
}

function writeEnvFile(filePath, envObj) {
    const lines = [];
    for (const [key, val] of Object.entries(envObj)) {
        if (val !== undefined && val !== null) {
            lines.push(`${key}=${val}`);
        }
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

const baseEnvPath = path.join(BASE_PROJECT_DIR, '.env');
const baseEnv = parseEnvFile(baseEnvPath);
console.log(`[SyncInstances] Loaded ${Object.keys(baseEnv).length} keys from base .env`);

const instanceDirs = fs.readdirSync(INSTANCES_ROOT_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

console.log(`[SyncInstances] Found ${instanceDirs.length} instance workspaces to update:`, instanceDirs);

const itemsToSync = ['src', 'public', 'package.json', 'ecosystem.config.cjs'];

for (const instName of instanceDirs) {
    const instPath = path.join(INSTANCES_ROOT_DIR, instName);
    console.log(`\n[SyncInstances] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[SyncInstances] Updating workspace: ${instPath}...`);

    // 1. Sync code and assets
    for (const item of itemsToSync) {
        const srcPath = path.join(BASE_PROJECT_DIR, item);
        const destPath = path.join(instPath, item);

        if (fs.existsSync(srcPath)) {
            if (fs.lstatSync(srcPath).isDirectory()) {
                fs.cpSync(srcPath, destPath, { recursive: true });
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    // 2. Ensure node_modules symlink exists
    const nodeModulesSrc = path.join(BASE_PROJECT_DIR, 'node_modules');
    const nodeModulesDest = path.join(instPath, 'node_modules');
    if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesDest)) {
        try {
            fs.symlinkSync(nodeModulesSrc, nodeModulesDest, 'junction');
        } catch (e) {
            console.warn(`[SyncInstances] Symlink note for ${instName}: ${e.message}`);
        }
    }

    // 3. Sync & repair instance .env file
    const instEnvPath = path.join(instPath, '.env');
    const existingInstEnv = parseEnvFile(instEnvPath);

    // Keep instance-specific identity and port
    const mergedEnv = {
        ...existingInstEnv,
    };

    // Propagate shared service keys from base .env
    const sharedKeys = [
        'MONGODB_URI',
        'MONGODB_NAME',
        'R2_ACCOUNT_ID',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET_NAME',
        'R2_PUBLIC_DOMAIN',
        'PUBLIC_SERVICE_URL',
        'BROWSER_TIMEOUT_MS',
        'SLOW_MO_MS',
        'HEADLESS',
        'NODE_ENV',
    ];

    for (const k of sharedKeys) {
        if (baseEnv[k] !== undefined) {
            mergedEnv[k] = baseEnv[k];
        }
    }

    // Guarantee essential instance configuration
    const processName = `avatar-inst-${instName}`;
    mergedEnv.PM2_APP_NAME = processName;
    mergedEnv.INSTANCE_ID = mergedEnv.INSTANCE_ID || instName;
    mergedEnv.AVATAR_NAME = mergedEnv.AVATAR_NAME || 'me';
    mergedEnv.HEADLESS = mergedEnv.HEADLESS || 'true';
    mergedEnv.NODE_ENV = 'production';
    mergedEnv.SLOW_MO_MS = mergedEnv.SLOW_MO_MS || '50';
    mergedEnv.BROWSER_TIMEOUT_MS = mergedEnv.BROWSER_TIMEOUT_MS || '240000';
    mergedEnv.PROFILE_DIR = path.join(instPath, 'browser-profile');
    mergedEnv.DOWNLOADS_DIR = path.join(instPath, 'downloads');

    writeEnvFile(instEnvPath, mergedEnv);
    console.log(`[SyncInstances] ✅ Updated .env with PM2_APP_NAME="${processName}", SLOW_MO_MS, R2, Mongo configs.`);

    // 4. Ensure directories exist
    if (!fs.existsSync(mergedEnv.DOWNLOADS_DIR)) {
        fs.mkdirSync(mergedEnv.DOWNLOADS_DIR, { recursive: true });
    }
    if (!fs.existsSync(mergedEnv.PROFILE_DIR)) {
        fs.mkdirSync(mergedEnv.PROFILE_DIR, { recursive: true });
    }

    // 5. Restart or start the PM2 instance process with updated env
    try {
        execSync(`pm2 restart ${processName} --update-env`, { stdio: 'ignore' });
        console.log(`[SyncInstances] ✅ Restarted PM2 process: ${processName} (with updated env)`);
    } catch (e) {
        try {
            console.log(`[SyncInstances] Process ${processName} not active. Attempting to start...`);
            execSync(`pm2 start src/server.js --name ${processName} --cwd ${instPath} --update-env`, { stdio: 'ignore' });
            console.log(`[SyncInstances] ✅ Started PM2 process: ${processName}`);
        } catch (startErr) {
            console.warn(`[SyncInstances] ⚠️ Could not start ${processName}: ${startErr.message}`);
        }
    }
}

try {
    execSync('pm2 save', { stdio: 'ignore' });
    console.log('[SyncInstances] 💾 Saved PM2 process list.');
} catch (e) {}

console.log('\n[SyncInstances] ✨ All instance workspaces and .envs synchronized successfully!');
