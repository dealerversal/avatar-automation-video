// src/routes/fxFlow.route.js
import { Router } from 'express';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { getJobsCollection } from '../db.js';
import { generationQueue } from '../queue/generationQueue.js';
import { logger } from '../utils/logger.js';

const router = Router();

const generateAvatarSchema = Joi.object({
    prompt: Joi.string().min(1).max(5000).required().messages({
        'string.empty': 'Prompt cannot be empty',
        'string.max': 'Prompt must be 5000 characters or less',
        'any.required': 'prompt field is required',
    }),
    type: Joi.string().valid('video', 'avatar_video').optional().default('avatar_video'),
    avatarName: Joi.string().optional().default('me').messages({
        'string.base': 'avatarName must be a string',
    }),
    settings: Joi.object().optional().default({}),
    mediaUrl: Joi.string().uri().optional().allow(null, '').messages({
        'string.uri': 'mediaUrl must be a valid URL',
    }),
    imageUrl: Joi.string().uri().optional().allow(null, '').messages({
        'string.uri': 'imageUrl must be a valid URL',
    }),
}).unknown(true);

/**
 * POST /api/fx-flow/generate-avatar-video
 * Submits a new avatar video generation job.
 *
 * Full automation flow:
 *   1. Navigate to Google Flow → Create New Project
 *   2. Enable Agent mode
 *   3. Add account avatar ("me") to prompt
 *   4. Upload reference image (mediaUrl/imageUrl), wait for upload to finish, add to prompt
 *   5. Open Agent Settings → configure (aspect ratio, model, duration, confirm=Never) → Save
 *   6. Submit prompt → monitor generation → return result
 */
const handleGenerateAvatarVideo = async (req, res) => {
    const requestId = req.requestId;

    const { error, value } = generateAvatarSchema.validate(req.body);
    if (error) {
        return res.status(400).json({
            success: false,
            error: error.details[0].message,
            request_id: requestId,
        });
    }

    const { prompt, settings } = value;
    const type = value.type || 'avatar_video';
    const avatarName = value.avatarName || 'me';
    const mediaUrl = value.mediaUrl || value.imageUrl || null;
    const itemId = `gen_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

    logger.info(`[FxFlowRoute] [${requestId}] New avatar video request queued (avatarName: "${avatarName}"): "${prompt.substring(0, 60)}..." (itemId: ${itemId})`);

    try {
        const jobsCol = getJobsCollection();
        const now = new Date();
        const jobDoc = {
            itemId,
            type,
            prompt,
            settings,
            mediaUrl,
            imageUrl: mediaUrl,
            avatarName,
            status: 'pending',
            result: {
                videoUrl: null,
                imageUrl: null,
                mediaUrls: [],
                text: '',
                rawHtml: '',
            },
            error: null,
            durationMs: 0,
            createdAt: now,
            updatedAt: now,
        };

        await jobsCol.insertOne(jobDoc);

        // Add to background in-memory queue
        generationQueue.addJob({
            itemId,
            type,
            prompt,
            settings,
            mediaUrl,
            imageUrl: mediaUrl,
            avatarName,
        });

        return res.status(202).json({
            success: true,
            itemId,
            status: 'pending',
            type,
            prompt,
            avatarName,
            settings,
            mediaUrl,
            imageUrl: mediaUrl,
            message: `Avatar video generation job queued successfully. Check status at /api/fx-flow/status/${itemId}`,
            statusUrl: `/api/fx-flow/status/${itemId}`,
            request_id: requestId,
        });
    } catch (err) {
        logger.error(`[FxFlowRoute] [${requestId}] Avatar DB/Queue Error:`, err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to enqueue avatar video generation job',
            request_id: requestId,
        });
    }
};

router.post('/generate-avatar-video', handleGenerateAvatarVideo);

/**
 * GET /api/fx-flow/status/:itemId
 * Checks job status and retrieves results from MongoDB
 */
router.get('/status/:itemId', async (req, res) => {
    const { itemId } = req.params;
    const requestId = req.requestId;

    try {
        const jobsCol = getJobsCollection();
        const job = await jobsCol.findOne({ itemId });

        if (!job) {
            return res.status(404).json({
                success: false,
                error: `Job with itemId "${itemId}" not found`,
                request_id: requestId,
            });
        }

        const r2Url = job.result?.r2Url || null;
        const r2Key = job.result?.r2Key || null;

        return res.json({
            success: true,
            itemId: job.itemId,
            status: job.status,
            progressPct: job.progressPct || (job.status === 'completed' ? 100 : 0),
            progressStatus: job.progressStatus || (job.status === 'completed' ? 'Completed' : job.status),
            type: job.type,
            prompt: job.prompt,
            avatarName: job.avatarName || null,
            settings: job.settings,
            mediaUrl: job.mediaUrl || job.imageUrl || null,
            r2Url,
            r2Key,
            result: job.result,
            error: job.error,
            durationMs: job.durationMs,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            request_id: requestId,
        });
    } catch (err) {
        logger.error(`[FxFlowRoute] Status fetch error:`, err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal server error fetching job status',
            request_id: requestId,
        });
    }
});

/**
 * GET /api/fx-flow/jobs
 * Lists recent generation jobs from MongoDB
 */
router.get('/jobs', async (req, res) => {
    try {
        const jobsCol = getJobsCollection();
        const jobs = await jobsCol
            .find({}, { projection: { 'result.rawHtml': 0 } })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();

        res.json({
            success: true,
            count: jobs.length,
            jobs,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

export default router;
