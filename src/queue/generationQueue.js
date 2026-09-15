// src/queue/generationQueue.js
import { getJobsCollection } from '../db.js';
import { registry } from '../mcp/registry.js';
import { logger } from '../utils/logger.js';
import { triggerServerRestart } from '../utils/restart.js';
import { closeSharedContext } from '../tools/googleFxFlow.js';


class GenerationQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    /**
     * Add a job to the in-memory processing queue
     * @param {object} jobData - { itemId, type, prompt, settings }
     */
    addJob(jobData) {
        this.queue.push(jobData);
        logger.info(`[Queue] Added job ${jobData.itemId} to queue. Current length: ${this.queue.length}`);
        console.log(`📥 [Queue] Job ${jobData.itemId} added. Total in queue: ${this.queue.length}`);
        
        // Start processing asynchronously in background
        setImmediate(() => this.processNext());
    }

    async processNext() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;
        const currentJobData = this.queue.shift();
        const { itemId, type, prompt, settings, avatarName } = currentJobData;
        const mediaUrl = currentJobData.mediaUrl || currentJobData.imageUrl || null;
        const proxy = currentJobData.proxy || null; // Webshare proxy config (may be null = direct)

        console.log('\n' + '═'.repeat(60));
        console.log(`⚙️  [Queue Worker] Processing Scene Creation Job: ${itemId}`);
        console.log(`🎬  Type: ${type} | Avatar: ${avatarName || 'me'} | Prompt Length: ${prompt ? prompt.length : 0} chars`);
        if (mediaUrl) console.log(`🖼️   Media URL: ${mediaUrl}`);
        if (avatarName) console.log(`👤  Avatar Name: ${avatarName}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📦 FULL JOB PAYLOAD DATA:');
        console.log(JSON.stringify(currentJobData, null, 2));
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💬 FULL QUEUED PROMPT TO BE EXECUTED:');
        console.log(prompt);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('═'.repeat(60) + '\n');

        const startTime = Date.now();

        try {
            // Update MongoDB status to processing
            const jobsCol = getJobsCollection();
            await jobsCol.updateOne(
                { itemId },
                { $set: { status: 'processing', updatedAt: new Date() } }
            );
            logger.info(`[Queue] Job ${itemId} status set to processing.`);

            // Get automation tool
            const tool = registry.getTool('google_fx_flow');
            const result = await tool.execute({ itemId, prompt, type, settings, mediaUrl, imageUrl: mediaUrl, avatarName, proxy });

            const durationMs = Date.now() - startTime;
            const isVideoType = type === 'video' || type === 'avatar_video';

            // Strict URL isolation: Video job NEVER falls back to image thumbnails in mediaUrls
            const primaryVideoUrl = isVideoType
                ? (result.videoUrl || (result.mediaUrls && result.mediaUrls.find(url => url.includes('.mp4') || url.includes('.webm') || url.includes('video'))) || null)
                : null;
            const primaryImageUrl = type === 'image'
                ? (result.imageUrl || (result.mediaUrls && result.mediaUrls[0]) || null)
                : null;

            if (isVideoType && !result.r2Url && !primaryVideoUrl) {
                throw new Error(`[Queue Worker] Video generation job ${itemId} finished without a valid video asset (only video assets can complete video jobs).`);
            }

            // Update DB with completed result & R2 cloud storage URLs
            await jobsCol.updateOne(
                { itemId },
                {
                    $set: {
                        status: 'completed',
                        genratedUrl: isVideoType ? (result.r2Url || primaryVideoUrl || '') : (result.r2Url || primaryImageUrl || ''),
                        result: {
                            videoUrl: isVideoType ? (result.r2Url || primaryVideoUrl) : null,
                            imageUrl: isVideoType ? null : (result.r2Url || primaryImageUrl),
                            r2Url: result.r2Url || null,
                            r2Key: result.r2Key || null,
                            downloadPath: result.downloadPath || null,
                            downloadUrl: result.downloadUrl || null,
                            filename: result.filename || null,
                            mediaUrls: result.mediaUrls || [],
                            text: result.text || '',
                            rawHtml: result.html || '',
                        },
                        durationMs,
                        error: null,
                        updatedAt: new Date(),
                    },
                }
            );

            logger.info(`[Queue] Job ${itemId} completed successfully in ${durationMs}ms.`);
            console.log(`✅ [Queue Worker] Job ${itemId} COMPLETED in ${durationMs}ms`);

            // Schedule server restart (PM2 on VPS / node --watch locally) 3s after browser closed & DB updated
            triggerServerRestart(3000);
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const currentRetryCount = currentJobData.retryCount || 0;
            const maxRetries = 2;
            const jobsCol = getJobsCollection();

            if (currentRetryCount < maxRetries) {
                const nextRetryCount = currentRetryCount + 1;
                logger.warn(`[Queue Worker] Job ${itemId} failed (Attempt ${currentRetryCount + 1}/${maxRetries + 1}). Tearing down browser context & scheduling retry #${nextRetryCount}/${maxRetries} in 5s. Error: ${err.message}`);
                console.error(`\n⚠️  [Queue Worker] Job ${itemId} FAILED (Attempt ${currentRetryCount + 1}/${maxRetries + 1}): ${err.message}`);
                console.log(`🔄 [Queue Worker] Closing browser context & scheduling Retry #${nextRetryCount} in 5 seconds...\n`);

                await jobsCol.updateOne(
                    { itemId },
                    {
                        $set: {
                            status: 'retrying',
                            retryCount: nextRetryCount,
                            lastError: err.message || 'Generation failed',
                            updatedAt: new Date(),
                        },
                    }
                );

                // 1. Teardown shared browser context cleanly so next attempt starts with a clean slate
                try {
                    await closeSharedContext();
                } catch (closeErr) {
                    console.warn(`[Queue Worker] Warning closing browser context during retry: ${closeErr.message}`);
                }

                // 2. Wait 5 seconds for resources to settle
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // 3. Re-enqueue request for retry
                if (!this.queue.some(j => j.itemId === itemId)) {
                    this.addJob({
                        ...currentJobData,
                        retryCount: nextRetryCount,
                        // proxy remains the same for retries — avatar VPS side handles retry with fresh browser
                    });
                }
            } else {
                logger.error(`[Queue Worker] Job ${itemId} failed permanently after ${maxRetries} retries:`, err);
                console.error(`\n❌ [Queue Worker] Job ${itemId} FAILED permanently after ${maxRetries} retries: ${err.message}\n`);


                await jobsCol.updateOne(
                    { itemId },
                    {
                        $set: {
                            status: 'failed',
                            error: err.message || 'Generation failed after max retries',
                            retryCount: currentRetryCount,
                            durationMs,
                            updatedAt: new Date(),
                        },
                    }
                );

                // Schedule server restart 3s after final job failure
                triggerServerRestart(3000);
            }
        } finally {
            this.isProcessing = false;
            // Process remaining jobs in queue if any remain before restart executes
            if (this.queue.length > 0) {
                setImmediate(() => this.processNext());
            }
        }
    }

    /**
     * Recovers pending or retrying jobs from MongoDB on server startup
     */
    async recoverPendingJobs() {
        try {
            const jobsCol = getJobsCollection();
            const unfinishedJobs = await jobsCol
                .find({ status: { $in: ['pending', 'retrying'] } })
                .sort({ createdAt: 1 })
                .toArray();

            if (!unfinishedJobs || unfinishedJobs.length === 0) {
                return;
            }

            logger.info(`[Queue] Found ${unfinishedJobs.length} pending/retrying job(s) in DB to recover.`);
            console.log(`🔄 [Queue] Recovering ${unfinishedJobs.length} pending/retrying job(s) from database...`);

            for (const job of unfinishedJobs) {
                const jobData = {
                    itemId: job.itemId,
                    type: job.type,
                    prompt: job.prompt,
                    settings: job.settings,
                    mediaUrl: job.mediaUrl || job.imageUrl || null,
                    imageUrl: job.mediaUrl || job.imageUrl || null,
                    avatarName: job.avatarName || 'me',
                    retryCount: job.retryCount || 0,
                };

                if (job.status === 'retrying') {
                    const elapsedMs = Date.now() - new Date(job.updatedAt || job.createdAt).getTime();
                    const remainingWaitMs = Math.max(0, 10000 - elapsedMs);
                    console.log(`⏳ [Queue Recovery] Job ${job.itemId} (Retry #${job.retryCount || 1}/2) waiting ${Math.round(remainingWaitMs / 1000)}s before executing retry...`);
                    setTimeout(() => {
                        if (!this.queue.some(j => j.itemId === job.itemId)) {
                            this.addJob(jobData);
                        }
                    }, remainingWaitMs);
                } else {
                    if (!this.queue.some(j => j.itemId === job.itemId)) {
                        this.addJob(jobData);
                    }
                }
            }
        } catch (err) {
            logger.error(`[Queue] Error recovering pending/retrying jobs:`, err);
        }
    }

    getQueueLength() {
        return this.queue.length;
    }
}

export const generationQueue = new GenerationQueue();
