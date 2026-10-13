// src/manager/rdpSupervisor.js
/**
 * DealerVersal Azure Windows RDP Auto-Supervisor
 * 
 * Runs continuously on the Windows RDP Machine.
 * - Automatically registers the machine in MongoDB (rdp_machines).
 * - Periodically sends live heartbeats to the DealerVersal Admin Dashboard.
 * - Polls MongoDB (avatar_instances) for any instances assigned to this RDP machine.
 * - When an instance is created in the Admin Dashboard:
 *     1. Auto-clones the base project into /instances/<instanceId>
 *     2. Symlinks/junctions node_modules for instant zero-disk startup
 *     3. Auto-generates the isolated .env (HEADLESS=false, DB_POLLING_MODE=true)
 *     4. Auto-launches the avatar worker process (PM2 or native Node child_process)
 *     5. Updates MongoDB status to 'running' and reports online to the Dashboard
 * - Automatically stops/restarts instances when requested from the Dashboard.
 */

import { exec, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { connectDB, getDB } from '../db.js';
import { logger } from '../utils/logger.js';
import { allocatePort, releasePort } from './portManager.js';
import { findCookiesInDir, parseCookiesInput } from '../utils/cookieUtils.js';
import { extractGoogleUserFromProfile } from '../utils/googleUserUtils.js';

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_PROJECT_DIR = path.resolve(__dirname, '../../');

// Default instances directory: <BASE_PROJECT_DIR>/instances
const INSTANCES_ROOT_DIR = process.env.INSTANCES_ROOT_DIR || path.join(BASE_PROJECT_DIR, 'instances');

// Resolve RDP ID from environment, CLI flags (--rdp-id=xyz), or fallback
function getRdpId() {
    for (const arg of process.argv) {
        if (arg.startsWith('--rdp-id=')) {
            return arg.split('=')[1].trim().toLowerCase();
        }
    }
    return (process.env.RDP_ID || 'azure-rdp-01').trim().toLowerCase();
}

const RDP_ID = getRdpId();
const POLL_INTERVAL_MS = parseInt(process.env.RDP_POLL_INTERVAL_MS || '2000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.RDP_HEARTBEAT_INTERVAL_MS || '10000', 10);

// Active locally managed processes: instanceId -> { pid, child, port, processName, startedAt }
const activeProcesses = new Map();
// Instances currently in the middle of being launched — prevents duplicate launches
// when synchronizeInstances fires again before launchInstanceProcess completes.
const launchingInstances = new Set();
// Track instances where npm install has already run so it only runs on initial cloning
const npmInstalledInstances = new Set();
let isPm2Available = false;
let isShuttingDown = false;
let isSynchronizing = false; // prevents concurrent synchronizeInstances runs

/**
 * Check if PM2 is installed globally and accessible on Windows.
 */
async function checkPm2Available() {
    try {
        await execPromise('pm2 -v');
        isPm2Available = true;
        return true;
    } catch {
        isPm2Available = false;
        return false;
    }
}

/**
 * Checks if a port is free on the host OS.
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
 * Finds next free port starting from 5101 via centralized PortManager.
 * Prioritizes reusing freed ports and cross-checks local OS sockets to strictly prevent overwrites.
 */
async function getNextAvailablePort(currentInstanceId = null) {
    const db = getDB();
    return await allocatePort({
        machineType: 'rdp',
        machineId: RDP_ID,
        instanceId: currentInstanceId,
        db,
        isPortFreeFn: isPortFree,
    });
}

/**
 * Automatically clones base project workspace for a user's isolated avatar instance.
 * Copies ONLY application code (src, public, package.json).
 * NEVER copies base browser-profile or cookies, keeping each instance 100% isolated!
 */
function cloneProjectForInstance(instanceDir) {
    if (!fs.existsSync(instanceDir)) {
        fs.mkdirSync(instanceDir, { recursive: true });
    }

    // Only copy application code and dependencies (DO NOT COPY base profile or cookies!)
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

    // Ensure isolated browser-profile directory exists for this instance
    const profileDir = path.join(instanceDir, 'browser-profile');
    if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
    }

    // Clean any stale locks in profile directory
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort']) {
        const lp = path.join(profileDir, lock);
        if (fs.existsSync(lp)) {
            try { fs.rmSync(lp, { force: true }); } catch (_) {}
        }
    }

    // Windows NTFS directory junction for node_modules (instant zero-disk copy!)
    const nodeModulesSrc = path.join(BASE_PROJECT_DIR, 'node_modules');
    const nodeModulesDest = path.join(instanceDir, 'node_modules');
    if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesDest)) {
        try {
            fs.symlinkSync(nodeModulesSrc, nodeModulesDest, 'junction');
        } catch (err) {
            try {
                fs.cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true });
            } catch (cpErr) {
                console.warn(`[RDP-SUPERVISOR] node_modules junction warning: ${cpErr.message}`);
            }
        }
    }
}

/**
 * Prepares isolated instance workspace on standby without launching extra terminal windows.
 * Automatically runs "npm install" upon initial cloning so all dependencies are ready.
 */
async function prepareInstanceWorkspace(instanceDoc) {
    const instanceId = instanceDoc.instanceId;
    const instanceDir = path.join(INSTANCES_ROOT_DIR, instanceId);
    const profileDir = path.join(instanceDir, 'browser-profile');
    const downloadsDir = path.join(instanceDir, 'downloads');
    const logsDir = path.join(instanceDir, 'logs');

    // Ensure required directories exist
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // 1. Clone workspace files (strictly isolated profile, no base profile leakage)
    cloneProjectForInstance(instanceDir);

    // 2. Automatically run "npm install" if this is a newly cloned instance
    const nodeModulesPath = path.join(instanceDir, 'node_modules');
    const isNewClone = !npmInstalledInstances.has(instanceId) || !fs.existsSync(nodeModulesPath);

    if (isNewClone && !npmInstalledInstances.has(instanceId)) {
        npmInstalledInstances.add(instanceId);
        console.log(`\n============================================================`);
        console.log(`[RDP-SUPERVISOR] 📦 NEW INSTANCE CLONED: "${instanceId}"`);
        console.log(`[RDP-SUPERVISOR] 📥 Automatically running "npm install" in workspace...`);
        console.log(`============================================================\n`);
        try {
            if (process.platform === 'win32') {
                await execPromise('call npm install --prefer-offline --no-audit', { cwd: instanceDir });
            } else {
                await execPromise('npm install --prefer-offline --no-audit', { cwd: instanceDir });
            }
            console.log(`[RDP-SUPERVISOR] ✅ "npm install" completed successfully for "${instanceId}"!\n`);
        } catch (npmErr) {
            console.warn(`[RDP-SUPERVISOR] ⚠️ "npm install" warning for "${instanceId}": ${npmErr.message}`);
        }
    }

    const assignedPort = instanceDoc.port ? Number(instanceDoc.port) : 5105;

    // 2. Generate isolated .env for this instance (configured for on-demand execution)
    const envLines = [
        `# Auto-generated by RDP Supervisor on ${new Date().toISOString()}`,
        `PORT=${assignedPort}`,
        `INSTANCE_ID=${instanceId}`,
        `USER_ID=${instanceDoc.userId || ''}`,
        `USERNAME=${instanceDoc.username || ''}`,
        `AVATAR_NAME=${instanceDoc.avatarName || 'me'}`,
        `PROFILE_DIR=${profileDir}`,
        `DOWNLOADS_DIR=${downloadsDir}`,
        `HEADLESS=false`,
        `DB_POLLING_MODE=true`,
        `ON_DEMAND_MODE=true`,
        `DB_POLLING_INTERVAL_MS=1500`,
        `NODE_ENV=production`,
        `MONGODB_URI=${config.mongodbUri}`,
        `MONGODB_NAME=${config.mongodbName}`,
        `JWT_SECRET=${config.jwtSecret}`,
        `R2_ACCOUNT_ID=${process.env.R2_ACCOUNT_ID || ''}`,
        `R2_ACCESS_KEY_ID=${process.env.R2_ACCESS_KEY_ID || ''}`,
        `R2_SECRET_ACCESS_KEY=${process.env.R2_SECRET_ACCESS_KEY || ''}`,
        `R2_BUCKET_NAME=${process.env.R2_BUCKET_NAME || 'dealer-versal'}`,
        `R2_PUBLIC_DOMAIN=${process.env.R2_PUBLIC_DOMAIN || 'https://pub-75ebbb525c7a4d16a42a0b939e098133.r2.dev'}`,
    ];

    fs.writeFileSync(path.join(instanceDir, '.env'), envLines.join('\n'), 'utf8');

    const windowTitle = `Avatar_Worker_${instanceDoc.avatarName || instanceId}_Port_${assignedPort}`;

    // 3. Create on-demand batch launcher (auto-terminates cleanly when node exits)
    const runBatPath = path.join(instanceDir, 'run-instance.bat');
    const runBatContent = `@echo off
title ${windowTitle}
color 0B
cd /d "%~dp0"
set "PORT=${assignedPort}"
set "INSTANCE_ID=${instanceId}"
set "PROFILE_DIR=${profileDir}"
set "DOWNLOADS_DIR=${downloadsDir}"
set "DB_POLLING_MODE=true"
set "ON_DEMAND_MODE=true"
set "DB_POLLING_INTERVAL_MS=1500"
set "HEADLESS=false"
echo ========================================================================
echo   DealerVersal Avatar Worker: ${instanceId}
echo   User: ${instanceDoc.username || instanceDoc.userId || 'User'}
echo   Avatar Name: ${instanceDoc.avatarName || 'me'}
echo   Dedicated Port: ${assignedPort}
echo   Folder: %~dp0
echo   Mode: On-Demand Job Execution (auto-closes on completion)
echo ========================================================================
echo.
if not exist "node_modules" (
    echo [INFO] Installing NPM dependencies for this instance...
    call npm install
)
echo [INFO] Starting Worker Process (node src/server.js)...
call node src/server.js
echo.
echo ========================================================================
echo   [INFO] Avatar Instance "${instanceId}" job completed. Closing terminal...
echo ========================================================================
exit /b 0
`;
    fs.writeFileSync(runBatPath, runBatContent, 'utf8');

    // 4. Create dedicated restart batch launcher
    const restartBatPath = path.join(instanceDir, 'restart-instance.bat');
    const restartBatContent = `@echo off
title Restart Avatar Instance ${instanceId}
color 0E
cd /d "%~dp0"
echo Terminating any open window for Avatar_${instanceId}...
taskkill /F /FI "WINDOWTITLE eq Avatar_*${instanceId}*" /T >nul 2>&1
timeout /t 2 /nobreak >nul
start "" /D "%~dp0" cmd /c call "%~dp0run-instance.bat"
exit /b 0
`;
    fs.writeFileSync(restartBatPath, restartBatContent, 'utf8');
}

/**
 * Launch an on-demand worker terminal to process an incoming job.
 * Closes automatically as soon as the job is complete.
 */
async function launchInstanceWorker(instanceDoc, job = null) {
    const instanceId = instanceDoc.instanceId;
    const instanceDir = path.join(INSTANCES_ROOT_DIR, instanceId);
    const logsDir = path.join(instanceDir, 'logs');

    // 1. Ensure workspace files & base profile sync
    await prepareInstanceWorkspace(instanceDoc);

    // 2. Resolve unique port
    let assignedPort = instanceDoc.port ? Number(instanceDoc.port) : null;
    const isPortInUseByOther = Array.from(activeProcesses.entries()).some(
        ([id, p]) => id !== instanceId && Number(p.port) === assignedPort
    );

    if (assignedPort && assignedPort > 5001 && !isPortInUseByOther) {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (await isPortFree(assignedPort)) break;
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    if (!assignedPort || assignedPort <= 5001 || isPortInUseByOther || !(await isPortFree(assignedPort))) {
        assignedPort = await getNextAvailablePort(instanceId);
    }

    try {
        const db = getDB();
        await db.collection('avatar_instances').updateOne(
            { instanceId },
            { $set: { port: assignedPort, updatedAt: new Date() } }
        );
    } catch (_) {}

    const windowTitle = `Avatar_Worker_${instanceDoc.avatarName || instanceId}_Job_${job?.itemId || 'active'}`;
    const runBatPath = path.join(instanceDir, 'run-instance.bat');

    console.log(`[RDP-SUPERVISOR] 🖥️ Spawning on-demand worker terminal for "${instanceId}" on Port ${assignedPort}...`);

    let childProc = null;
    let childPid = null;

    if (process.platform === 'win32') {
        // Use cmd /c so the window automatically terminates & closes when the node process exits
        try {
            const startCommand = `start "${windowTitle}" /D "${instanceDir}" cmd /c call "${runBatPath}"`;
            childProc = exec(startCommand, { cwd: instanceDir });
            childPid = childProc.pid;
        } catch (err) {
            console.error(`[RDP-SUPERVISOR] ❌ Failed to spawn on-demand terminal for ${instanceId}:`, err);
        }
    } else {
        const serverScript = path.join(instanceDir, 'src', 'server.js');
        const outLog = fs.openSync(path.join(logsDir, 'out.log'), 'a');
        const errLog = fs.openSync(path.join(logsDir, 'err.log'), 'a');
        childProc = spawn(process.execPath, [serverScript], {
            cwd: instanceDir,
            env: {
                ...process.env,
                PORT: String(assignedPort),
                INSTANCE_ID: instanceId,
                ON_DEMAND_MODE: 'true',
            },
            detached: false,
            stdio: ['ignore', outLog, errLog],
        });
        childPid = childProc.pid;
    }

    activeProcesses.set(instanceId, {
        engine: 'terminal',
        child: childProc,
        pid: childPid,
        windowTitle,
        port: assignedPort,
        instanceDir,
        jobId: job?.itemId || null,
        startedAt: new Date(),
    });

    console.log(`[RDP-SUPERVISOR] 🚀 [On-Demand Worker] Instance "${instanceId}" is active on port ${assignedPort}`);

    // Update MongoDB status to busy
    try {
        const db = getDB();
        await db.collection('avatar_instances').updateOne(
            { instanceId },
            {
                $set: {
                    status: 'running',
                    'rdpStatus.isOnline': true,
                    'rdpStatus.workerState': 'busy',
                    'rdpStatus.activeJobId': job?.itemId || null,
                    updatedAt: new Date(),
                }
            }
        );
    } catch (_) {}
}

// Alias for backwards compatibility
const launchInstanceProcess = launchInstanceWorker;


/**
 * Stop an active instance process.
 */
async function stopInstanceProcess(instanceId, explicitPort = null, isRestarting = false) {
    const proc = activeProcesses.get(instanceId);
    const targetPort = explicitPort || proc?.port;
    console.log(`[RDP-SUPERVISOR] ⏹️  Stopping instance process "${instanceId}" (Port: ${targetPort || 'unknown'})...`);

    if (process.platform === 'win32') {
        // 1. Kill by window title
        const windowTitle = proc?.windowTitle;
        if (windowTitle) {
            try {
                await execPromise(`taskkill /F /FI "WINDOWTITLE eq ${windowTitle}*" /T`);
            } catch (_) {}
        }
        try {
            await execPromise(`taskkill /F /FI "WINDOWTITLE eq Avatar_*${instanceId}*" /T`);
            await execPromise(`taskkill /F /FI "WINDOWTITLE eq Avatar_${instanceId}*" /T`);
        } catch (_) {}

        // 2. Kill by port using netstat
        if (targetPort) {
            try {
                const { stdout } = await execPromise(`netstat -ano | findstr :${targetPort}`);
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        const localAddr = parts[1];
                        if (localAddr && (localAddr.endsWith(`:${targetPort}`) || localAddr === `*:${targetPort}`)) {
                            const pid = parts[parts.length - 1];
                            if (pid && pid !== '0' && pid !== String(process.pid)) {
                                await execPromise(`taskkill /F /PID ${pid} /T`);
                            }
                        }
                    }
                }
            } catch (_) {}
        }
    } else if (proc?.child) {
        try {
            proc.child.kill('SIGTERM');
        } catch (_) {}
    }

    activeProcesses.delete(instanceId);

    if (!isRestarting) {
        const db = getDB();
        await db.collection('avatar_instances').updateOne(
            { instanceId },
            {
                $set: {
                    status: 'stopped',
                    'rdpStatus.isOnline': false,
                    updatedAt: new Date(),
                }
            }
        );
        console.log(`[RDP-SUPERVISOR] 🛑 Instance "${instanceId}" stopped.`);
    }
}

/**
 * Restart an instance process cleanly.
 */
async function restartInstanceProcess(instanceDoc) {
    const instanceId = instanceDoc.instanceId;
    console.log(`[RDP-SUPERVISOR] 🔄 Restarting instance "${instanceId}"...`);
    await stopInstanceProcess(instanceId, instanceDoc.port, true);
    await new Promise(r => setTimeout(r, 2000));
    await launchInstanceProcess(instanceDoc);
}

/**
 * Permanently terminates an RDP instance process, kills its port listeners,
 * removes its workspace directory from disk, marks its port as free in system_ports,
 * and purges its record from avatar_instances and rdp_action_queue.
 */
async function deleteRdpInstance(instanceId, explicitPort = null) {
    const cleanId = instanceId.toLowerCase().trim();
    console.log(`[RDP-SUPERVISOR] 🗑️ Initiating complete purge of RDP instance "${cleanId}"...`);

    // 1. Stop active process tracking
    const proc = activeProcesses.get(cleanId);
    activeProcesses.delete(cleanId);

    const portToFree = explicitPort || proc?.port;

    // 2. Kill Windows processes (by window title, by port, by PID)
    if (process.platform === 'win32') {
        const windowTitle = `Avatar_*${cleanId}*`;
        try {
            await execPromise(`taskkill /F /FI "WINDOWTITLE eq ${windowTitle}" /T`);
        } catch (_) {}

        if (proc?.windowTitle) {
            try {
                await execPromise(`taskkill /F /FI "WINDOWTITLE eq ${proc.windowTitle}*" /T`);
            } catch (_) {}
        }

        if (portToFree) {
            try {
                const { stdout } = await execPromise(`netstat -ano | findstr :${portToFree}`);
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 5 && parts[1].endsWith(`:${portToFree}`)) {
                        const pid = parts[parts.length - 1];
                        if (pid && pid !== '0') {
                            await execPromise(`taskkill /F /PID ${pid} /T`);
                        }
                    }
                }
            } catch (_) {}
        }
    } else if (proc?.child) {
        try {
            proc.child.kill('SIGTERM');
        } catch (_) {}
    }

    // Wait 1.5 seconds for Windows OS file locks to release
    await new Promise(r => setTimeout(r, 1500));

    // 3. Delete workspace directory from disk
    const targetDirs = [
        path.join(INSTANCES_ROOT_DIR, cleanId),
        path.join(BASE_PROJECT_DIR, 'instances', cleanId),
    ];

    for (const targetDir of targetDirs) {
        if (fs.existsSync(targetDir)) {
            try {
                fs.rmSync(targetDir, { recursive: true, force: true });
                console.log(`[RDP-SUPERVISOR] 📁 Deleted directory from disk: ${targetDir}`);
            } catch (rmErr) {
                console.warn(`[RDP-SUPERVISOR] ⚠️ Failed to delete folder ${targetDir}: ${rmErr.message}`);
                // Second attempt with Windows rd /s /q
                if (process.platform === 'win32') {
                    try {
                        await execPromise(`rd /s /q "${targetDir}"`);
                        console.log(`[RDP-SUPERVISOR] 📁 Successfully deleted directory using rd: ${targetDir}`);
                    } catch (_) {}
                }
            }
        }
    }

    // 4. Mark port as FREE in system_ports collection
    try {
        const db = getDB();
        await releasePort({
            machineType: 'rdp',
            machineId: RDP_ID,
            instanceId: cleanId,
            port: portToFree,
            db,
        });
    } catch (portErr) {
        console.warn(`[RDP-SUPERVISOR] ⚠️ Port release warning: ${portErr.message}`);
    }

    // 5. Purge from avatar_instances collection and complete action queue
    try {
        const db = getDB();
        await db.collection('avatar_instances').deleteMany({ instanceId: cleanId });
        await db.collection('rdp_action_queue').updateMany(
            { instanceId: cleanId, action: 'delete_instance' },
            { $set: { status: 'completed', completedAt: new Date() } }
        );
        console.log(`[RDP-SUPERVISOR] ✅ Instance "${cleanId}" purged from database & queue.`);
    } catch (dbErr) {
        console.warn(`[RDP-SUPERVISOR] ⚠️ DB purge warning: ${dbErr.message}`);
    }
}

/**
 * Downloads and extracts an uploaded Google Auth session ZIP (browser-profile.zip)
 * directly into the target instance's isolated browser-profile folder, completely replacing it as-is.
 */
async function applyPendingSessionZip(instDoc) {
    const instanceId = instDoc.instanceId;
    const db = getDB();
    const instCol = db.collection('avatar_instances');
    const pendingZip = instDoc.pendingSessionZip;

    if (!pendingZip || !pendingZip.url) return;

    try {
        console.log(`\n============================================================`);
        console.log(`[RDP-SUPERVISOR] 📦 GOOGLE AUTH SESSION ZIP DETECTED FOR: "${instanceId}"`);
        console.log(`[RDP-SUPERVISOR] ⬇️ Downloading from: ${pendingZip.url}...`);
        console.log(`============================================================\n`);

        await instCol.updateOne(
            { instanceId },
            {
                $set: {
                    'pendingSessionZip.status': 'downloading',
                    'pendingSessionZip.startedAt': new Date(),
                    'session.authenticated': false,
                    'session.user': null,
                    'session.message': 'RDP supervisor is downloading and replacing browser profile from uploaded ZIP...',
                    updatedAt: new Date(),
                }
            }
        );

        // 1. Stop any running process on this instance to release Windows file locks
        await stopInstanceProcess(instanceId, instDoc.port, true);
        await new Promise(r => setTimeout(r, 1500));

        // 2. Download ZIP
        const response = await fetch(pendingZip.url);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        const arrayBuf = await response.arrayBuffer();
        const zipBuffer = Buffer.from(arrayBuf);

        const tempZipPath = path.join(os.tmpdir(), `session-upload-${instanceId}-${Date.now()}.zip`);
        fs.writeFileSync(tempZipPath, zipBuffer);

        // 3. Extract into an isolated temporary folder in os.tmpdir() first (prevents nested folder / self-copy recursion bugs)
        const tempExtractDir = path.join(os.tmpdir(), `session-extract-${instanceId}-${Date.now()}`);
        fs.mkdirSync(tempExtractDir, { recursive: true });

        if (process.platform === 'win32') {
            try {
                await execPromise(`tar -xf "${tempZipPath}" -C "${tempExtractDir}"`);
            } catch (_) {
                await execPromise(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${tempZipPath}' -DestinationPath '${tempExtractDir}' -Force"`);
            }
        } else {
            try {
                await execPromise(`unzip -o "${tempZipPath}" -d "${tempExtractDir}"`);
            } catch (_) {}
        }

        // 4. Find the actual profile root inside tempExtractDir
        let sourceDir = tempExtractDir;
        if (fs.existsSync(path.join(tempExtractDir, 'browser-profile'))) {
            sourceDir = path.join(tempExtractDir, 'browser-profile');
        } else if (!fs.existsSync(path.join(tempExtractDir, 'Default')) && !fs.existsSync(path.join(tempExtractDir, 'cookies.json'))) {
            try {
                const subEntries = fs.readdirSync(tempExtractDir, { withFileTypes: true });
                const subDirs = subEntries.filter(e => e.isDirectory());
                if (subDirs.length === 1) {
                    const singleSub = path.join(tempExtractDir, subDirs[0].name);
                    if (fs.existsSync(path.join(singleSub, 'Default')) ||
                        fs.existsSync(path.join(singleSub, 'Preferences')) ||
                        fs.existsSync(path.join(singleSub, 'cookies.json')) ||
                        fs.existsSync(path.join(singleSub, 'Network'))) {
                        sourceDir = singleSub;
                    }
                }
            } catch (_) {}
        }

        // 5. Target instance directory
        const instanceDir = instDoc.projectDir || path.join(INSTANCES_ROOT_DIR, instanceId);
        const candidateDirs = [
            instanceDir,
            path.join(INSTANCES_ROOT_DIR, `${instanceId}-1`),
            path.join(INSTANCES_ROOT_DIR, instanceId.replace(/-\d+$/, '')),
        ].filter(d => fs.existsSync(d));

        if (candidateDirs.length === 0) {
            candidateDirs.push(instanceDir);
            fs.mkdirSync(instanceDir, { recursive: true });
        }

        // 6. Clean and copy files AS-IS into each candidate directory's browser-profile
        for (const targetDir of candidateDirs) {
            const profileDir = path.join(targetDir, 'browser-profile');
            console.log(`[RDP-SUPERVISOR] 📂 Replacing browser-profile in "${profileDir}" with uploaded ZIP files...`);

            if (fs.existsSync(profileDir)) {
                fs.rmSync(profileDir, { recursive: true, force: true });
            }
            fs.mkdirSync(profileDir, { recursive: true });

            // Copy all files and folders as-is from sourceDir
            fs.cpSync(sourceDir, profileDir, { recursive: true });

            // Clean up locks
            for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort']) {
                const lp = path.join(profileDir, lock);
                if (fs.existsSync(lp)) {
                    try { fs.rmSync(lp, { force: true }); } catch (_) {}
                }
            }
        }

        // 7. Cleanup temp files
        try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (_) {}
        try { if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath); } catch (_) {}

        // 8. Verify the newly extracted profile for Google authentication
        const primaryProfileDir = path.join(instanceDir, 'browser-profile');
        const allExtractedCookies = findCookiesInDir(primaryProfileDir);
        const cookieCount = allExtractedCookies.length;

        if (allExtractedCookies.length > 0) {
            try {
                fs.writeFileSync(path.join(primaryProfileDir, 'cookies.json'), JSON.stringify(allExtractedCookies, null, 2), 'utf8');
                fs.writeFileSync(path.join(instanceDir, 'cookies.json'), JSON.stringify(allExtractedCookies, null, 2), 'utf8');
            } catch (_) {}
        }

        const googleUser = extractGoogleUserFromProfile(primaryProfileDir);
        const isFullyAuth = Boolean(googleUser && googleUser.name && googleUser.email);
        console.log(`[RDP-SUPERVISOR] 🍪 Read ${cookieCount} total cookies from extracted ZIP archive.`);
        console.log(`[RDP-SUPERVISOR] 👤 Google user detected in extracted archive:`, googleUser || 'None');

        if (isFullyAuth) {
            await instCol.updateOne(
                { instanceId },
                {
                    $set: {
                        'pendingSessionZip.status': 'applied',
                        'pendingSessionZip.appliedAt': new Date(),
                        'session.authenticated': true,
                        'session.cookieCount': cookieCount,
                        'session.user': googleUser,
                        'session.lastVerified': new Date(),
                        'session.message': `Google Auth Session verified for ${googleUser.name} (${googleUser.email})!`,
                        status: 'standby',
                        updatedAt: new Date(),
                    }
                }
            );
            console.log(`[RDP-SUPERVISOR] ✅ Successfully applied and verified Google session for "${instanceId}" (${googleUser.email})!`);
        } else {
            // Uploaded zip did NOT contain a verified Google user (empty/unauthenticated profile)
            await instCol.updateOne(
                { instanceId },
                {
                    $set: {
                        'pendingSessionZip.status': 'applied_unverified',
                        'pendingSessionZip.appliedAt': new Date(),
                        'session.authenticated': false,
                        'session.cookieCount': cookieCount,
                        'session.user': null,
                        'session.lastVerified': new Date(),
                        'session.message': `Session ZIP extracted (${cookieCount} cookies found), but no logged-in Google Account name and email were found in this profile. Please log in via Chrome and re-upload.`,
                        status: 'standby',
                        updatedAt: new Date(),
                    }
                }
            );
            console.log(`[RDP-SUPERVISOR] ⚠️ Profile extracted for "${instanceId}", but no verified Google account found. Marked unauthenticated.`);
        }

    } catch (err) {
        console.error(`[RDP-SUPERVISOR] ❌ Failed to apply session zip for "${instanceId}":`, err.message);
        await instCol.updateOne(
            { instanceId },
            {
                $set: {
                    'pendingSessionZip.status': 'failed',
                    'pendingSessionZip.error': err.message,
                    'session.authenticated': false,
                    'session.user': null,
                    'session.message': `Failed to apply session ZIP: ${err.message}`,
                    updatedAt: new Date(),
                }
            }
        );
    }
}

/**
 * Applies pending Google Auth cookies uploaded from Admin Dashboard directly to RDP instance directories.
 */
async function applyPendingCookies(instDoc) {
    const instanceId = instDoc.instanceId;
    const db = getDB();
    const instCol = db.collection('avatar_instances');
    const pending = instDoc.pendingCookies;

    if (!pending || !pending.data) return;

    try {
        console.log(`\n============================================================`);
        console.log(`[RDP-SUPERVISOR] 🍪 GOOGLE AUTH COOKIES DETECTED FOR: "${instanceId}"`);
        console.log(`============================================================\n`);

        await instCol.updateOne(
            { instanceId },
            {
                $set: {
                    'pendingCookies.status': 'applying',
                    'pendingCookies.startedAt': new Date(),
                    'session.message': 'RDP supervisor is applying uploaded Google cookies to browser profile...',
                    updatedAt: new Date(),
                }
            }
        );

        const normalizedCookies = parseCookiesInput(pending.data);
        if (!normalizedCookies || normalizedCookies.length === 0) {
            throw new Error('No valid cookies could be parsed from upload');
        }

        const instanceDir = instDoc.projectDir || path.join(INSTANCES_ROOT_DIR, instanceId);
        const candidateDirs = [
            instanceDir,
            path.join(INSTANCES_ROOT_DIR, `${instanceId}-1`),
            path.join(INSTANCES_ROOT_DIR, instanceId.replace(/-\d+$/, '')),
        ].filter(d => fs.existsSync(d));

        if (candidateDirs.length === 0) {
            candidateDirs.push(instanceDir);
            fs.mkdirSync(instanceDir, { recursive: true });
        }

        for (const targetDir of candidateDirs) {
            const profileDir = path.join(targetDir, 'browser-profile');
            if (!fs.existsSync(profileDir)) {
                fs.mkdirSync(profileDir, { recursive: true });
            }

            // Write cookies.json in both browser-profile and targetDir
            fs.writeFileSync(path.join(profileDir, 'cookies.json'), JSON.stringify(normalizedCookies, null, 2), 'utf8');
            fs.writeFileSync(path.join(targetDir, 'cookies.json'), JSON.stringify(normalizedCookies, null, 2), 'utf8');

            // Write storageState.json
            const storageState = {
                cookies: normalizedCookies,
                origins: []
            };
            fs.writeFileSync(path.join(profileDir, 'storageState.json'), JSON.stringify(storageState, null, 2), 'utf8');

            // Clean up locks
            for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
                const lp = path.join(profileDir, lock);
                if (fs.existsSync(lp)) fs.rmSync(lp, { force: true });
            }
        }

        console.log(`[RDP-SUPERVISOR] 🍪 Saved ${normalizedCookies.length} cookies across candidate directories.`);

        // Check if extracted profile contains verified Google user name and email
        let googleUser = null;
        for (const targetDir of candidateDirs) {
            const profileDir = path.join(targetDir, 'browser-profile');
            googleUser = extractGoogleUserFromProfile(profileDir) || extractGoogleUserFromProfile(targetDir);
            if (googleUser && googleUser.name && googleUser.email) break;
        }

        const isFullyAuth = Boolean(googleUser && googleUser.name && googleUser.email);
        console.log(`[RDP-SUPERVISOR] 👤 Google user detected:`, googleUser || 'None');

        await instCol.updateOne(
            { instanceId },
            {
                $set: {
                    'pendingCookies.status': 'applied',
                    'pendingCookies.appliedAt': new Date(),
                    'session.cookieCount': normalizedCookies.length,
                    'session.cookies': normalizedCookies,
                    'session.authenticated': isFullyAuth,
                    'session.user': isFullyAuth ? googleUser : null,
                    'session.lastVerified': new Date(),
                    'session.message': isFullyAuth
                        ? `Google Auth Session verified for ${googleUser.name} (${googleUser.email})! Restarting instance terminal...`
                        : `Saved ${normalizedCookies.length} cookies into RDP profile. Restarting instance terminal...`,
                    status: 'restart_requested',
                    updatedAt: new Date(),
                }
            }
        );

        console.log(`[RDP-SUPERVISOR] 🔄 Requested restart for "${instanceId}" with updated cookies.`);
    } catch (err) {
        console.error(`[RDP-SUPERVISOR] ❌ Failed to apply pending cookies for "${instanceId}":`, err.message);
        await instCol.updateOne(
            { instanceId },
            {
                $set: {
                    'pendingCookies.status': 'failed',
                    'pendingCookies.error': err.message,
                    'pendingCookies.failedAt': new Date(),
                    'session.message': `Failed to apply cookies: ${err.message}`,
                    updatedAt: new Date(),
                }
            }
        );
    }
}

/**
 * Main supervisor polling loop:
 * Queries MongoDB for instances belonging to this RDP machine and synchronizes them.
 */
async function synchronizeInstances() {
    if (isShuttingDown) return;
    // Skip if previous sync is still running (prevents race conditions on slow systems)
    if (isSynchronizing) {
        console.log(`[RDP-SUPERVISOR] ⏭️  Skipping sync — previous cycle still in progress.`);
        return;
    }
    isSynchronizing = true;
    try {
        const db = getDB();

        // 1. Process queued deletion actions from rdp_action_queue
        try {
            const pendingDeletions = await db.collection('rdp_action_queue').find({
                rdpId: RDP_ID,
                status: 'pending',
                action: 'delete_instance'
            }).toArray();

            for (const act of pendingDeletions) {
                console.log(`[RDP-SUPERVISOR] 📥 Executing queued deletion for instance: "${act.instanceId}"...`);
                await deleteRdpInstance(act.instanceId, act.port);
            }
        } catch (queueErr) {
            console.warn(`[RDP-SUPERVISOR] Action queue poll warning: ${queueErr.message}`);
        }

        // 2. Process any instances in avatar_instances with status = 'delete_requested'
        const deleteRequested = await db.collection('avatar_instances').find({
            type: 'rdp',
            rdpId: RDP_ID,
            status: 'delete_requested'
        }).toArray();

        for (const inst of deleteRequested) {
            console.log(`[RDP-SUPERVISOR] 📥 Executing delete_requested for instance: "${inst.instanceId}"...`);
            await deleteRdpInstance(inst.instanceId, inst.port);
        }

        // 3. Query active instances belonging to this RDP machine
        const instances = await db.collection('avatar_instances').find({
            type: 'rdp',
            rdpId: RDP_ID,
            status: { $ne: 'delete_requested' },
        }).toArray();

        const currentDbInstanceIds = new Set(instances.map(i => i.instanceId));

        // 4. Clean up any locally running processes whose instances no longer exist in DB
        for (const [runningId, proc] of activeProcesses.entries()) {
            if (!currentDbInstanceIds.has(runningId)) {
                console.log(`[RDP-SUPERVISOR] 🗑️ Instance "${runningId}" no longer exists in DB. Purging process, folder, and port...`);
                await deleteRdpInstance(runningId, proc.port);
            }
        }

        // 5. Scan filesystem for any orphaned/deleted instance directories
        if (fs.existsSync(INSTANCES_ROOT_DIR)) {
            try {
                const diskEntries = fs.readdirSync(INSTANCES_ROOT_DIR, { withFileTypes: true });
                for (const entry of diskEntries) {
                    // Skip if instance exists in DB, is actively running, or is currently being launched
                    if (entry.isDirectory() &&
                        !currentDbInstanceIds.has(entry.name) &&
                        !activeProcesses.has(entry.name) &&
                        !launchingInstances.has(entry.name)) {
                        console.log(`[RDP-SUPERVISOR] 🧹 Orphaned instance folder found on disk: "${entry.name}". Purging...`);
                        await deleteRdpInstance(entry.name);
                    }
                }
            } catch (scanErr) {
                console.warn(`[RDP-SUPERVISOR] Disk scan warning: ${scanErr.message}`);
            }
        }

        // 6. Reconcile remaining active instances from DB (prepare workspaces on standby)
        for (const inst of instances) {
            const isRunningLocally = activeProcesses.has(inst.instanceId);

            // Action: Check for pending session ZIP
            if (inst.pendingSessionZip?.status === 'pending') {
                console.log(`[RDP-SUPERVISOR] 📦 Detected pending Google session ZIP for "${inst.instanceId}". Applying...`);
                await applyPendingSessionZip(inst);
                continue;
            }

            // Action: Check for pending cookies JSON
            if (inst.pendingCookies?.status === 'pending') {
                console.log(`[RDP-SUPERVISOR] 🍪 Detected pending Google cookies for "${inst.instanceId}". Applying...`);
                await applyPendingCookies(inst);
                continue;
            }

            // Action: Restart Requested from Dashboard
            if (inst.status === 'restart_requested') {
                console.log(`[RDP-SUPERVISOR] 🔄 Dashboard requested restart for "${inst.instanceId}".`);
                if (isRunningLocally) {
                    await stopInstanceProcess(inst.instanceId, inst.port, true);
                }
                await prepareInstanceWorkspace(inst);
                await db.collection('avatar_instances').updateOne(
                    { instanceId: inst.instanceId },
                    {
                        $set: {
                            status: 'standby',
                            'rdpStatus.isOnline': true,
                            'rdpStatus.workerState': 'standby',
                            updatedAt: new Date()
                        }
                    }
                );
                continue;
            }

            // Action: Stopped in DB
            if (inst.status === 'stopped') {
                if (isRunningLocally) {
                    console.log(`[RDP-SUPERVISOR] ⏹️ Dashboard requested stop for "${inst.instanceId}".`);
                    await stopInstanceProcess(inst.instanceId);
                }
                continue;
            }

            // Prepare workspace files on disk (does NOT spawn unnecessary terminal windows)
            await prepareInstanceWorkspace(inst);

            // If not active, ensure standby status & Google user status in DB
            if (!isRunningLocally) {
                const instanceDir = path.join(INSTANCES_ROOT_DIR, inst.instanceId);
                const profileDir = path.join(instanceDir, 'browser-profile');
                const googleUser = extractGoogleUserFromProfile(profileDir);
                const isFullyAuth = Boolean(googleUser && googleUser.name && googleUser.email);

                const updateObj = {
                    'rdpStatus.isOnline': true,
                    'rdpStatus.lastHeartbeat': new Date(),
                    'rdpStatus.workerState': 'standby',
                    lastHeartbeat: new Date(),
                    updatedAt: new Date()
                };

                if (inst.status === 'provisioning' || inst.status === 'running') {
                    updateObj.status = 'standby';
                }

                const isZipInFlight = ['pending', 'downloading'].includes(inst.pendingSessionZip?.status);
                const isCookiesInFlight = ['pending', 'applying'].includes(inst.pendingCookies?.status);

                if (!isZipInFlight && !isCookiesInFlight) {
                    if (isFullyAuth) {
                        updateObj['session.authenticated'] = true;
                        updateObj['session.user'] = googleUser;
                        updateObj['session.lastVerified'] = new Date();
                        updateObj['session.message'] = `Google Auth Session verified for ${googleUser.name} (${googleUser.email})`;
                    } else {
                        // Crucial: If no verified Google user is found in THIS instance's profile, mark NOT authenticated!
                        updateObj['session.authenticated'] = false;
                        updateObj['session.user'] = null;
                        if (!inst.session?.message || inst.session.message.includes('verified')) {
                            updateObj['session.message'] = 'No verified Google account found in browser profile. Please upload session ZIP.';
                        }
                    }
                }

                await db.collection('avatar_instances').updateOne(
                    { instanceId: inst.instanceId },
                    { $set: updateObj }
                );
            }
        }

        // 7. Reconcile Active Workers (detect when worker process finished job and closed)
        for (const [runningId, proc] of Array.from(activeProcesses.entries())) {
            const portIsFree = proc.port ? await isPortFree(proc.port) : true;
            const elapsedMs = Date.now() - (proc.startedAt ? new Date(proc.startedAt).getTime() : 0);
            const isTimeout = elapsedMs > 25 * 60 * 1000; // 25 minute watchdog

            if (portIsFree || isTimeout) {
                if (isTimeout && !portIsFree) {
                    console.log(`[RDP-SUPERVISOR] ⚠️ Worker "${runningId}" exceeded 25m runtime limit. Forcibly closing...`);
                    await stopInstanceProcess(runningId, proc.port);
                } else {
                    console.log(`[RDP-SUPERVISOR] 🏁 [On-Demand Worker] Instance "${runningId}" finished job and closed terminal (Port ${proc.port} is now free).`);
                }

                activeProcesses.delete(runningId);

                await db.collection('avatar_instances').updateOne(
                    { instanceId: runningId },
                    {
                        $set: {
                            status: 'standby',
                            'rdpStatus.isOnline': true,
                            'rdpStatus.workerState': 'standby',
                            'rdpStatus.activeJobId': null,
                            'rdpStatus.lastHeartbeat': new Date(),
                            lastHeartbeat: new Date(),
                            updatedAt: new Date()
                        }
                    }
                );
            }
        }

        // 8. On-Demand Job Dispatcher:
        // When no worker is currently active on RDP Desktop, pick the oldest pending job
        // and spawn an on-demand worker terminal that closes immediately when the job finishes!
        if (activeProcesses.size === 0 && instances.length > 0) {
            const instIdsList = instances.map(i => i.instanceId);
            const baseIdsList = instances.map(i => i.instanceId.replace(/-\d+$/, ''));
            const allCandidateIds = Array.from(new Set([...instIdsList, ...baseIdsList]));

            const nextJob = await db.collection('generation_jobs').findOne(
                {
                    status: 'pending',
                    $or: [
                        { instanceId: { $in: allCandidateIds } },
                        { rdpId: RDP_ID }
                    ]
                },
                { sort: { createdAt: 1 } }
            );

            if (nextJob) {
                let targetInst = instances.find(i => 
                    i.instanceId === nextJob.instanceId || 
                    i.instanceId.replace(/-\d+$/, '') === nextJob.instanceId
                );

                if (!targetInst) {
                    targetInst = instances[0];
                }

                if (targetInst && !launchingInstances.has(targetInst.instanceId)) {
                    launchingInstances.add(targetInst.instanceId);
                    try {
                        console.log(`\n============================================================`);
                        console.log(`[RDP-SUPERVISOR] 📥 NEW GENERATION JOB DETECTED!`);
                        console.log(`[RDP-SUPERVISOR] 🆔 Job ID     : ${nextJob.itemId}`);
                        console.log(`[RDP-SUPERVISOR] 👤 Target Inst: ${targetInst.instanceId} (@${targetInst.username || 'user'})`);
                        console.log(`[RDP-SUPERVISOR] 🚀 Spawning on-demand worker terminal...`);
                        console.log(`============================================================\n`);

                        await launchInstanceWorker(targetInst, nextJob);
                    } catch (launchErr) {
                        console.error(`[RDP-SUPERVISOR] ❌ Failed to start worker for job ${nextJob.itemId}:`, launchErr.message);
                    } finally {
                        launchingInstances.delete(targetInst.instanceId);
                    }
                }
            }
        }

    } catch (err) {
        console.error(`[RDP-SUPERVISOR] Synchronization loop error:`, err.message);
    } finally {
        isSynchronizing = false;
    }
}

/**
 * Sends heartbeat to MongoDB rdp_machines and avatar_instances.
 */
async function sendHeartbeat() {
    if (isShuttingDown) return;
    try {
        const db = getDB();
        const runningIds = Array.from(activeProcesses.keys());

        // Update RDP Machine status in MongoDB
        await db.collection('rdp_machines').updateOne(
            { rdpId: RDP_ID },
            {
                $setOnInsert: {
                    rdpId: RDP_ID,
                    label: `Azure RDP (${RDP_ID})`,
                    os: `Windows (${os.type()} ${os.release()})`,
                    region: process.env.RDP_REGION || 'Azure US East',
                    isActive: true,
                    createdAt: new Date(),
                },
                $set: {
                    isOnline: true,
                    lastHeartbeat: new Date(),
                    activeInstancesCount: runningIds.length,
                    runningInstances: runningIds,
                    systemInfo: {
                        hostname: os.hostname(),
                        platform: os.platform(),
                        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
                        freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
                        uptimeHours: (os.uptime() / 3600).toFixed(1),
                    },
                    supervisorPid: process.pid,
                    mode: 'single-terminal-watcher-on-demand',
                    updatedAt: new Date(),
                },
            },
            { upsert: true }
        );

        // Update heartbeat for all instances belonging to this machine in avatar_instances
        const instances = await db.collection('avatar_instances').find({
            type: 'rdp',
            rdpId: RDP_ID,
            status: { $ne: 'delete_requested' }
        }).toArray();

        for (const inst of instances) {
            const isBusy = activeProcesses.has(inst.instanceId);
            await db.collection('avatar_instances').updateOne(
                { instanceId: inst.instanceId },
                {
                    $set: {
                        'rdpStatus.isOnline': true,
                        'rdpStatus.lastHeartbeat': new Date(),
                        'rdpStatus.workerState': isBusy ? 'busy' : 'standby',
                        lastHeartbeat: new Date(),
                        status: isBusy ? 'running' : 'standby',
                        updatedAt: new Date(),
                    }
                }
            );
        }
    } catch (err) {
        // Silent heartbeat error log to prevent console spam
    }
}

/**
 * Graceful shutdown handler.
 */
async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[RDP-SUPERVISOR] 🛑 Shutting down supervisor (${signal})...`);

    try {
        const db = getDB();
        await db.collection('rdp_machines').updateOne(
            { rdpId: RDP_ID },
            {
                $set: {
                    isOnline: false,
                    lastHeartbeat: new Date(),
                    updatedAt: new Date(),
                }
            }
        );

        // Stop all native child processes
        for (const [id, proc] of activeProcesses.entries()) {
            if (proc.engine === 'native' && proc.child) {
                console.log(`[RDP-SUPERVISOR] Terminating child process for ${id}...`);
                proc.child.kill('SIGTERM');
            }
        }
    } catch (e) {
        // ignore
    }

    console.log(`[RDP-SUPERVISOR] 👋 Goodbye!`);
    process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

/**
 * Clean up any lingering worker terminals on Windows so only the main supervisor terminal runs.
 */
async function cleanupLingeringWindows() {
    if (process.platform === 'win32') {
        try {
            console.log(`[RDP-SUPERVISOR] 🧹 Closing any lingering Avatar worker windows...`);
            await execPromise(`taskkill /F /FI "WINDOWTITLE eq Avatar_*" /T >nul 2>&1`);
        } catch (_) {}
    }
}

/**
 * Main startup function.
 */
export async function startSupervisor() {
    console.log(`\n========================================================================`);
    console.log(`  🚀 DealerVersal Azure Windows RDP Auto-Supervisor (Single Terminal Watcher)`);
    console.log(`========================================================================`);
    console.log(`[RDP-SUPERVISOR] 🖥️  Machine ID       : ${RDP_ID}`);
    console.log(`[RDP-SUPERVISOR] 📂 Base Project    : ${BASE_PROJECT_DIR}`);
    console.log(`[RDP-SUPERVISOR] 📁 Instances Root  : ${INSTANCES_ROOT_DIR}`);
    console.log(`[RDP-SUPERVISOR] 💻 Host Platform   : ${os.type()} ${os.release()} (${os.hostname()})`);
    console.log(`[RDP-SUPERVISOR] ⚡ Execution Mode  : Single-Terminal Watcher (On-Demand Workers)`);

    // 1. Close any lingering worker windows on boot
    await cleanupLingeringWindows();

    // 2. Check PM2
    const pm2 = await checkPm2Available();
    console.log(`[RDP-SUPERVISOR] ⚙️  PM2 Status      : ${pm2 ? 'Installed & Ready ✅' : 'Not found (Using Native Process Engine ✅)'}`);

    // 3. Connect DB
    await connectDB();
    console.log(`[RDP-SUPERVISOR] 🗄️  MongoDB         : Connected to "${config.mongodbName}" ✅`);
    console.log(`[RDP-SUPERVISOR] 📡 Dashboard Status : Machine is registered and ONLINE 🟢`);
    console.log(`========================================================================`);
    console.log(`[RDP-SUPERVISOR] ⏳ Monitoring MongoDB for avatar generation jobs...\n`);

    // 4. Initial sync and heartbeat
    await synchronizeInstances();
    await sendHeartbeat();

    // 5. Start recurring intervals
    setInterval(synchronizeInstances, POLL_INTERVAL_MS);
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

// Auto-run if executed directly as script
const isDirectScript = process.argv[1] && (process.argv[1].endsWith('rdpSupervisor.js') || process.argv[1].endsWith('rdpSupervisor'));
if (isDirectScript) {
    startSupervisor().catch((err) => {
        console.error(`[RDP-SUPERVISOR] ❌ Fatal error on startup:`, err);
        process.exit(1);
    });
}
