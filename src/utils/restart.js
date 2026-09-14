// src/utils/restart.js
import { exec } from 'child_process';
import { utimesSync, existsSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Triggers process restart after project completion, browser close, and DB/R2 updates.
 * Supports both PM2 on VPS and local npm run dev (node --watch).
 * 
 * @param {number} delayMs Delay in milliseconds before triggering restart (default: 3000)
 */
export function triggerServerRestart(delayMs = 3000) {
    const appName = process.env.PM2_APP_NAME ||
        (process.env.INSTANCE_ID ? `avatar-inst-${process.env.INSTANCE_ID}` : 'video-gen.dealerversal.com');

    logger.info(`[Restart] Project completed & browser closed. Scheduling server restart in ${delayMs / 1000}s (PM2 App: "${appName}")...`);
    console.log(`\n🔄 [Server Restart] Scheduled in ${delayMs / 1000} seconds...`);

    setTimeout(() => {
        logger.info(`[Restart] Initiating server restart now...`);
        console.log(`🔄 [Server Restart] Initiating server restart now...`);

        // 1. Attempt PM2 restart for VPS environment
        const pm2Cmd = `/usr/bin/pm2 restart ${appName} || pm2 restart ${appName} || pm2 restart avatar-automation-video`;
        exec(pm2Cmd, (err, stdout) => {
            if (!err) {
                logger.info(`[Restart] PM2 restart command executed successfully for "${appName}".`);
                console.log(`✅ [Restart] PM2 restart command executed successfully: ${stdout?.trim() || 'OK'}`);
            } else {
                logger.info(`[Restart] PM2 command not active/failed (${err.message}). Triggering local dev restart...`);
            }

            // 2. Trigger local dev node --watch restart by touching src/server.js
            try {
                const serverPath = path.resolve(process.cwd(), 'src/server.js');
                if (existsSync(serverPath)) {
                    const now = new Date();
                    utimesSync(serverPath, now, now);
                    logger.info(`[Restart] Touched ${serverPath} for node --watch restart.`);
                    console.log(`✅ [Restart] Touched ${serverPath} for local npm run dev restart.`);
                }
            } catch (touchErr) {
                logger.error(`[Restart] Error touching server file: ${touchErr.message}`);
            }

            // 3. Fallback exit for standalone process supervisors
            setTimeout(() => {
                logger.info('[Restart] Exiting process cleanly for supervisor restart...');
                process.exit(0);
            }, 1000);
        });
    }, delayMs);
}
