// src/queue/generationQueue.js
import { getJobsCollection } from '../db.js';
import { registry } from '../mcp/registry.js';
import { logger } from '../utils/logger.js';

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
        const { itemId, type, prompt, settings } = currentJobData;

        console.log('\n' + '═'.repeat(60));
        console.log(`⚙️  [Queue Worker] Processing Job: ${itemId}`);
        console.log(`🎬  Type: ${type} | Prompt: "${prompt.substring(0, 80)}..."`);
        console.log('═'.repeat(60));

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
            const result = await tool.execute({ itemId, prompt, type, settings });

            const durationMs = Date.now() - startTime;
            const primaryVideoUrl = result.videoUrl || (result.mediaUrls && result.mediaUrls.find(url => url.includes('.mp4') || url.includes('video'))) || (result.mediaUrls && result.mediaUrls[0]) || null;
            const primaryImageUrl = result.imageUrl || (type === 'image' && result.mediaUrls && result.mediaUrls[0]) || null;

            // Update DB with completed result & R2 cloud storage URLs
            await jobsCol.updateOne(
                { itemId },
                {
                    $set: {
                        status: 'completed',
                        result: {
                            videoUrl: type === 'video' ? primaryVideoUrl : null,
                            imageUrl: type === 'image' ? primaryImageUrl : null,
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
        } catch (err) {
            const durationMs = Date.now() - startTime;
            logger.error(`[Queue] Job ${itemId} failed:`, err);
            console.error(`❌ [Queue Worker] Job ${itemId} FAILED: ${err.message}`);

            const jobsCol = getJobsCollection();
            await jobsCol.updateOne(
                { itemId },
                {
                    $set: {
                        status: 'failed',
                        error: err.message || 'Generation failed',
                        durationMs,
                        updatedAt: new Date(),
                    },
                }
            );
        } finally {
            this.isProcessing = false;
            // Process remaining jobs in queue
            if (this.queue.length > 0) {
                setImmediate(() => this.processNext());
            }
        }
    }

    getQueueLength() {
        return this.queue.length;
    }
}

export const generationQueue = new GenerationQueue();
