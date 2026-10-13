// src/queue/dbPoller.js
//
// DB Polling Mode — for Azure RDP Windows machines.
//
// On VPS, the backend calls POST /api/fx-flow/generate-avatar-video over HTTP to submit jobs.
// On Azure RDP (behind NAT, no public HTTP endpoint), the backend instead writes a job record
// directly to MongoDB with:
//   - instanceId = this instance's INSTANCE_ID
//   - status = 'pending'
//
// This module polls MongoDB every `dbPollingIntervalMs` seconds for pending jobs assigned
// to this instance and feeds them into the existing generationQueue (in-memory queue).
// The rest of the processing pipeline (Playwright automation, R2 upload, DB update) is
// identical to the VPS flow — only the job ingestion mechanism differs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { getJobsCollection, getAvatarInstancesCollection } from '../db.js';
import { generationQueue } from './generationQueue.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { extractGoogleUserFromProfile } from '../utils/googleUserUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DbPoller {
    constructor() {
        this._timer = null;
        this._running = false;
        this._pollCount = 0;
        this._resolvedInstanceId = null;
        this._loggedMapping = false;
    }

    /**
     * Resilient instance document resolver:
     * Resolves matching MongoDB record even if local INSTANCE_ID has a numeric suffix
     * (e.g. jdevine-john-devine-1 matching jdevine-john-devine) or vice versa.
     */
    async _resolveInstanceDoc() {
        const rawId = config.instanceId;
        if (!rawId || rawId === 'default') return null;

        try {
            const instCol = getAvatarInstancesCollection();

            // 1. Direct match
            let doc = await instCol.findOne({ instanceId: rawId });
            if (doc) {
                this._resolvedInstanceId = doc.instanceId;
                return doc;
            }

            // 2. Strip trailing number (e.g. 'jdevine-john-devine-1' -> 'jdevine-john-devine')
            const stripped = rawId.replace(/-\d+$/, '');
            if (stripped !== rawId) {
                doc = await instCol.findOne({ instanceId: stripped });
                if (doc) {
                    if (!this._loggedMapping) {
                        logger.info(`[DbPoller] 💡 Mapped local instance "${rawId}" to MongoDB instance "${doc.instanceId}"`);
                        console.log(`💡 [DbPoller] Mapped local instance "${rawId}" to MongoDB instance "${doc.instanceId}"`);
                        this._loggedMapping = true;
                    }
                    this._resolvedInstanceId = doc.instanceId;
                    return doc;
                }
            }

            // 3. Regex match for trailing numbers
            doc = await instCol.findOne({
                instanceId: new RegExp(`^${stripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`, 'i')
            });
            if (doc) {
                this._resolvedInstanceId = doc.instanceId;
                return doc;
            }

            // 4. Match by port if available
            if (config.port && config.port > 5001) {
                doc = await instCol.findOne({ port: config.port });
                if (doc) {
                    this._resolvedInstanceId = doc.instanceId;
                    return doc;
                }
            }
        } catch (err) {
            logger.debug(`[DbPoller] _resolveInstanceDoc error: ${err.message}`);
        }

        return null;
    }

    /**
     * Send heartbeat to MongoDB avatar_instances record.
     */
    async _sendHeartbeat(isOnline = true) {
        try {
            const instDoc = await this._resolveInstanceDoc();
            const targetId = instDoc?.instanceId || this._resolvedInstanceId || config.instanceId;
            if (!targetId || targetId === 'default') return;

            const profileDir = config.browser.profileDir;


            const updateFields = {
                lastHeartbeat: new Date(),
                status: isOnline ? 'running' : 'stopped',
                'rdpStatus.isOnline': isOnline,
                'rdpStatus.lastHeartbeat': new Date(),
                'rdpStatus.port': config.port,
                'rdpStatus.headless': config.browser.headless,
                'rdpStatus.pollIntervalMs': config.dbPollingIntervalMs,
                updatedAt: new Date(),
            };

            // Inspect profile for logged-in Google user to keep MongoDB session status live & accurate
            if (fs.existsSync(profileDir)) {
                const user = extractGoogleUserFromProfile(profileDir);
                let cookieCount = 0;
                if (fs.existsSync(targetCookiesPath)) {
                    try {
                        const parsed = JSON.parse(fs.readFileSync(targetCookiesPath, 'utf8'));
                        cookieCount = Array.isArray(parsed) ? parsed.length : (parsed.cookies?.length || 0);
                    } catch (_) {}
                }
                if (user?.name && user?.email && cookieCount > 0) {
                    updateFields['session.authenticated'] = true;
                    updateFields['session.user'] = user;
                    updateFields['session.cookieCount'] = cookieCount;
                    updateFields['session.lastVerified'] = new Date();
                    updateFields['session.message'] = `Google session verified for ${user.name} (${user.email}).`;
                    updateFields['rdpStatus.user'] = user;
                }
            }

            const instCol = getAvatarInstancesCollection();
            await instCol.updateOne(
                { instanceId: targetId },
                { $set: updateFields }
            );
        } catch (err) {
            // Heartbeat failure shouldn't crash the poller
            logger.debug(`[DbPoller] Heartbeat update failed: ${err.message}`);
        }
    }

    /**
     * Start polling MongoDB for pending jobs assigned to this instance.
     * Only call this when DB_POLLING_MODE=true.
     */
    start() {
        if (this._running) {
            logger.warn('[DbPoller] Already running — ignoring duplicate start()');
            return;
        }

        const instanceId = config.instanceId;
        const intervalMs = config.dbPollingIntervalMs;

        if (!instanceId || instanceId === 'default') {
            logger.error('[DbPoller] INSTANCE_ID is not set or is "default". DB polling requires a specific INSTANCE_ID that matches the MongoDB avatar instance record. Set INSTANCE_ID in your .env file.');
            return;
        }

        this._running = true;
        logger.info(`[DbPoller] 🚀 Started DB polling mode for instance "${instanceId}" — polling every ${intervalMs}ms`);
        console.log(`\n🔄 [DbPoller] DB Polling Mode ACTIVE`);
        console.log(`   Instance ID : ${instanceId}`);
        console.log(`   Poll Interval: ${intervalMs}ms`);
        console.log(`   Headless    : ${config.browser.headless ? 'true (VPS)' : 'false (RDP visible desktop)'}`);
        console.log(`   MongoDB     : ${config.mongodbUri.replace(/:[^:@]+@/, ':***@')}\n`);

        // Send immediate online heartbeat
        this._sendHeartbeat(true);

        this._timer = setInterval(() => this._poll(), intervalMs);

        // Poll immediately on start to pick up any jobs that were queued while the instance was offline
        setTimeout(() => this._poll(), 1000);
    }

    /**
     * Stop the poller (e.g., on graceful shutdown).
     */
    async stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._running = false;
        await this._sendHeartbeat(false);
        logger.info('[DbPoller] Stopped DB polling.');
    }

    /**
     * Check if a new Google Auth Session ZIP was uploaded from Admin Dashboard
     */
    async _checkPendingSessionZip() {
        const rawId = config.instanceId;
        if (!rawId || rawId === 'default') return;

        try {
            const instDoc = await this._resolveInstanceDoc();
            if (!instDoc) return;

            const targetId = instDoc.instanceId;

            if (instDoc.pendingSessionZip?.status === 'pending') {
                const pendingZip = instDoc.pendingSessionZip;
                logger.info(`[DbPoller] 📦 Detected pending Google session ZIP for "${targetId}" (${pendingZip.fileSize || 0} bytes)`);
                console.log('\n' + '📦'.repeat(30));
                console.log(`📦 [DbPoller] DETECTED GOOGLE AUTH SESSION ZIP UPLOAD`);
                console.log(`   Instance ID : ${targetId} (local ID: ${rawId})`);
                console.log(`   File Size   : ${pendingZip.fileSize || 0} bytes`);
                console.log(`   Source URL  : ${pendingZip.url || 'None'}`);
                console.log('📦'.repeat(30) + '\n');

                const instCol = getAvatarInstancesCollection();

                // 1. Mark as downloading
                await instCol.updateOne(
                    { instanceId: targetId },
                    {
                        $set: {
                            'pendingSessionZip.status': 'downloading',
                            'pendingSessionZip.startedAt': new Date(),
                            'session.message': 'RDP instance is downloading and extracting uploaded Google session...',
                            updatedAt: new Date(),
                        }
                    }
                );

                // 2. Fetch the ZIP file buffer
                let zipBuffer = null;
                if (pendingZip.url) {
                    console.log(`⬇️ [DbPoller] Downloading session ZIP from: ${pendingZip.url}`);
                    const response = await fetch(pendingZip.url);
                    if (!response.ok) {
                        throw new Error(`Failed to download session ZIP: HTTP ${response.status} ${response.statusText}`);
                    }
                    const arrayBuf = await response.arrayBuffer();
                    zipBuffer = Buffer.from(arrayBuf);
                }

                if (!zipBuffer || zipBuffer.length === 0) {
                    throw new Error('Downloaded session ZIP buffer is empty');
                }

                console.log(`✅ [DbPoller] Download complete (${zipBuffer.length} bytes). Extracting profile...`);

                // 3. Extract and apply using SessionManager
                const { SessionManager } = await import('../services/sessionManager.js');
                const result = await SessionManager.uploadProfileZip(zipBuffer);
                const isFullyAuth = Boolean(result.authenticated && result.user?.name && result.user?.email);

                console.log(`🎉 [DbPoller] Google session applied! Authenticated: ${isFullyAuth}, User: ${result.user?.name || 'None'} (${result.user?.email || 'None'}), Cookies: ${result.cookieCount || 0}`);

                // 4. Update MongoDB with success and request restart
                await instCol.updateOne(
                    { instanceId: targetId },
                    {
                        $set: {
                            'pendingSessionZip.status': 'applied',
                            'pendingSessionZip.appliedAt': new Date(),
                            'session.authenticated': isFullyAuth,
                            'session.cookieCount': result.cookieCount || 0,
                            'session.user': isFullyAuth ? result.user : null,
                            'session.lastVerified': new Date(),
                            'session.message': isFullyAuth
                                ? `Google Auth Session verified for ${result.user.name} (${result.user.email})! Restarting instance terminal...`
                                : 'Google Auth Session extracted into browser profile, but Google Account name and email were not verified. Restarting instance terminal...',
                            status: 'restart_requested',
                            updatedAt: new Date(),
                        }
                    }
                );

                console.log(`\n============================================================`);
                console.log(`🎉 [DbPoller] Google Auth session extracted successfully!`);
                console.log(`🔄 Closing current terminal and launching fresh npm run dev...`);
                console.log(`============================================================\n`);

                // 5. Automatic terminal restart on Windows RDP
                this._triggerWindowsRestart(targetId);
            }
        } catch (err) {
            logger.error(`[DbPoller] Error applying pending session zip:`, err);
            console.error(`❌ [DbPoller] Failed to apply session zip: ${err.message}`);
            try {
                const targetId = this._resolvedInstanceId || config.instanceId;
                const instCol = getAvatarInstancesCollection();
                await instCol.updateOne(
                    { instanceId: targetId },
                    {
                        $set: {
                            'pendingSessionZip.status': 'failed',
                            'pendingSessionZip.error': err.message,
                            'pendingSessionZip.failedAt': new Date(),
                            'session.message': `Failed to apply session ZIP: ${err.message}`,
                            updatedAt: new Date(),
                        }
                    }
                );
            } catch (_) {}
        }
    }

    /**
     * Check if new Google Auth cookies were uploaded from Admin Dashboard
     */
    async _checkPendingCookies() {
        const rawId = config.instanceId;
        if (!rawId || rawId === 'default') return;

        try {
            const instDoc = await this._resolveInstanceDoc();
            if (!instDoc) return;

            const targetId = instDoc.instanceId;

            if (instDoc.pendingCookies?.status === 'pending') {
                const pending = instDoc.pendingCookies;
                logger.info(`[DbPoller] 🍪 Detected pending Google cookies for "${targetId}"`);
                console.log('\n' + '🍪'.repeat(30));
                console.log(`🍪 [DbPoller] DETECTED GOOGLE AUTH COOKIES UPLOAD`);
                console.log(`   Instance ID : ${targetId} (local ID: ${rawId})`);
                console.log('🍪'.repeat(30) + '\n');

                const instCol = getAvatarInstancesCollection();

                // 1. Mark as applying
                await instCol.updateOne(
                    { instanceId: targetId },
                    {
                        $set: {
                            'pendingCookies.status': 'applying',
                            'pendingCookies.startedAt': new Date(),
                            'session.message': 'RDP instance is applying cookies to browser profile...',
                            updatedAt: new Date(),
                        }
                    }
                );

                const { parseCookiesInput } = await import('../utils/cookieUtils.js');
                const normalizedCookies = parseCookiesInput(pending.data);

                if (!normalizedCookies || normalizedCookies.length === 0) {
                    throw new Error('No valid cookies could be parsed from upload');
                }

                const profileDir = config.browser.profileDir;
                if (!fs.existsSync(profileDir)) {
                    fs.mkdirSync(profileDir, { recursive: true });
                }

                // Write cookies.json and storageState.json
                fs.writeFileSync(path.join(profileDir, 'cookies.json'), JSON.stringify(normalizedCookies, null, 2), 'utf8');
                try {
                    fs.writeFileSync(path.join(process.cwd(), 'cookies.json'), JSON.stringify(normalizedCookies, null, 2), 'utf8');
                } catch (_) {}

                const storageState = {
                    cookies: normalizedCookies,
                    origins: []
                };
                fs.writeFileSync(path.join(profileDir, 'storageState.json'), JSON.stringify(storageState, null, 2), 'utf8');

                // Remove stale locks
                for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
                    const lp = path.join(profileDir, lock);
                    if (fs.existsSync(lp)) {
                        try { await import('fs/promises').then(fsP => fsP.unlink(lp)); } catch {}
                    }
                }

                // Live check via SessionManager
                const { SessionManager } = await import('../services/sessionManager.js');
                const checkRes = await SessionManager.checkStatus(true).catch(err => ({
                    authenticated: false,
                    message: err.message,
                    user: null,
                }));

                const detectedUser = checkRes.user || extractGoogleUserFromProfile(profileDir);
                const isFullyAuth = Boolean(checkRes.authenticated && detectedUser?.name && detectedUser?.email);

                await instCol.updateOne(
                    { instanceId: targetId },
                    {
                        $set: {
                            'pendingCookies.status': 'applied',
                            'pendingCookies.appliedAt': new Date(),
                            'session.authenticated': isFullyAuth,
                            'session.cookieCount': normalizedCookies.length,
                            'session.cookies': normalizedCookies,
                            'session.user': isFullyAuth ? detectedUser : null,
                            'session.lastVerified': new Date(),
                            'session.message': isFullyAuth
                                ? `Google Auth Session verified for ${detectedUser.name} (${detectedUser.email})! Restarting instance terminal...`
                                : `Cookies applied (${normalizedCookies.length} cookies), restarting instance terminal...`,
                            status: 'restart_requested',
                            updatedAt: new Date(),
                        }
                    }
                );

                console.log(`\n============================================================`);
                console.log(`🎉 [DbPoller] Google Auth cookies applied successfully! Authenticated: ${isFullyAuth}`);
                console.log(`🔄 Closing current terminal and launching fresh npm run dev...`);
                console.log(`============================================================\n`);

                this._triggerWindowsRestart(targetId);
            }
        } catch (err) {
            logger.error(`[DbPoller] Error applying pending cookies:`, err);
            console.error(`❌ [DbPoller] Failed to apply cookies: ${err.message}`);
            try {
                const targetId = this._resolvedInstanceId || config.instanceId;
                const instCol = getAvatarInstancesCollection();
                await instCol.updateOne(
                    { instanceId: targetId },
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
            } catch (_) {}
        }
    }

    /**
     * Executes clean Windows RDP restart using restart-instance.bat, then exits
     * the current process so the new terminal window can bind the port cleanly.
     */
    _triggerWindowsRestart(targetId) {
        if (process.platform !== 'win32') return;

        const restartBatPath = path.resolve(process.cwd(), 'restart-instance.bat');
        const port = config.port || 5101;
        const windowTitle = `Avatar_${targetId}_Port_${port}`;
        const content = `@echo off
title Restart Avatar Instance ${targetId}
color 0E
cd /d "%~dp0"
echo ========================================================================
echo   DealerVersal - Restarting Avatar Instance: ${targetId} (Port: ${port})
echo ========================================================================
echo [1/3] Terminating old terminal and processes on Port ${port}...
taskkill /F /FI "WINDOWTITLE eq Avatar_${targetId}*" /T >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Avatar_*${targetId}*" /T >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Avatar_${this._rawId || targetId}*" /T >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :${port}') do (
    if not "%%p"=="0" taskkill /F /PID %%p /T >nul 2>&1
)
echo [2/3] Waiting 2 seconds for ports and file locks to release...
timeout /t 2 /nobreak >nul
echo [3/3] Launching fresh terminal with new Google session...
if exist "%~dp0run-instance.bat" (
    start "" /D "%~dp0" cmd /k call "%~dp0run-instance.bat"
) else (
    start "" /D "%~dp0" cmd /k npm run dev
)
echo [SUCCESS] Restart initiated!
`;
        fs.writeFileSync(restartBatPath, content, 'utf8');

        console.log(`[DbPoller] 🔄 Executing ${restartBatPath} and exiting current process...`);
        spawn('cmd.exe', ['/c', 'call', restartBatPath, targetId], {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd(),
        }).unref();

        setTimeout(() => {
            console.log(`[DbPoller] Exiting process cleanly so new terminal can bind port ${port}.`);
            process.exit(0);
        }, 1500);
    }

    /**
     * Internal: one poll cycle.
     * Finds pending jobs for this instance and adds them to the in-memory queue.
     */
    async _poll() {
        const instanceId = config.instanceId;
        this._pollCount++;

        // Update heartbeat in DB every 5 polls (~7.5s) and log periodically
        if (this._pollCount % 5 === 1) {
            await this._sendHeartbeat(true);
        }

        if (this._pollCount % 60 === 0) {
            logger.info(`[DbPoller] ❤️  Heartbeat — poll #${this._pollCount} for instance "${instanceId}"`);
        }

        // Check for any Google Auth Session ZIP uploaded from Admin Dashboard
        await this._checkPendingSessionZip();

        // Check for any Google Auth Cookies JSON uploaded from Admin Dashboard
        await this._checkPendingCookies();

        try {
            const instDoc = await this._resolveInstanceDoc();
            const targetId = instDoc?.instanceId || this._resolvedInstanceId || config.instanceId;

            // Check if manual restart was requested from Dashboard
            if (instDoc && instDoc.status === 'restart_requested') {
                logger.info(`[DbPoller] 🔄 Dashboard requested instance restart for "${targetId}".`);
                const instCol = getAvatarInstancesCollection();
                await instCol.updateOne(
                    { instanceId: targetId },
                    { $set: { status: 'running', 'session.message': 'Instance restarting with updated session...', updatedAt: new Date() } }
                );
                this._triggerWindowsRestart(targetId);
                return;
            }

            const jobsCol = getJobsCollection();
            const lookupIds = Array.from(new Set([config.instanceId, targetId, config.instanceId.replace(/-\d+$/, '')])).filter(Boolean);

            // Find pending jobs assigned to this specific instance, ordered oldest first
            const pendingJobs = await jobsCol
                .find({
                    instanceId: { $in: lookupIds },
                    status: 'pending',
                })
                .sort({ createdAt: 1 })
                .limit(10) // Max 10 at a time to avoid overwhelming queue
                .toArray();

            if (pendingJobs.length === 0) {
                // In on-demand mode (RDP), if queue is empty and poller has been idle with 0 pending jobs, exit cleanly!
                if (config.onDemandMode || process.env.ON_DEMAND_MODE === 'true') {
                    if (!generationQueue.isProcessing && generationQueue.queue.length === 0) {
                        this._idleCycles = (this._idleCycles || 0) + 1;
                        // 15 cycles * 1500ms = ~22 seconds of continuous idle
                        if (this._idleCycles >= 15) {
                            logger.info(`[DbPoller] On-demand worker idle with no pending jobs for 22s. Closing worker terminal...`);
                            console.log(`\n💤 [On-Demand Worker] No pending jobs remaining for "${instanceId}". Exiting and closing terminal...`);
                            try {
                                const { closeSharedContext } = await import('../tools/googleFxFlow.js');
                                await closeSharedContext();
                            } catch (_) {}
                            process.exit(0);
                        }
                    }
                }
                return; // Nothing to do
            }

            this._idleCycles = 0;

            logger.info(`[DbPoller] 📬 Found ${pendingJobs.length} pending job(s) for instance "${instanceId}"`);
            console.log(`\n📬 [DbPoller] Found ${pendingJobs.length} pending job(s) for instance "${instanceId}"`);

            for (const job of pendingJobs) {
                // Skip if already in queue or currently processing
                if (generationQueue.hasJob(job.itemId)) {
                    logger.info(`[DbPoller] Job ${job.itemId} already in queue — skipping`);
                    continue;
                }

                const jobData = {
                    itemId: job.itemId,
                    type: job.type || 'avatar_video',
                    prompt: job.prompt,
                    settings: job.settings || {},
                    mediaUrl: job.mediaUrl || job.imageUrl || null,
                    imageUrl: job.mediaUrl || job.imageUrl || null,
                    avatarName: job.avatarName || 'me',
                    retryCount: job.retryCount || 0,
                };

                logger.info(`[DbPoller] ➕ Adding job ${job.itemId} to in-memory queue (type: ${jobData.type}, avatar: ${jobData.avatarName})`);
                console.log(`➕ [DbPoller] Picking up job ${job.itemId} from DB → adding to generation queue`);

                generationQueue.addJob(jobData);
            }
        } catch (err) {
            logger.error(`[DbPoller] Error during poll cycle:`, err);
        }
    }

    isRunning() {
        return this._running;
    }
}

export const dbPoller = new DbPoller();
