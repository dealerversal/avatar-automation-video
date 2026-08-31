#!/usr/bin/env node

/**
 * sync-all-instances.js
 * Propagates updated base codebase (src, public, package.json) from /root/projects/avatar-automation-video
 * to all active instance project workspaces in /root/projects/avatar-instances/ and restarts PM2 processes.
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

const instanceDirs = fs.readdirSync(INSTANCES_ROOT_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

console.log(`[SyncInstances] Found ${instanceDirs.length} instance workspaces to update:`, instanceDirs);

const itemsToSync = ['src', 'public', 'package.json', 'ecosystem.config.cjs'];

for (const instName of instanceDirs) {
    const instPath = path.join(INSTANCES_ROOT_DIR, instName);
    console.log(`[SyncInstances] Updating workspace: ${instPath}...`);

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

    // Ensure node_modules symlink exists
    const nodeModulesSrc = path.join(BASE_PROJECT_DIR, 'node_modules');
    const nodeModulesDest = path.join(instPath, 'node_modules');
    if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesDest)) {
        try {
            fs.symlinkSync(nodeModulesSrc, nodeModulesDest, 'junction');
        } catch (e) {
            console.warn(`[SyncInstances] Symlink note for ${instName}: ${e.message}`);
        }
    }

    // Restart the specific instance process if running in PM2
    const processName = `avatar-inst-${instName}`;
    try {
        execSync(`pm2 restart ${processName}`, { stdio: 'ignore' });
        console.log(`[SyncInstances] ✅ Restarted PM2 process: ${processName}`);
    } catch (e) {
        console.log(`[SyncInstances] Process ${processName} not active in PM2. Skipping restart.`);
    }
}

console.log('[SyncInstances] All instance workspaces synchronized successfully!');
