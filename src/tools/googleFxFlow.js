// src/tools/googleFxFlow.js
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, createWriteStream, renameSync } from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseTool } from '../mcp/baseTool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { uploadToR2 } from '../services/r2Service.js';
import { getJobsCollection } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_FX_URL = 'https://labs.google/fx/tools/flow';

let sharedContext = null;
let isInitializing = false;

export async function closeSharedContext() {
    if (sharedContext) {
        const ctxToClose = sharedContext;
        sharedContext = null;
        try {
            await ctxToClose.close();
            console.log('      🚪 Browser instance closed completely.');
        } catch (e) {
            console.warn(`      ⚠️ Warning closing shared browser context: ${e.message}`);
        }
    }
}

/**
 * Strictly inspects magic bytes to ensure a buffer is a real video stream (.mp4, .webm, .mov)
 * and NOT an image file (.png, .jpeg, .gif, .webp).
 */
export function isVideoBuffer(buffer) {
    if (!buffer || buffer.length < 12) return false;
    // Disallow PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return false;
    // Disallow JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return false;
    // Disallow GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return false;
    // Disallow WebP: RIFF ... WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return false;
    // Disallow SVG text / HTML
    const headText = buffer.slice(0, 64).toString('latin1').toLowerCase();
    if (headText.includes('<svg') || headText.includes('<!doctype') || headText.includes('<html')) return false;

    // Allowed MP4 check: ftyp at index 4
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return true;
    // Allowed WebM check: 1A 45 DF A3
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return true;
    // Allowed QuickTime MOV check: moov or mdat or ftyp in first 64 bytes
    if (headText.includes('ftyp') || headText.includes('moov') || headText.includes('mdat')) return true;
    return false;
}

/**
 * Executes a page.evaluate with automatic retries if the execution context was destroyed
 * due to an ongoing page navigation, redirection, or component re-render.
 */
export async function safeEvaluate(page, fn, ...args) {
    if (!page || page.isClosed()) throw new Error('Page is closed or undefined');
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            return await page.evaluate(fn, ...args);
        } catch (err) {
            const msg = (err.message || '').toLowerCase();
            const isNavigationError = msg.includes('execution context was destroyed') ||
                msg.includes('target closed') ||
                msg.includes('cannot find context') ||
                msg.includes('frame was detached');

            if (isNavigationError && attempt < 4) {
                console.warn(`      ⚠️ Page is navigating/re-rendering (attempt ${attempt}/4). Waiting 1.5s for DOM to settle...`);
                try { await page.waitForLoadState('domcontentloaded', { timeout: 6000 }); } catch (_) {}
                await page.waitForTimeout(1500);
            } else {
                throw err;
            }
        }
    }
}



export class GoogleFxFlowTool extends BaseTool {
    get name() {
        return 'google_fx_flow';
    }

    get description() {
        return (
            'Automates Google FX Flow (labs.google/fx/tools/flow) for Video & Image generation. ' +
            'Supports video and image types, custom settings, prompt execution, and asset URL extraction.'
        );
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The creative text prompt for video or image generation',
                },
                type: {
                    type: 'string',
                    enum: ['video', 'image'],
                    description: 'Generation type: "video" or "image"',
                    default: 'video',
                },
                settings: {
                    type: 'object',
                    description: 'Optional model and style settings (e.g. { model: "omni-flash", aspectRatio: "16:9" })',
                },
                mediaUrl: {
                    type: 'string',
                    description: 'Optional public URL of reference media (image, video, or audio) to upload into Google Flow prompt bar before generation',
                },
                imageUrl: {
                    type: 'string',
                    description: 'Optional public URL of reference media (legacy alias for mediaUrl)',
                },
                avatarName: {
                    type: 'string',
                    description: 'Optional name of pre-created account avatar to search and select (e.g. "me")',
                },
            },
            required: ['prompt'],
        };
    }

    async _getSharedContext() {
        if (sharedContext) {
            try {
                const testPage = await sharedContext.newPage();
                await testPage.close();
                return sharedContext;
            } catch (err) {
                console.warn(`[GoogleFX] ⚠️ Singleton context lost. Reinitializing...`);
                sharedContext = null;
            }
        }

        while (isInitializing) {
            await new Promise((r) => setTimeout(r, 500));
        }

        if (sharedContext) return sharedContext;

        isInitializing = true;
        try {
            const profileDir = config.browser.profileDir;
            if (!existsSync(profileDir)) {
                mkdirSync(profileDir, { recursive: true });
            }

            // Remove stale locks if present to prevent Chrome profile warning dialogs
            try {
                const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
                for (const file of lockFiles) {
                    const lockPath = path.join(profileDir, file);
                    if (existsSync(lockPath)) {
                        await import('fs/promises').then((fsP) => fsP.unlink(lockPath)).catch(() => {});
                    }
                }
            } catch {}

            const launchOptions = {
                headless: config.browser.headless,
                slowMo: config.browser.slowMo,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--window-size=1280,800',
                    '--force-device-scale-factor=1',
                    '--hide-scrollbars',
                    '--mute-audio',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                ],
                viewport: { width: 1280, height: 800 },
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            };

            try {
                sharedContext = await chromium.launchPersistentContext(profileDir, {
                    ...launchOptions,
                    channel: 'chrome',
                    ignoreDefaultArgs: ['--enable-automation'],
                });
            } catch (e1) {
                sharedContext = await chromium.launchPersistentContext(profileDir, launchOptions);
            }

            // Auto-inject decrypted cookies if cookies.json or storageState.json exists in profileDir
            const cookiesJsonPath = path.join(profileDir, 'cookies.json');
            const storageStateJsonPath = path.join(profileDir, 'storageState.json');
            if (existsSync(cookiesJsonPath)) {
                try {
                    const cData = JSON.parse(readFileSync(cookiesJsonPath, 'utf8'));
                    if (Array.isArray(cData) && cData.length > 0) {
                        await sharedContext.addCookies(cData);
                        logger.info(`[GoogleFX] Injected ${cData.length} cookies from cookies.json into sharedContext.`);
                    }
                } catch (e) {
                    logger.warn('[GoogleFX] Could not inject cookies.json:', e.message);
                }
            } else if (existsSync(storageStateJsonPath)) {
                try {
                    const sData = JSON.parse(readFileSync(storageStateJsonPath, 'utf8'));
                    if (sData.cookies && Array.isArray(sData.cookies) && sData.cookies.length > 0) {
                        await sharedContext.addCookies(sData.cookies);
                        logger.info(`[GoogleFX] Injected ${sData.cookies.length} cookies from storageState.json into sharedContext.`);
                    }
                } catch (e) {
                    logger.warn('[GoogleFX] Could not inject storageState.json:', e.message);
                }
            }

            await sharedContext.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.navigator.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

                let currentHighlight = null;
                let highlightTimer = null;

                // Visual highlight effect for exact element being clicked
                const highlight = (el) => {
                    if (!el || !(el instanceof HTMLElement)) return;
                    try {
                        if (currentHighlight && currentHighlight !== el) {
                            try {
                                currentHighlight.style.outline = currentHighlight._origOutline || '';
                                currentHighlight.style.boxShadow = currentHighlight._origBoxShadow || '';
                                currentHighlight.style.transition = currentHighlight._origTransition || '';
                            } catch {}
                        }

                        if (highlightTimer) clearTimeout(highlightTimer);

                        if (el._origOutline === undefined) {
                            el._origOutline = el.style.outline;
                            el._origBoxShadow = el.style.boxShadow;
                            el._origTransition = el.style.transition;
                        }

                        currentHighlight = el;
                        el.style.transition = 'outline 0.15s ease-in-out, box-shadow 0.15s ease-in-out';
                        el.style.outline = '3px solid #ff0055';
                        el.style.boxShadow = '0 0 12px #ff0055, 0 0 4px #ff0055 inset';

                        highlightTimer = setTimeout(() => {
                            if (el) {
                                try {
                                    el.style.outline = el._origOutline || '';
                                    el.style.boxShadow = el._origBoxShadow || '';
                                    el.style.transition = el._origTransition || '';
                                } catch {}
                            }
                            currentHighlight = null;
                        }, 800);
                    } catch {}
                };

                window.__highlight = highlight;

                document.addEventListener('click', (e) => {
                    if (e.target) {
                        const targetEl = e.target.closest('button, [role="button"], [role="tab"], [role="radio"]') || e.target;
                        if (targetEl && targetEl instanceof HTMLElement) {
                            highlight(targetEl);
                        }
                    }
                }, true);
            });
            console.log(`[GoogleFX] ✅ Singleton browser context ready (visual element highlighting enabled).`);
        } catch (err) {
            console.error(`[GoogleFX] ❌ Failed to launch browser context: ${err.message}`);
            sharedContext = null;
            throw err;
        } finally {
            isInitializing = false;
        }

        return sharedContext;
    }

    _cleanPromptText(input) {
        if (!input) return '';
        let str = typeof input === 'string' ? input.trim() : JSON.stringify(input);

        // Handle JSON array or JSON object inputs (e.g. [{"type": "text", "text": "..."}])
        if ((str.startsWith('[') && str.endsWith(']')) || (str.startsWith('{') && str.endsWith('}'))) {
            try {
                const parsed = JSON.parse(str);
                if (Array.isArray(parsed)) {
                    const textItem = parsed.find(item => item && (item.text || typeof item === 'string'));
                    if (textItem) {
                        return (typeof textItem === 'string' ? textItem : (textItem.text || '')).trim();
                    }
                } else if (parsed && typeof parsed === 'object') {
                    if (parsed.text) return String(parsed.text).trim();
                    if (parsed.prompt) return this._cleanPromptText(parsed.prompt);
                }
            } catch (e) {
                // Not valid JSON, fall through to regex fallback
            }

            const textMatch = str.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
            if (textMatch && textMatch[1]) {
                return textMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
            }
        }

        return str;
    }

    async execute({ itemId, prompt, type = 'video', settings = {}, mediaUrl = null, imageUrl = null, avatarName = null }) {
        const cleanPrompt = this._cleanPromptText(prompt);
        const effectiveMediaUrl = mediaUrl || imageUrl || null;
        const effectiveAvatarName = avatarName || (type === 'avatar_video' ? 'me' : null);
        const actualGenType = type === 'avatar_video' ? 'video' : type;
        const execStart = Date.now();
        console.log('\n' + '─'.repeat(60));
        console.log('🌐  [GoogleFxFlowTool] BROWSER AUTOMATION STARTED');
        console.log('─'.repeat(60));
        console.log(`🆔  Job ID      : ${itemId || 'N/A'}`);
        console.log(`🎬  Type        : ${type.toUpperCase()}`);
        console.log(`⚙️   Settings    : ${JSON.stringify(settings, null, 2)}`);
        if (effectiveMediaUrl) console.log(`🖼️   Media URL   : ${effectiveMediaUrl}`);
        if (effectiveAvatarName) console.log(`👤  Avatar Name : ${effectiveAvatarName}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`💬  EXACT FULL PROMPT TO BE SUBMITTED INTO BROWSER (${cleanPrompt.length} chars):`);
        console.log(cleanPrompt);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.info(`[GoogleFxFlowTool] Executing (${type}) [${itemId}]: "${cleanPrompt}"`);

        let context = null;
        let page = null;

        try {
            console.log(`\n[1/5] 🚀 Getting shared browser context...`);
            context = await this._getSharedContext();

            try {
                page = await context.newPage();
            } catch (err) {
                console.warn(`[GoogleFX] ⚠️ Context error, retrying...`);
                await closeSharedContext();
                context = await this._getSharedContext();
                page = await context.newPage();
            }

            // 1. Navigate to Google FX Flow
            console.log(`\n[2/6] 🌍 Navigating to ${GOOGLE_FX_URL} ...`);
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'domcontentloaded', timeout: config.browser.timeoutMs });
            await page.waitForTimeout(2500);
            await this._dismissOverlays(page);
            const currentUrl = page.url();
            console.log(`      ✅ Page loaded: ${currentUrl}`);

            // ── Session check: if redirected to Google login, session has expired ──
            if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin') || currentUrl.includes('accountchooser')) {
                throw new Error(
                    'Google session expired — browser was redirected to login page. ' +
                    'Please open the browser profile manually, log in to labs.google/fx/tools/flow, ' +
                    'then retry the request.'
                );
            }

            // 2. Always click "New Project" button first
            console.log(`\n[3/6] ➕ Creating a new project...`);
            await this._createNewProject(page);
            let projectUrl = page.url();
            console.log(`      ✅ New project opened: ${projectUrl}`);

            // Auto-handle OAuth consent screen if redirected to accounts.google.com
            if (projectUrl.includes('accounts.google.com') || projectUrl.includes('signin') || projectUrl.includes('oauth')) {
                console.log(`      ⚠️ Redirected to OAuth authorization screen, attempting auto-continue...`);
                try {
                    const consentBtn = await page.$('button:has-text("Continue"), button:has-text("Confirm"), button:has-text("Allow"), [data-email]');
                    if (consentBtn && (await consentBtn.isVisible())) {
                        await consentBtn.click();
                        console.log(`      👉 Auto-clicked OAuth consent/account button.`);
                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                        await page.waitForTimeout(3000);
                        projectUrl = page.url();
                        console.log(`      ✅ Redirected after consent: ${projectUrl}`);
                    }
                } catch (e) {}
            }

            // Session check after project creation
            if (projectUrl.includes('accounts.google.com') || projectUrl.includes('signin')) {
                throw new Error('Google session expired after project creation. Please re-login in the browser profile.');
            }

            // 2b. Ensure "All Media" tab is active
            console.log(`\n[3a/7] 📁 Selecting "All Media" tab...`);
            await this._ensureAllMediaTab(page);

            // 3. Enable Agent Mode FIRST (hardcoded enabled)
            console.log(`\n[3b/7] 🤖 Enabling Agent mode...`);
            await this._enableAgentMode(page);

            // 4. Add account Avatar to prompt + 5. Upload media — with internal retry (max 2 retries)
            let uploadedMediaUrls = [];
            let mediaUploadedInThisProject = false;
            this._mediaUploadedInCurrentProject = false;
            const MAX_UPLOAD_RETRIES = 2;

            for (let uploadAttempt = 1; uploadAttempt <= MAX_UPLOAD_RETRIES + 1; uploadAttempt++) {
                try {
                    if (uploadAttempt > 1) {
                        console.log(`\n[RETRY ${uploadAttempt - 1}/${MAX_UPLOAD_RETRIES}] 🔄 Re-running avatar + upload steps after failure...`);
                        // Close any open panels/dialogs before retry
                        try { await page.keyboard.press('Escape'); } catch {}
                        await page.waitForTimeout(2000);
                        // Re-ensure drawer is open
                        await this._clickExpandButton(page);
                        await page.waitForTimeout(800);
                    }

                    // 4. Add account Avatar to prompt
                    if (effectiveAvatarName) {
                        this._lastAvatarName = effectiveAvatarName;
                        console.log(`\n[4/7] 🔲 Ensuring session drawer is open before avatar selection... (attempt ${uploadAttempt})`);
                        await this._clickExpandButton(page);
                        await page.waitForTimeout(500);
                        console.log(`      👤 [STEP 1/2] Selecting Avatar "${effectiveAvatarName}" and adding to prompt...`);
                        await this._addAvatarToPrompt(page, effectiveAvatarName);
                    }

                    // 5. Upload reference image/media to prompt (RULE: Upload strictly ONCE per project)
                    if (effectiveMediaUrl) {
                        this._lastMediaUrl = effectiveMediaUrl;
                        if (mediaUploadedInThisProject) {
                            console.log(`\n[5/7] ℹ️ [RULE] Reference image was already uploaded in this project (${uploadedMediaUrls.length} url(s)). Skipping re-upload on retry in same project.`);
                        } else {
                            console.log(`\n[5/7] 🖼️ [STEP 2/2] Uploading reference media from URL... (attempt ${uploadAttempt}/${MAX_UPLOAD_RETRIES + 1})`);
                            uploadedMediaUrls = await this._uploadMediaFromUrl(page, effectiveMediaUrl, itemId);
                            mediaUploadedInThisProject = true;
                            this._mediaUploadedInCurrentProject = true;
                            console.log(`      🔒 Uploaded media URLs captured for exclusion: ${uploadedMediaUrls.length}`);
                        }
                    }

                    // Success — break out of retry loop
                    break;

                } catch (uploadErr) {
                    const isLastAttempt = uploadAttempt > MAX_UPLOAD_RETRIES;
                    if (isLastAttempt) {
                        console.error(`      ❌ Upload/avatar failed after ${MAX_UPLOAD_RETRIES} retries: ${uploadErr.message}`);
                        throw uploadErr; // Let queue-level retry handle it
                    }
                    console.warn(`      ⚠️ Upload/avatar attempt ${uploadAttempt} failed: ${uploadErr.message}`);
                    console.log(`      ⏳ Waiting 3s before retry ${uploadAttempt + 1}/${MAX_UPLOAD_RETRIES + 1}...`);
                    await page.waitForTimeout(3000);
                }
            }

            // 6. Open Agent Settings → configure (aspect ratio, model, duration, Never) → Save
            console.log(`\n[6/7] ⚙️ Opening Agent Settings and applying configuration...`);
            await this._applyAgentSettings(page, actualGenType, settings, cleanPrompt);

            // Wait for prompt bar to fully settle after upload + settings,
            // then snapshot ALL pre-existing media URLs (to exclude from result polling).
            await page.waitForTimeout(3000);
            const preExistingUrls = await page.evaluate(() => {
                const urls = new Set();
                document.querySelectorAll('img[src], video[src], video source[src]').forEach(el => {
                    const src = el.getAttribute('src') || '';
                    if (src && !src.startsWith('data:')) urls.add(src);
                });
                document.querySelectorAll('[src]').forEach(el => {
                    const src = el.getAttribute('src') || '';
                    if (src && (src.startsWith('blob:') || src.startsWith('http'))) urls.add(src);
                });
                return Array.from(urls);
            });
            console.log(`      📸 Pre-submit snapshot: ${preExistingUrls.length} existing media URLs captured (will be excluded from result)`);

            // 7. Enter Prompt & Submit
            // Ensure session drawer is open — it can close after media panel or settings panel interactions
            console.log(`\n[7/7] 🔲 Ensuring session drawer is open before prompt submission...`);
            await this._clickExpandButton(page);
            await page.waitForTimeout(800);
            console.log(`      ⌨️ Submitting prompt into generation bar...`);
            this._lastPrompt = cleanPrompt; // store for cancellation retry in _extractResult
            const postSubmitUrls = await this._submitPrompt(page, cleanPrompt);
            console.log(`      ✅ Prompt submitted!`);

            // Merge: preExisting + post-submit snapshot + explicitly captured uploaded URLs
            const allExcludedUrls = Array.from(new Set([...preExistingUrls, ...(postSubmitUrls || []), ...uploadedMediaUrls]));
            console.log(`      🔒 Total excluded reference media URLs: ${allExcludedUrls.length} (preExisting=${preExistingUrls.length}, postSubmit=${(postSubmitUrls||[]).length}, uploadedCapture=${uploadedMediaUrls.length})`);

            // 8. Poll and Extract Results & Download Local Asset
            console.log(`\n[8/8] ⏳ Polling for ${type} generation completion, downloading asset & saving locally...`);
            const result = await this._extractResult(page, type, itemId, allExcludedUrls);

            const totalMs = Date.now() - execStart;
            console.log('\n' + '─'.repeat(60));
            console.log(`✅  [GoogleFxFlowTool] GENERATION COMPLETED!`);
            console.log(`⏱️   Time      : ${totalMs}ms`);
            console.log(`🎥  Video URL : ${result.videoUrl || 'N/A'}`);
            console.log(`🖼️   Image URL : ${result.imageUrl || 'N/A'}`);
            console.log(`📦  Total Assets: ${result.mediaUrls ? result.mediaUrls.length : 0}`);
            console.log('─'.repeat(60) + '\n');
            logger.info(`[GoogleFxFlowTool] Completed in ${totalMs}ms`);

            // Immediately mark job as COMPLETED in MongoDB so status polling returns completed without delay
            if (itemId) {
                try {
                    const jobsCol = getJobsCollection();
                    const isVideoType = type === 'video' || type === 'avatar_video';
                    const primaryVideoUrl = result.videoUrl || (result.mediaUrls && result.mediaUrls.find(url => url.includes('.mp4') || url.includes('video'))) || (result.mediaUrls && result.mediaUrls[0]) || null;
                    const primaryImageUrl = result.imageUrl || (type === 'image' && result.mediaUrls && result.mediaUrls[0]) || null;
                    const finalGenUrl = result.r2Url || primaryVideoUrl || primaryImageUrl || '';

                    await jobsCol.updateOne(
                        { itemId },
                        {
                            $set: {
                                status: 'completed',
                                genratedUrl: finalGenUrl,
                                result: {
                                    videoUrl: isVideoType ? primaryVideoUrl : null,
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
                                durationMs: totalMs,
                                error: null,
                                updatedAt: new Date(),
                            },
                        }
                    );
                    console.log(`      💾 [GoogleFX] Job "${itemId}" status updated to COMPLETED in MongoDB.`);
                } catch (dbErr) {
                    console.warn(`      ⚠️ Warning updating completion status in DB: ${dbErr.message}`);
                }
            }

            return {
                success: true,
                type,
                prompt: cleanPrompt,
                settings,
                ...result,
                duration_ms: totalMs,
            };
        } catch (err) {
            console.error(`[GoogleFX] ❌ Execution error: ${err.message}`);
            throw err;
        } finally {
            if (page && !page.isClosed()) {
                try {
                    await page.close();
                    console.log(`      🔒 Browser tab closed cleanly.`);
                } catch (closeErr) {
                    console.warn(`      ⚠️ Warning closing browser tab: ${closeErr.message}`);
                }
            }
            try {
                await closeSharedContext();
            } catch (closeContextErr) {
                console.warn(`      ⚠️ Warning closing shared browser context: ${closeContextErr.message}`);
            }
        }
    }

    async _createNewProject(page) {
        // If not on main lander, navigate to GOOGLE_FX_URL first to locate New Project button
        if (!page.url().includes('labs.google/fx/tools/flow')) {
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'domcontentloaded', timeout: config.browser.timeoutMs });
            await page.waitForTimeout(2000);
        }

        const newProjectSelectors = [
            'button:has-text("New project")',
            'button:has-text("New Project")',
            'a:has-text("New project")',
            'a:has-text("New Project")',
            'button:has-text("+ New")',
            'button:has-text("Create")',
            'button:has-text("Start")',
            '[aria-label*="new project" i]',
            '[class*="new-project"]',
            'a[href*="project"]',
        ];

        let clicked = false;
        for (const sel of newProjectSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn && (await btn.isVisible())) {
                    await btn.click();
                    clicked = true;
                    console.log(`      ➕ Clicked "New Project" button: ${sel}`);
                    await page.waitForTimeout(3000);
                    break;
                }
            } catch {}
        }

        if (!clicked) {
            // Check if page has CTA buttons in body
            const buttons = await page.$$('button, a');
            for (const btn of buttons) {
                const text = (await btn.innerText()).toLowerCase();
                if (text.includes('new project') || text.includes('create') || text.includes('try flow') || text.includes('open studio')) {
                    await btn.click();
                    clicked = true;
                    console.log(`      ➕ Clicked CTA button for New Project: "${text.trim()}"`);
                    await page.waitForTimeout(3000);
                    break;
                }
            }
        }

        if (!clicked) {
            console.log(`      ℹ️ Already inside project or New Project button auto-triggered`);
        }
    }

    async _dismissOverlays(page) {
        // Button texts to click for dismissing announcement/changelog/info modals
        const DISMISS_TEXTS = [
            'get started',
            'got it',
            'ok',
            'okay',
            'dismiss',
            'close',
            'continue',
            'done',
            'accept',
            'agree',
            'i understand',
            'acknowledge',
            'view all changelogs', // secondary - skip this, prefer "Get started"
        ];

        // Run up to 3 passes to handle layered modals
        for (let pass = 0; pass < 3; pass++) {
            try {
                // Step 1: Click visible dismiss buttons on announcement/changelog modals
                let dismissed = false;
                const allBtns = await page.$$('button, [role="button"], a[role="button"]');
                for (const btn of allBtns) {
                    try {
                        const visible = await btn.isVisible();
                        if (!visible) continue;
                        const txt = (await btn.innerText()).trim().toLowerCase();
                        // Skip "view all changelogs" - it navigates away
                        if (txt === 'view all changelogs') continue;
                        if (DISMISS_TEXTS.some((d) => txt === d || txt.startsWith(d))) {
                            // Confirm this button is inside a modal/dialog/overlay
                            const inModal = await btn.evaluate((el) => {
                                const parent = el.closest(
                                    '[role="dialog"], [role="alertdialog"], ' +
                                    '[class*="modal"], [class*="dialog"], [class*="overlay"], ' +
                                    '[class*="popup"], [class*="announcement"], [class*="changelog"], ' +
                                    '[class*="banner"], [class*="sheet"]'
                                );
                                return !!parent;
                            });
                            if (inModal) {
                                await btn.click();
                                dismissed = true;
                                console.log(`      🧹 Dismissed modal via button: "${txt}"`);
                                await page.waitForTimeout(500);
                                break;
                            }
                        }
                    } catch {}
                }

                // Step 2: Remove overlay/modal/dialog DOM elements that are still visible
                await page.evaluate(() => {
                    // Cookie bars
                    const glueBar = document.querySelector('.glue-cookie-notification-bar');
                    if (glueBar) glueBar.remove();

                    // Generic selectors for modals/overlays
                    const overlaySelectors = [
                        '[class*="cookie"]', '[id*="cookie"]',
                        '[class*="modal-mask"]', '[class*="modal-backdrop"]',
                        '[class*="modal-overlay"]', '[class*="overlay-backdrop"]',
                    ];
                    overlaySelectors.forEach((sel) => {
                        document.querySelectorAll(sel).forEach((el) => {
                            if (el.style) el.style.display = 'none';
                        });
                    });

                    // Force-close any dialog/alertdialog still open that has no close button left
                    document.querySelectorAll('[role="dialog"], [role="alertdialog"]').forEach((el) => {
                        // Only remove if it's a floating layer (fixed/absolute position)
                        const style = window.getComputedStyle(el);
                        if (style.position === 'fixed' || style.position === 'absolute') {
                            // Check if it has content mentioning changelogs/watermark/announcement
                            const text = el.innerText ? el.innerText.toLowerCase() : '';
                            if (
                                text.includes('watermark') ||
                                text.includes('changelog') ||
                                text.includes('introducing') ||
                                text.includes('new feature') ||
                                text.includes('announcing') ||
                                text.includes('happy creating')
                            ) {
                                el.remove();
                            }
                        }
                    });
                });

                if (!dismissed && pass > 0) break; // No modal found in this pass, stop
                if (!dismissed) break;

            } catch (err) {
                console.warn(`      ⚠️ Dismiss overlay pass ${pass + 1} warning: ${err.message}`);
                break;
            }
        }
        console.log(`      🧹 Overlay dismissal complete`);
    }

    /**
     * Ensures that the "All Media" tab is selected in the left navigation sidebar.
     */
    async _ensureAllMediaTab(page) {
        console.log(`      📁 Ensuring "All Media" tab is selected...`);
        const clicked = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const buttons = Array.from(document.querySelectorAll('button'));
            const allMediaBtn = buttons.find(b => {
                if (!isVisible(b)) return false;
                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                return txt.includes('all media');
            });
            if (allMediaBtn) {
                const cls = allMediaBtn.className || '';
                const isSelected = cls.includes('jcMEtI') ||
                                   allMediaBtn.getAttribute('aria-selected') === 'true' ||
                                   allMediaBtn.getAttribute('data-state') === 'active';
                if (!isSelected) {
                    if (window.__highlight) window.__highlight(allMediaBtn);
                    allMediaBtn.click();
                    return true;
                }
                return 'already_active';
            }
            return false;
        });

        if (clicked === true) {
            console.log(`      ✅ Switched to "All Media" tab`);
            await page.waitForTimeout(1000);
        } else if (clicked === 'already_active') {
            console.log(`      ✅ "All Media" tab is already active`);
        } else {
            console.warn(`      ⚠️ Could not locate "All Media" tab button in sidebar`);
        }
    }

    /**
     * Enables the Agent mode pill in the prompt bar (hardcoded enabled).
     * Must be called BEFORE opening the media panel (avatar / upload),
     * because Agent mode changes the prompt bar controls.
     */
    async _enableAgentMode(page) {
        console.log(`      🤖 Enabling Agent mode pill (hardcoded)...`);

        // Try to find and click the "Agent" toggle pill button
        const agentBtnClicked = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

            // Find any button/toggle labeled "Agent" — look bottom prompt bar area first
            const allBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"]'));

            // Agent pill is usually near the prompt input — find it by text content
            const agentBtn = allBtns.find(b => {
                if (!isVisible(b)) return false;
                const txt = (b.innerText || b.textContent || '').trim();
                return txt === 'Agent' || txt.toLowerCase() === 'agent mode';
            });

            if (agentBtn) {
                const cls = agentBtn.className || '';
                const isOn = cls.includes('bdRbOx')
                    || agentBtn.getAttribute('aria-pressed') === 'true'
                    || agentBtn.getAttribute('aria-checked') === 'true'
                    || agentBtn.getAttribute('data-state') === 'on'
                    || agentBtn.getAttribute('data-active') === 'true';
                if (!isOn) {
                    console.log('[AgentMode] Clicking Agent pill to enable agent mode...');
                    if (window.__highlight) window.__highlight(agentBtn);
                    agentBtn.click();
                } else {
                    console.log('[AgentMode] Agent mode already enabled.');
                }
                return true;
            }
            return false;
        });

        await page.waitForTimeout(1200);

        // Verify agent mode is on (by checking for the Agent button active state)
        const isAgentOn = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const allBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"]'));
            const agentBtn = allBtns.find(b => {
                if (!isVisible(b)) return false;
                const txt = (b.innerText || b.textContent || '').trim();
                return txt === 'Agent' || txt.toLowerCase() === 'agent mode';
            });
            if (!agentBtn) {
                // If no Agent button found, check if session panel / agent UI elements are present
                // In the new Flow UI, the session panel IS the agent panel — no toggle needed
                const hasSessionPanel = Array.from(document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea'))
                    .some(el => el.offsetWidth > 0 && el.getBoundingClientRect().left > window.innerWidth * 0.5);
                return hasSessionPanel;
            }
            const cls = agentBtn.className || '';
            return cls.includes('bdRbOx')
                || agentBtn.getAttribute('aria-pressed') === 'true'
                || agentBtn.getAttribute('aria-checked') === 'true'
                || agentBtn.getAttribute('data-state') === 'on';
        });

        if (isAgentOn) {
            console.log(`      ✅ Agent mode confirmed ON`);
        } else if (!agentBtnClicked) {
            console.warn(`      ⚠️ Agent mode pill not found — new Flow UI may already be in Agent mode by default`);
        } else {
            console.warn(`      ⚠️ Agent mode may not be active — attempting fallback physical click`);
            const coords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'));
                const agentBtn = allBtns.find(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || b.textContent || '').trim();
                    return txt === 'Agent' || txt.toLowerCase() === 'agent mode';
                });
                if (agentBtn) {
                    agentBtn.scrollIntoView({ block: 'center' });
                    const r = agentBtn.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            });
            if (coords) {
                await page.mouse.click(coords.cx, coords.cy);
                await page.waitForTimeout(800);
            }
        }

        // After Agent mode is ON, click the "Expand" (expand_content) button if visible
        await this._clickExpandButton(page);
    }


    /**
     * Clicks the "Expand" (expand_content icon) button in the prompt bar if visible.
     * Opens the full-screen Agent session panel on the right side of the screen.
     * Class: sc-c4e423a0-3 / ewxUEp, Icon text: "expand_content"
     * This button appears ONLY when the session drawer is closed (collapsed).
     * Called before avatar add, before media upload, and before prompt submit.
     */
    async _clickExpandButton(page) {
        console.log(`      🔲 Checking Expand button to open Agent panel...`);

        // Check if panel is already expanded:
        // The surest sign is a right-side textbox (x > 60%) OR session panel header on right
        const alreadyExpanded = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            // Check 1: Right-side prompt input (textbox at x > 60% of viewport = panel open)
            const hasRightInput = Array.from(document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea'))
                .some(el => {
                    if (!isVisible(el)) return false;
                    const r = el.getBoundingClientRect();
                    return r.left > window.innerWidth * 0.6;
                });
            if (hasRightInput) return true;
            // Check 2: Session header with text "session" on right side
            const panelHeader = Array.from(document.querySelectorAll('[class*="sc-"]'))
                .find(el => isVisible(el) && (el.innerText || '').toLowerCase().includes('session') && el.getBoundingClientRect().right > window.innerWidth * 0.7);
            return !!panelHeader;
        });

        if (alreadyExpanded) {
            console.log(`      ✅ Agent panel is already expanded`);
            return;
        }

        console.log(`      🔓 Session panel CLOSED — clicking Expand button to open it...`);

        for (let attempt = 1; attempt <= 4; attempt++) {
            const coords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                // Strategy 1: Find by exact class sc-c4e423a0-3 / ewxUEp + expand_content icon
                let btn = Array.from(document.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const cls = b.className || '';
                    const hasClassMatch = cls.includes('sc-c4e423a0-3') || cls.includes('ewxUEp');
                    const hasExpandIcon = Array.from(b.querySelectorAll('i, span, *'))
                        .some(el => (el.textContent || '').trim() === 'expand_content');
                    return hasClassMatch && hasExpandIcon;
                });

                // Strategy 2: Any visible button with expand_content icon text
                if (!btn) {
                    btn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        return Array.from(b.querySelectorAll('i, span, *'))
                            .some(el => (el.textContent || '').trim() === 'expand_content');
                    });
                }

                // Strategy 3: Button with accessible label span text "Expand"
                if (!btn) {
                    btn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        return Array.from(b.querySelectorAll('span'))
                            .some(s => (s.textContent || '').trim() === 'Expand');
                    });
                }

                if (btn) {
                    if (window.__highlight) window.__highlight(btn);
                    btn.scrollIntoView({ block: 'center', inline: 'nearest' });
                    const r = btn.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            });

            if (coords) {
                console.log(`      🖱️ Clicking Expand button at [${coords.cx}, ${coords.cy}] (attempt ${attempt}/4)...`);
                try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                await page.waitForTimeout(1500);

                // Verify the panel opened (right-side textbox appeared)
                const panelVisible = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    return Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]'))
                        .some(el => {
                            if (!isVisible(el)) return false;
                            const r = el.getBoundingClientRect();
                            return r.left > window.innerWidth * 0.6;
                        });
                });

                if (panelVisible) {
                    console.log(`      ✅ Agent panel expanded successfully!`);
                    return;
                }
                console.warn(`      ⚠️ Panel not confirmed open after click (attempt ${attempt}/4)`);
            } else {
                console.warn(`      ℹ️ Expand button not found (attempt ${attempt}/4) — panel may already be open`);
                await page.waitForTimeout(600);
            }
        }
        console.warn(`      ⚠️ Could not confirm Expand panel opened — proceeding with flow`);
    }

    /**
     * Opens the Agent Settings panel via the tune/sliders icon in the prompt bar,
     * configures aspect ratio, model, duration, and confirm=Never, then clicks Save.
     *
     * Must be called AFTER avatar and media have been added to the prompt,
     * because Agent mode must already be active for the settings icon to be visible.
     */
    async _applyAgentSettings(page, type, settings = {}, promptText = '') {
        try {
            console.log(`      ⚙️ Opening Agent Settings panel for type="${type}": ${JSON.stringify(settings)}`);

            // Ensure any media panel is closed first (press Escape to close if open)
            await page.evaluate(() => {
                const isMediaPanelOpen = Array.from(document.querySelectorAll('input[placeholder]'))
                    .some(i => i.offsetWidth > 0 && (i.getAttribute('placeholder') || '').toLowerCase().includes('search assets'));
                if (isMediaPanelOpen) {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                }
            });
            await page.waitForTimeout(600);

            // ── STEP 1: Check if Agent Settings panel is already open ────────────
            let panelOpened = await page.evaluate(() => {
                const textPresent = (document.body.innerText || '').includes('Agent settings');
                const saveBtn = Array.from(document.querySelectorAll('button'))
                    .some(b => b.offsetWidth > 0 && (b.innerText || '').trim() === 'Save');
                return textPresent || saveBtn;
            });

            // ── STEP 2: Find & Click Settings Button ─────────────────────────────
            if (panelOpened) {
                console.log(`      ✅ Agent Settings drawer is already open`);
            } else {
                for (let attempt = 1; attempt <= 5; attempt++) {
                    const coords = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                        // STRATEGY 1: Top-right gear icon with aria-label="Settings" (confirmed working in new Flow UI)
                        let btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
                            if (!isVisible(b)) return false;
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
                            return aria === 'settings';
                        });

                        // STRATEGY 2: tune icon text in the bottom prompt bar (old behavior)
                        if (!btn) {
                            const isSettingsTarget = b => {
                                if (!b) return false;
                                const txt = (b.innerText || b.textContent || '').toLowerCase().trim();
                                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                if (txt.includes('expand') || aria.includes('expand')) return false;
                                if (txt.includes('instruction') || aria.includes('instruction')) return false;
                                if (txt === 'arrow_forward' || aria === 'create' || aria === 'send') return false;
                                return true;
                            };
                            btn = Array.from(document.querySelectorAll('button'))
                                .filter(isSettingsTarget)
                                .find(b => isVisible(b) && Array.from(b.querySelectorAll('*')).some(el => (el.textContent || '').trim() === 'tune'));
                        }

                        // STRATEGY 3: sliders icon aria-label
                        if (!btn) {
                            btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
                                if (!isVisible(b)) return false;
                                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                const txt = (b.innerText || b.textContent || '').toLowerCase().trim();
                                return aria.includes('setting') || aria.includes('sliders') || aria.includes('tune') ||
                                    txt === 'tune' || txt === 'sliders';
                            });
                        }

                        // STRATEGY 4: Old class-name based approach (legacy fallback)
                        if (!btn) {
                            btn = Array.from(document.querySelectorAll('button')).find(b => {
                                if (!isVisible(b)) return false;
                                const cls = b.className || '';
                                return cls.includes('sc-c4e423a0-1');
                            });
                        }

                        if (btn) {
                            if (window.__highlight) window.__highlight(btn);
                            btn.scrollIntoView({ block: 'center', inline: 'nearest' });
                            const r = btn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), strategy: btn.getAttribute('aria-label') || btn.textContent?.trim()?.substring(0, 20) };
                        }
                        return null;
                    });

                    if (coords && coords.cx > 0 && coords.cy > 0) {
                        console.log(`      ⚙️ Settings button clicked at [${coords.cx}, ${coords.cy}] (attempt ${attempt}, via: "${coords.strategy || 'unknown'}")`);
                        try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                    } else {
                        console.warn(`      ⚠️ Settings button not found on attempt ${attempt}/5`);
                    }
                    await page.waitForTimeout(1200);

                    panelOpened = await page.evaluate(() => {
                        const textPresent = (document.body.innerText || '').includes('Agent settings');
                        const saveBtn = Array.from(document.querySelectorAll('button')).some(b => b.offsetWidth > 0 && (b.innerText || '').trim() === 'Save');
                        return textPresent || saveBtn;
                    });

                    if (panelOpened) {
                        console.log(`      ✅ Agent Settings drawer confirmed open`);
                        break;
                    }
                }
            }

            if (!panelOpened) {
                console.warn(`      ⚠️ Could not open Agent Settings panel — proceeding with defaults`);
                return;
            }

            // ── STEP 3: ALWAYS force "Confirm before generating" → Never ─────────
            // This is MANDATORY — without it, Flow pauses and waits for human approval on every generation.
            // DOM: <input type="radio" class="mdc-radio__native-control" id="mat-radio-1-input"> (Never)
            // Selected state check: input.checked === true (NOT data-state/aria-checked — those are unreliable)
            console.log(`      🔴 [MANDATORY] Forcing "Confirm before generating" → Never...`);
            let neverConfirmed = false;

            for (let attempt = 1; attempt <= 5; attempt++) {
                // First: check if Never is already selected
                const isAlreadyNever = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    // Find the "Never" native radio input — look for the one whose sibling label text includes "Never"
                    const allNativeRadios = Array.from(document.querySelectorAll('input[type="radio"].mdc-radio__native-control, input[type="radio"]'));
                    for (const radio of allNativeRadios) {
                        const label = radio.closest('label') || radio.closest('.mdc-form-field') || radio.parentElement;
                        const labelText = (label?.innerText || label?.textContent || '').toLowerCase();
                        if (labelText.includes('never') || labelText.includes('auto_approve')) {
                            return radio.checked === true;
                        }
                    }
                    // Fallback: 2nd radio = Never (Always=first, Never=second)
                    const radios = allNativeRadios.filter(r => isVisible(r) || true); // native radios may be hidden by CSS
                    return radios.length >= 2 ? radios[1].checked === true : false;
                });

                if (isAlreadyNever) {
                    console.log(`      ✅ "Never" is already selected ✓`);
                    neverConfirmed = true;
                    break;
                }

                // Find the Never label/element and click it (multiple strategies)
                const clickCoords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                    // Strategy A: Find label wrapping the "Never" native radio — click the label
                    const allLabels = Array.from(document.querySelectorAll('label.mdc-form-field, label.mat-internal-form-field, label'));
                    const neverLabel = allLabels.find(label => {
                        const txt = (label.innerText || label.textContent || '').toLowerCase();
                        return txt.includes('never') && txt.length < 200; // not a huge container
                    });
                    if (neverLabel) {
                        neverLabel.click();
                        const r = neverLabel.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), via: 'label' };
                    }

                    // Strategy B: Click the native radio input itself
                    const allNativeRadios = Array.from(document.querySelectorAll('input[type="radio"].mdc-radio__native-control, input[type="radio"]'));
                    for (const radio of allNativeRadios) {
                        const label = radio.closest('label') || radio.closest('.mdc-form-field') || radio.parentElement;
                        const labelText = (label?.innerText || label?.textContent || '').toLowerCase();
                        if (labelText.includes('never')) {
                            radio.click();
                            const r = radio.getBoundingClientRect();
                            // If rect is zero (hidden), use parent label rect
                            const rect = (r.width > 0 && r.height > 0) ? r : label?.getBoundingClientRect();
                            return { cx: Math.round(rect.left + rect.width / 2), cy: Math.round(rect.top + rect.height / 2), via: 'native-radio' };
                        }
                    }

                    // Strategy C: [role="radio"] elements — pick the "Never" one
                    const roleRadios = Array.from(document.querySelectorAll('[role="radio"]'));
                    const neverRole = roleRadios.find(r => (r.innerText || r.textContent || '').toLowerCase().includes('never'));
                    if (neverRole) {
                        neverRole.click();
                        const r = neverRole.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), via: 'role-radio' };
                    }

                    // Strategy D: Any span/div with exactly "Never" text — click its parent
                    const allSpans = Array.from(document.querySelectorAll('span, div'));
                    const neverSpan = allSpans.find(el => {
                        if (!isVisible(el)) return false;
                        const txt = (el.innerText || el.textContent || '').trim();
                        return txt === 'Never';
                    });
                    if (neverSpan) {
                        const target = neverSpan.closest('label') || neverSpan.closest('[role="radio"]') || neverSpan;
                        target.click();
                        const r = target.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), via: 'span-text' };
                    }

                    return null;
                });

                if (clickCoords && clickCoords.cx > 0 && clickCoords.cy > 0) {
                    console.log(`      🖱️ Clicking "Never" at [${clickCoords.cx}, ${clickCoords.cy}] (attempt ${attempt}/5, via: ${clickCoords.via})`);
                    try { await page.mouse.click(clickCoords.cx, clickCoords.cy); } catch {}
                } else {
                    console.warn(`      ⚠️ "Never" radio element not found on attempt ${attempt}/5`);
                }
                await page.waitForTimeout(600);

                // Verify using .checked property — the reliable native DOM state
                neverConfirmed = await page.evaluate(() => {
                    const allNativeRadios = Array.from(document.querySelectorAll('input[type="radio"].mdc-radio__native-control, input[type="radio"]'));
                    for (const radio of allNativeRadios) {
                        const label = radio.closest('label') || radio.closest('.mdc-form-field') || radio.parentElement;
                        const labelText = (label?.innerText || label?.textContent || '').toLowerCase();
                        if (labelText.includes('never')) return radio.checked === true;
                    }
                    // Fallback: 2nd radio = Never
                    const radios = allNativeRadios;
                    return radios.length >= 2 ? radios[1].checked === true : false;
                });

                if (neverConfirmed) {
                    console.log(`      ✅ "Never" confirmed selected ✓ (attempt ${attempt}/5)`);
                    break;
                }
                await page.waitForTimeout(400);
            }

            if (!neverConfirmed) {
                console.warn(`      ⚠️ Could not verify "Never" selection after 5 attempts — Flow may pause and ask for confirmation!`);
            }


            // ── STEP 4: Target Section ("Video generation default") & Apply Settings ───────
            const isVideoJob = type === 'video' || type === 'avatar_video';
            const arVal = settings.aspectRatio || settings.aspect_ratio || settings.ratio || '9:16';
            const targetAr = String(arVal).trim();

            // HARDCODED: count/multiplier is ALWAYS x1 as requested by user
            const targetCountText = 'x1';

            const rawModelStr = String(settings.model || 'Omni 1.1 Flash').trim();

            const normalizeModel = (m, isVid) => {
                const l = m.toLowerCase();
                if (!isVid) {
                    if (l.includes('banana 2') || l.includes('nano 2') || l.includes('banana')) return 'Nano Banana 2';
                    if (l.includes('imagen')) return 'Imagen 3';
                } else {
                    if (l.includes('omni') || l.includes('flash') || l.includes('1.1')) return 'Omni 1.1 Flash';
                    if (l.includes('veo 3.1 - lite') || l.includes('lite')) return 'Veo 3.1 - Lite';
                    if (l.includes('veo 3.1 - fast') || l.includes('fast')) return 'Veo 3.1 - Fast';
                    if (l.includes('veo 3.1 - quality') || l.includes('quality')) return 'Veo 3.1 - Quality';
                }
                return m;
            };
            const targetModelName = normalizeModel(rawModelStr, isVideoJob);

            // 4a. Isolate section container & click Aspect Ratio pill (9:16) via physical mouse click
            const arCoords = await page.evaluate(({ isVid, targetAr }) => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const targetTitle = isVid ? 'video generation default' : 'image generation default';
                const allMatching = Array.from(document.querySelectorAll('*')).filter(el => {
                    if (!isVisible(el)) return false;
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    return txt === targetTitle;
                });
                const headingEl = allMatching.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
                
                let container = headingEl ? headingEl.parentElement : document.body;
                while (container && container !== document.body) {
                    const btns = container.querySelectorAll('button');
                    if (btns.length >= 2 && container.clientHeight < window.innerHeight * 0.8) break;
                    container = container.parentElement;
                }
                if (!container) container = document.body;

                container.scrollIntoView({ block: 'center' });

                const pills = Array.from(container.querySelectorAll('button')).filter(p => isVisible(p));
                const arPill = pills.find(p => {
                    const txt = (p.innerText || p.textContent || '').trim();
                    return txt === targetAr || txt.endsWith(targetAr) || txt.includes(targetAr);
                });

                if (arPill) {
                    if (window.__highlight) window.__highlight(arPill);
                    const r = arPill.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            }, { isVid: isVideoJob, targetAr });

            if (arCoords && arCoords.cx > 0 && arCoords.cy > 0) {
                console.log(`      🖱️ Mouse clicking Aspect Ratio "${targetAr}" at [${arCoords.cx}, ${arCoords.cy}]...`);
                try { await page.mouse.click(arCoords.cx, arCoords.cy); } catch {}
                console.log(`      ✅ Selected Aspect Ratio "${targetAr}" in ${isVideoJob ? 'Video' : 'Image'} generation default`);
            } else {
                console.warn(`      ⚠️ Could not locate Aspect Ratio pill "${targetAr}" in section`);
            }
            await page.waitForTimeout(1000);

            // 4b. Count Selection (Hardcoded x1) via physical mouse click
            const countCoords = await page.evaluate(({ isVid, targetCountText }) => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const targetTitle = isVid ? 'video generation default' : 'image generation default';
                const allMatching = Array.from(document.querySelectorAll('*')).filter(el => {
                    if (!isVisible(el)) return false;
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    return txt === targetTitle;
                });
                const headingEl = allMatching.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
                let container = headingEl ? headingEl.parentElement : document.body;
                while (container && container !== document.body) {
                    const btns = container.querySelectorAll('button');
                    if (btns.length >= 2 && container.clientHeight < window.innerHeight * 0.8) break;
                    container = container.parentElement;
                }
                if (!container) container = document.body;

                const countTab = Array.from(container.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                    return txt === targetCountText;
                });
                if (countTab) {
                    if (window.__highlight) window.__highlight(countTab);
                    const r = countTab.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            }, { isVid: isVideoJob, targetCountText });

            if (countCoords && countCoords.cx > 0 && countCoords.cy > 0) {
                console.log(`      🖱️ Mouse clicking Count "${targetCountText}" at [${countCoords.cx}, ${countCoords.cy}]...`);
                try { await page.mouse.click(countCoords.cx, countCoords.cy); } catch {}
                console.log(`      ✅ Selected Count "${targetCountText}" (hardcoded) in ${isVideoJob ? 'Video' : 'Image'} generation default`);
            } else {
                console.warn(`      ⚠️ Could not locate Count button "${targetCountText}" in section`);
            }
            await page.waitForTimeout(1000);

            // 4c. Model Dropdown Selection via physical mouse click
            const dropdownState = await page.evaluate(({ isVid, targetModelName }) => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const targetTitle = isVid ? 'video generation default' : 'image generation default';
                const allMatching = Array.from(document.querySelectorAll('*')).filter(el => {
                    if (!isVisible(el)) return false;
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    return txt === targetTitle;
                });
                const headingEl = allMatching.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
                let container = headingEl ? headingEl.parentElement : document.body;
                while (container && container !== document.body) {
                    const btns = container.querySelectorAll('button');
                    if (btns.length >= 2 && container.clientHeight < window.innerHeight * 0.8) break;
                    container = container.parentElement;
                }
                if (!container) container = document.body;

                const dropdownBtn = Array.from(container.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || b.textContent || '').trim();
                    const hasIcon = Array.from(b.querySelectorAll('*')).some(el => (el.textContent || '').trim() === 'arrow_drop_down');
                    return hasIcon || txt.includes('Omni') || txt.includes('Banana') || txt.includes('Veo');
                });

                if (dropdownBtn) {
                    const btnText = (dropdownBtn.innerText || dropdownBtn.textContent || '').trim();
                    const btnTextLower = btnText.toLowerCase();
                    const targetLower = targetModelName.toLowerCase();
                    const isAlreadySelected = btnTextLower.includes(targetLower) ||
                        (targetLower.includes('omni') && (btnTextLower.includes('omni') || btnTextLower.includes('flash'))) ||
                        (targetLower.includes('banana') && btnTextLower.includes('banana'));

                    if (window.__highlight) window.__highlight(dropdownBtn);
                    const r = dropdownBtn.getBoundingClientRect();
                    return {
                        cx: Math.round(r.left + r.width / 2),
                        cy: Math.round(r.top + r.height / 2),
                        currentText: btnText,
                        isAlreadySelected,
                    };
                }
                return null;
            }, { isVid: isVideoJob, targetModelName });

            if (dropdownState && dropdownState.cx > 0 && dropdownState.cy > 0) {
                if (dropdownState.isAlreadySelected) {
                    console.log(`      ✅ Model is already set to "${dropdownState.currentText}" (matches target "${targetModelName}")`);
                } else {
                    console.log(`      🖱️ Mouse clicking Model dropdown (current: "${dropdownState.currentText}") at [${dropdownState.cx}, ${dropdownState.cy}]...`);
                    try { await page.mouse.click(dropdownState.cx, dropdownState.cy); } catch {}
                    await page.waitForTimeout(1200);

                    const optionCoords = await page.evaluate((modelName) => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const searchLower = modelName.toLowerCase();
                        const options = Array.from(document.querySelectorAll('button[role="menuitem"], [role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], [data-radix-collection-item], button, div, li, span'))
                            .filter(el => isVisible(el) && (el.innerText || el.textContent || '').trim().length > 0 && (el.innerText || el.textContent || '').trim().length < 60);

                        // 1. Exact match
                        let match = options.find(el => {
                            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                            return txt === searchLower;
                        });

                        // 2. Contains full target name
                        if (!match) {
                            match = options.find(el => {
                                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                return txt.includes(searchLower);
                            });
                        }

                        // 3. Match Omni / Flash / 1.1 variations
                        if (!match && (searchLower.includes('omni') || searchLower.includes('flash'))) {
                            match = options.find(el => {
                                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                return txt.includes('omni') && txt.includes('flash');
                            }) || options.find(el => {
                                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                return txt.includes('omni');
                            });
                        }

                        // 4. Match Nano Banana / Imagen
                        if (!match && (searchLower.includes('banana') || searchLower.includes('nano'))) {
                            match = options.find(el => {
                                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                return txt.includes('banana') || txt.includes('nano');
                            });
                        }

                        // 5. Match Veo
                        if (!match && searchLower.includes('veo')) {
                            match = options.find(el => {
                                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                return txt.includes('veo');
                            });
                        }

                        if (match) {
                            const clickTarget = match.closest('button, [role="menuitem"], [role="option"], [data-radix-collection-item]') || match;
                            if (window.__highlight) window.__highlight(clickTarget);
                            const r = clickTarget.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }
                        return null;
                    }, targetModelName);

                    if (optionCoords && optionCoords.cx > 0 && optionCoords.cy > 0) {
                        console.log(`      🖱️ Mouse clicking Model option "${targetModelName}" at [${optionCoords.cx}, ${optionCoords.cy}]...`);
                        try { await page.mouse.click(optionCoords.cx, optionCoords.cy); } catch {}
                        console.log(`      ✅ Selected Model "${targetModelName}" for ${isVideoJob ? 'Video' : 'Image'} generation default`);
                    } else {
                        console.warn(`      ⚠️ Model option "${targetModelName}" not found in dropdown menu — keeping default "${dropdownState.currentText}"`);
                    }
                }
            } else {
                console.warn(`      ⚠️ Could not locate Model dropdown in ${isVideoJob ? 'Video' : 'Image'} generation default`);
            }
            await page.waitForTimeout(1000);

            // 4d. Duration Pill Selection — SKIPPED.
            // Duration is embedded directly in the prompt text (e.g. "Duration: 8 seconds")
            // by the prompt builder and dynamically assigned per scene (6s / 8s / 10s)
            // based on the scene's voiceover word count. No fixed UI pill interaction needed.

            // ── STEP 5: Click Save Button ───────────────────────────────────────
            let saveConfirmed = false;
            for (let saveAttempt = 1; saveAttempt <= 3; saveAttempt++) {
                const saveCoords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const allBtns = Array.from(document.querySelectorAll('button'));
                    let saveBtn = allBtns.find(b => isVisible(b) && (b.className || '').includes('sc-b9afcbbb-16'));
                    if (!saveBtn) saveBtn = allBtns.find(b => isVisible(b) && (b.innerText || b.textContent || '').trim() === 'Save');

                    if (saveBtn) {
                        if (window.__highlight) window.__highlight(saveBtn);
                        saveBtn.click();
                        const r = saveBtn.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                });

                if (saveCoords && saveCoords.cx > 0 && saveCoords.cy > 0) {
                    try { await page.mouse.click(saveCoords.cx, saveCoords.cy); } catch {}
                }
                await page.waitForTimeout(800);

                saveConfirmed = await page.evaluate(() => {
                    const textPresent = (document.body.innerText || '').includes('Agent settings');
                    return !textPresent;
                });

                if (saveConfirmed) {
                    console.log(`      ✅ Save verified — settings panel closed cleanly`);
                    break;
                }
            }

            if (!saveConfirmed) {
                console.warn(`      ⚠️ Settings drawer still open after 3 Save attempts — pressing Escape to close`);
                await page.keyboard.press('Escape');
            }
            await page.waitForTimeout(1500);

        } catch (err) {
            console.warn(`      ⚠️ Apply settings error: ${err.message}`);
        }
    }

    /**
     * Reliably opens the Media/Asset Drawer by clicking the small "+" button
     * inside the bottom-right prompt container (NOT the header + New button).
     * 
     * Based on browser DOM inspection:
     * - "+" button is at bottom of prompt bar (class: sc-e8425ea6-0, text: "add_2 Create")
     * - Located at approx x:1214, y:741 in 1470x776 viewport
     * - Opens a floating panel with sidebar: All, Images, Videos, Voices, Characters, Avatar, Uploads
     */
    async _openMediaPanel(page) {
        console.log(`      📂 Ensuring media drawer is open...`);

        // Check if media drawer is ALREADY open ("Search assets" placeholder visible)
        const isPanelAlreadyOpen = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            return Array.from(document.querySelectorAll('input[placeholder]')).some(i => {
                if (!isVisible(i)) return false;
                return (i.getAttribute('placeholder') || '').toLowerCase().includes('search assets');
            });
        });

        if (isPanelAlreadyOpen) {
            console.log(`      ✅ Media drawer is already open!`);
            return true;
        }

        for (let attempt = 1; attempt <= 5; attempt++) {
            // The Expand button opens the Agent panel on the RIGHT side of the screen.
            // The '+' (add_2/Create) button is in the BOTTOM of that right-side panel.
            // Right panel: x > ~1180px, bottom bar: y > ~700px (in 1470x776 viewport)
            const coords = await safeEvaluate(page, () => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));

                // Primary: find '+'/add_2/Create button in the right-side Agent panel
                // Thresholds relaxed (0.4 / 0.6) for VPS headless Chromium where layout shifts
                let addBtn = allBtns.find(b => {
                    if (!isVisible(b)) return false;
                    const r = b.getBoundingClientRect();
                    // Must be in RIGHT portion of screen (Agent panel) AND bottom area (panel bottom bar)
                    if (r.left < window.innerWidth * 0.4) return false;
                    if (r.top < window.innerHeight * 0.65) return false;
                    const txt = (b.innerText || b.textContent || '').trim();
                    return txt.includes('add_2') || txt === '+' || txt.includes('Create');
                });

                // Fallback 1: any '+' button in the right-side panel (relaxed y position)
                if (!addBtn) {
                    addBtn = allBtns.find(b => {
                        if (!isVisible(b)) return false;
                        const r = b.getBoundingClientRect();
                        if (r.left < window.innerWidth * 0.4) return false;
                        if (r.top < window.innerHeight * 0.55) return false;
                        const cls = (b.className || '');
                        return cls.includes('sc-e8425ea6-0') || (b.textContent || '').trim() === '+';
                    });
                }

                // Fallback 2: find by traversing from the right-side textarea
                if (!addBtn) {
                    const rightTextbox = Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]'))
                        .find(el => {
                            if (!isVisible(el)) return false;
                            const r = el.getBoundingClientRect();
                            return r.left > window.innerWidth * 0.6;
                        });
                    if (rightTextbox) {
                        let parent = rightTextbox.parentElement;
                        for (let i = 0; i < 10 && parent; i++) {
                            const btns = Array.from(parent.querySelectorAll('button')).filter(b => {
                                if (!isVisible(b)) return false;
                                const r = b.getBoundingClientRect();
                                return r.left > window.innerWidth * 0.6 && r.top > window.innerHeight * 0.7;
                            });
                            if (btns.length >= 1) { addBtn = btns[0]; break; }
                            parent = parent.parentElement;
                        }
                    }
                }

                if (addBtn) {
                    const r = addBtn.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            });

            if (coords) {
                console.log(`      🖱️ Clicked "+" button at [${coords.cx}, ${coords.cy}] (attempt ${attempt}/5)...`);
                try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                await page.waitForTimeout(2000);

                const panelOpen = await safeEvaluate(page, () => {
                    return Array.from(document.querySelectorAll('input[placeholder]')).some(i =>
                        i.offsetWidth > 0 && (i.getAttribute('placeholder') || '').toLowerCase().includes('search assets')
                    );
                });

                if (panelOpen) {
                    console.log(`      ✅ Media drawer opened successfully!`);
                    return true;
                }
            } else {
                console.warn(`      ⚠️ "+" button not found in attempt ${attempt}/5`);
            }
            await page.waitForTimeout(1000);
        }


        console.warn('[GoogleFX] ⚠️ Could not open media drawer via "+" button.');
        return false;
    }

    /**
     * Downloads reference media (image, video, or audio) from the given URL to a temp file,
     * detecting its Content-Type header and file extension, then uploads it to
     * Google Flow via the "+ Create → Upload media" native file-chooser flow.
     */
    async _uploadMediaFromUrl(page, mediaUrl, itemId = null) {
        const downloadDir = path.join(process.cwd(), 'downloads');
        if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

        // ── Step 1: Download media from URL & inspect headers / type ──────────
        // Helper: detect mediaType + ext from contentType and URL path
        const detectTypeAndExt = (contentType, targetUrl) => {
            const urlObj = new URL(targetUrl);
            const decodedPath = decodeURIComponent(urlObj.pathname);
            const extMatch = decodedPath.match(/\.(mp4|mov|webm|avi|mkv|m4v|jpg|jpeg|png|webp|gif|bmp|mp3|wav|ogg|aac|flac|m4a)$/i);
            let ext = '';
            let mediaType = 'unknown';
            const ct = (contentType || '').toLowerCase();

            if (ct.startsWith('video/')) {
                mediaType = 'video';
                ext = extMatch ? extMatch[1].toLowerCase() : (ct.includes('webm') ? 'webm' : 'mp4');
            } else if (ct.startsWith('image/')) {
                mediaType = 'image';
                ext = extMatch ? extMatch[1].toLowerCase() : (ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg');
            } else if (ct.startsWith('audio/')) {
                mediaType = 'audio';
                ext = extMatch ? extMatch[1].toLowerCase() : (ct.includes('wav') ? 'wav' : 'mp3');
            } else if (extMatch) {
                ext = extMatch[1].toLowerCase();
                if (['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'].includes(ext)) mediaType = 'video';
                else if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) mediaType = 'image';
                else if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) mediaType = 'audio';
            } else {
                mediaType = 'image';
                ext = 'jpg';
            }
            return { mediaType, ext };
        };

        const fetchAndDetectMedia = async (targetUrl) => {
            // NOTE: browser page.evaluate fetch() is intentionally SKIPPED.
            // labs.google blocks CORS on external URLs — always throws "Failed to fetch".
            // Playwright API context and Node.js http are CORS-free and more reliable.

            // Tier 1: Playwright API context (Chromium network engine, no CORS restriction)
            try {
                console.log(`      🌐 Fetching media via Playwright API context...`);
                const response = await page.request.get(targetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    },
                    timeout: 45000,
                });

                if (response.ok()) {
                    const headers = response.headers();
                    const contentType = (headers['content-type'] || '').toLowerCase();
                    const { mediaType, ext } = detectTypeAndExt(contentType, targetUrl);
                    const tmpFilename = `upload_ref_${Date.now()}.${ext}`;
                    const tmpPath = path.join(downloadDir, tmpFilename);
                    const buffer = await response.body();
                    writeFileSync(tmpPath, buffer);
                    console.log(`      ✅ Downloaded via Playwright context [${mediaType.toUpperCase()}, .${ext}]`);
                    return { tmpPath, mediaType, ext, contentType };
                }
            } catch (err) {
                console.warn(`      ⚠️ Playwright page.request download failed (${err.message}), trying Node.js fallback...`);
            }

            // Tier 2: Node.js http/https fallback with standard Chrome headers
            return new Promise((resolve, reject) => {
                const downloadWithNode = (currentUrl, redirectDepth = 0) => {
                    if (redirectDepth > 5) return reject(new Error('Too many redirects downloading media'));
                    const urlObj = new URL(currentUrl);
                    const proto = currentUrl.startsWith('https') ? https : http;

                    const options = {
                        hostname: urlObj.hostname,
                        port: urlObj.port || (currentUrl.startsWith('https') ? 443 : 80),
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        },
                    };

                    const req = proto.request(options, (res) => {
                        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                            const redirectUrl = new URL(res.headers.location, currentUrl).toString();
                            return downloadWithNode(redirectUrl, redirectDepth + 1);
                        }

                        if (res.statusCode !== 200) {
                            return reject(new Error(`Failed to download media URL, HTTP ${res.statusCode}`));
                        }

                        const contentType = (res.headers['content-type'] || '').toLowerCase();
                        const { mediaType, ext } = detectTypeAndExt(contentType, currentUrl);
                        const tmpFilename = `upload_ref_${Date.now()}.${ext}`;
                        const tmpPath = path.join(downloadDir, tmpFilename);
                        console.log(`      ✅ Downloaded via Node.js http [${mediaType.toUpperCase()}, .${ext}]`);
                        const fileStream = createWriteStream(tmpPath);

                        res.pipe(fileStream);
                        fileStream.on('finish', () => { fileStream.close(); resolve({ tmpPath, mediaType, ext, contentType }); });
                        fileStream.on('error', reject);
                    });

                    req.on('error', reject);
                    req.end();
                };

                downloadWithNode(targetUrl);
            });
        };

        const mediaInfo = await fetchAndDetectMedia(mediaUrl);
        const { tmpPath, mediaType, ext, contentType } = mediaInfo;

        console.log(`      ⬇️ Downloaded reference ${mediaType.toUpperCase()} [MIME: ${contentType || 'n/a'}, Ext: .${ext}]: ${mediaUrl}`);
        console.log(`      ✅ Media saved to temp file: ${tmpPath}`);

        // ── Step 2: Open Media Drawer via "+ Create" button ──────
        console.log(`      📂 Opening media panel via _openMediaPanel helper...`);
        const panelOpened = await this._openMediaPanel(page);
        if (!panelOpened) {
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Could not open media panel to upload file.`);
        }

        await page.waitForTimeout(1000);

        // ── Step 3: Click "Upload media" button via filechooser event ─────────
        console.log(`      📤 Triggering Upload media file chooser...`);
        let uploaded = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // Find the Upload media button
                const uploadBtnCoords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const allBtns = Array.from(document.querySelectorAll('button'));
                    const uploadBtn = allBtns.find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').toLowerCase();
                        const icons = Array.from(b.querySelectorAll('i, [class*="google-symbols"]'));
                        const hasUploadIcon = icons.some(i => (i.textContent || '').trim() === 'upload');
                        return hasUploadIcon || txt.includes('upload media') || txt === 'upload';
                    });
                    if (uploadBtn) {
                        if (window.__highlight) window.__highlight(uploadBtn);
                        uploadBtn.scrollIntoView({ block: 'center' });
                        const r = uploadBtn.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                });

                if (!uploadBtnCoords) {
                    console.warn(`      ⚠️ Upload media button not found (attempt ${attempt}/3)`);
                    await page.waitForTimeout(1000);
                    continue;
                }

                console.log(`      🖱️ Clicking Upload media at [${uploadBtnCoords.cx}, ${uploadBtnCoords.cy}] (attempt ${attempt})...`);

                // Wait for file chooser and click simultaneously
                const [fileChooser] = await Promise.all([
                    page.waitForEvent('filechooser', { timeout: 8000 }),
                    page.mouse.click(uploadBtnCoords.cx, uploadBtnCoords.cy),
                ]);

                console.log(`      📁 File chooser opened — setting file: ${tmpPath}`);
                await fileChooser.setFiles(tmpPath);
                console.log(`      ✅ File set in chooser successfully!`);

                // ── Step 1: Handle "Rights to use this video" dialog ─────────────────
                console.log(`      🔍 Checking for "Rights to use this video" dialog...`);
                await page.waitForTimeout(1500);
                const rightsDialogHandled = await page.evaluate(() => {
                    const bodyText = (document.body && document.body.innerText) || '';
                    const hasRightsDialog = bodyText.includes('Rights to use this video') ||
                                           bodyText.includes('rights to use') ||
                                           bodyText.includes('responsible video');

                    if (!hasRightsDialog) return { found: false };

                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const allBtns = Array.from(document.querySelectorAll('button'));

                    const confirmBtn = allBtns.find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                        if (txt === 'i understand' || txt === 'i agree' || txt === 'got it' ||
                            txt === 'continue' || txt === 'ok' || txt === 'accept' ||
                            txt === 'confirm' || txt === 'agree') return true;
                        if (txt === 'close' || txt === 'cancel') return false;
                        return false;
                    });

                    if (confirmBtn) {
                        confirmBtn.scrollIntoView({ block: 'center' });
                        confirmBtn.click();
                        return { found: true, clicked: (confirmBtn.innerText || confirmBtn.textContent || '').trim() };
                    }

                    const dialogContainers = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"]');
                    for (const container of dialogContainers) {
                        if (!(container.innerText || '').includes('Rights to use')) continue;
                        const btns = Array.from(container.querySelectorAll('button')).filter(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return txt !== 'close' && txt !== 'cancel' && txt !== '✕' && txt !== 'x';
                        });
                        if (btns.length > 0) {
                            const r = btns[0].getBoundingClientRect();
                            return {
                                found: true, needsMouse: true,
                                cx: Math.round(r.left + r.width / 2),
                                cy: Math.round(r.top + r.height / 2),
                                text: (btns[0].innerText || btns[0].textContent || '').trim()
                            };
                        }
                    }
                    return { found: true, clicked: null, noBtn: true };
                });

                if (rightsDialogHandled.found) {
                    if (rightsDialogHandled.needsMouse) {
                        console.log(`      ⚠️ Rights dialog: clicking via mouse [${rightsDialogHandled.cx}, ${rightsDialogHandled.cy}] — "${rightsDialogHandled.text}"`);
                        await page.mouse.click(rightsDialogHandled.cx, rightsDialogHandled.cy);
                    } else if (rightsDialogHandled.clicked) {
                        console.log(`      ✅ Rights dialog handled — clicked: "${rightsDialogHandled.clicked}"`);
                    } else {
                        console.warn(`      ⚠️ Rights dialog found but no confirm button — pressing Escape`);
                        await page.keyboard.press('Escape');
                    }
                    await page.waitForTimeout(1000);
                } else {
                    console.log(`      ℹ️ No "Rights to use this video" dialog`);
                }

                // ── Step 2: Handle "Trim to upload" dialog ───────────────────────────
                console.log(`      🔍 Checking for "Trim to upload" dialog...`);
                await page.waitForTimeout(2000);
                const trimDialogHandled = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const allBtns = Array.from(document.querySelectorAll('button'));

                    const trimBtn = allBtns.find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                        return txt === 'trim & upload' || txt.includes('trim & upload') || txt.includes('trim and upload');
                    });

                    if (trimBtn) {
                        trimBtn.scrollIntoView({ block: 'center' });
                        trimBtn.click();
                        return { found: true, text: (trimBtn.innerText || trimBtn.textContent || '').trim() };
                    }

                    const hasTrimDialog = (document.body.innerText || '').includes('Trim to upload');
                    return { found: false, hasTrimDialog };
                });

                if (trimDialogHandled.found) {
                    console.log(`      ✅ "Trim & upload" clicked — "${trimDialogHandled.text}"`);
                    await page.waitForTimeout(2000);
                } else if (trimDialogHandled.hasTrimDialog) {
                    console.log(`      ⚠️ Trim dialog found but button not clicked via DOM — trying mouse...`);
                    const trimBtnCoords = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const btn = Array.from(document.querySelectorAll('button')).find(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return txt.includes('trim') && !txt.includes('close');
                        });
                        if (btn) {
                            const r = btn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }
                        return null;
                    });
                    if (trimBtnCoords) {
                        await page.mouse.click(trimBtnCoords.cx, trimBtnCoords.cy);
                        console.log(`      ✅ "Trim & upload" clicked via mouse at [${trimBtnCoords.cx}, ${trimBtnCoords.cy}]`);
                        await page.waitForTimeout(2000);
                    }
                } else {
                    console.log(`      ℹ️ No "Trim to upload" dialog — image file or dialog skipped`);
                }

                // ── Real-Time UI Upload & Processing Progress Tracking ─────────
                // PHASE 1: Monitors background video/image upload until 100% / loaders clear.
                console.log(`      ⏳ Real-Time UI Tracking: Monitoring background upload...`);
                let uploadCompletedInUI = false;
                let uploadDoneInBackground = false;
                const uploadStartTime = Date.now();
                let lastActivityTime = Date.now();
                let lastProgressPct = -1;
                let uploadStarted = false;
                let sawProgress = false;

                // Wait up to 20s for upload indicator to start in UI
                for (let waitStart = 0; waitStart < 13 && !uploadStarted; waitStart++) {
                    const hasStarted = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const bodyText = document.body ? document.body.innerText || '' : '';

                        if (/\d{1,3}\s*%/.test(bodyText)) return true;

                        const loader = document.querySelector('[role="progressbar"], progress, [class*="progress"], [class*="spinner"], svg[class*="loading"], [class*="loader"], [class*="overlay"]');
                        if (loader && isVisible(loader)) return true;

                        return bodyText.includes('Uploading') || bodyText.includes('uploading') || bodyText.includes('Processing') || bodyText.includes('processing') || bodyText.includes('Transcoding');
                    });

                    if (hasStarted) {
                        uploadStarted = true;
                        sawProgress = true;
                        console.log(`      ✅ Upload activity detected in UI (${waitStart * 1.5}s elapsed)`);
                        break;
                    }
                    await page.waitForTimeout(1500);
                }

                const maxStaleMs = 300000; // 5 minutes max
                let pollCount = 0;
                let staleLoaderSec = 0; // tracks seconds of loader:YES with no percentage (headless false positive)
                while (Date.now() - lastActivityTime < maxStaleMs) {
                    const elapsedSec = Math.round((Date.now() - uploadStartTime) / 1000);
                    pollCount++;

                    const uiState = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const bodyText = document.body ? document.body.innerText || '' : '';

                        // Percentage progress (e.g., 5%, 50%, 99%)
                        const pctMatches = bodyText.match(/(\d{1,3})\s*%/g);
                        let currentPct = null;
                        if (pctMatches) {
                            for (const m of pctMatches) {
                                const v = parseInt(m.replace('%', '').trim(), 10);
                                if (v >= 0 && v <= 100) { currentPct = v; break; }
                            }
                        }

                        // Active loaders/spinners
                        // NOTE: Do NOT use 'svg circle' — it matches decorative icons and is always present in Google Flow!
                        const hasLoader = Array.from(document.querySelectorAll(
                            '[role="progressbar"], progress, [class*="progress-bar"], [class*="spinner"], mat-progress-bar, mat-spinner'
                        )).some(el => isVisible(el) && el.getBoundingClientRect().width > 5);

                        // Processing status text
                        const isProcessing = bodyText.includes('Uploading') || bodyText.includes('uploading') ||
                            bodyText.includes('Processing') || bodyText.includes('processing') ||
                            bodyText.includes('Transcoding') || bodyText.includes('Saving');

                        // Clear/remove prompt button already present in prompt bar
                        const clearBtn = Array.from(document.querySelectorAll('button')).find(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').toLowerCase();
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            return txt.includes('clear prompt') || aria.includes('clear prompt') || aria.includes('remove asset');
                        });

                        // Also check for media thumbnail in prompt bar
                        const hasThumb = Array.from(document.querySelectorAll('img, video')).some(el => {
                            if (!isVisible(el)) return false;
                            const r = el.getBoundingClientRect();
                            // Small thumbnail area in bottom prompt bar
                            return r.top > window.innerHeight - 150 && r.width > 20 && r.width < 150;
                        });

                        return { currentPct, hasLoader, isProcessing, isAttached: !!clearBtn || hasThumb };
                    });

                    // ── Always log every poll so user sees upload progress ──
                    const pctStr = uiState.currentPct !== null ? `${uiState.currentPct}%` : '--';
                    const loaderStr = uiState.hasLoader ? 'loader:YES' : 'loader:no';
                    const procStr = uiState.isProcessing ? 'processing:YES' : '';
                    const attachStr = uiState.isAttached ? '✅ ATTACHED' : '';
                    console.log(`      📊 Upload [${elapsedSec}s] pct=${pctStr} ${loaderStr} ${procStr} ${attachStr}`.trimEnd());

                    if (uiState.isAttached) {
                        console.log(`      ✅ Media attached to prompt bar! (${elapsedSec}s)`);
                        uploadCompletedInUI = true;
                        break;
                    }

                    // Track activity & report live progress percentage in console + DB
                    if (uiState.currentPct !== null) {
                        sawProgress = true;
                        if (uiState.currentPct !== lastProgressPct) {
                            lastProgressPct = uiState.currentPct;
                            lastActivityTime = Date.now();
                            staleLoaderSec = 0; // reset stale counter on real progress
                            if (itemId) {
                                try {
                                    const jobsCol = getJobsCollection();
                                    await jobsCol.updateOne({ itemId }, { $set: {
                                        progressPct: uiState.currentPct,
                                        progressStatus: `Uploading reference media (${uiState.currentPct}%)...`,
                                        updatedAt: new Date(),
                                    }});
                                } catch (e) {}
                            }
                        }
                    } else if (uiState.hasLoader || uiState.isProcessing) {
                        sawProgress = true;
                        // NOTE: Do NOT reset lastActivityTime unconditionally here — in headless mode
                        // hasLoader is a false-positive (always true) and would prevent the loop from ever exiting!
                        // Only reset if pct was recently seen (real loader activity).
                        if (elapsedSec <= 10 || uiState.isProcessing) {
                            lastActivityTime = Date.now();
                        }
                        staleLoaderSec += 1.5; // each poll is ~1.5s
                    } else {
                        staleLoaderSec = 0;
                    }

                    // ── STRICT UPLOADING COMPLETION RULES ──
                    // 1. CANNOT BE DONE if percentage is currently active (0% - 99%)
                    // 2. CANNOT BE DONE if loaders or processing text are active
                    // 3. DONE if currentPct === 100
                    // 4. DONE if pct disappeared after sawProgress AND no loader AND elapsedSec >= 8
                    // 5. DONE if loader stuck true for 45+ seconds with no pct (headless false positive)
                    // 6. For long videos where no % text was rendered, MUST wait at least 35s before completing!
                    let isUploadDone = false;

                    if (uiState.currentPct === 100) {
                        isUploadDone = true;
                    } else if (uiState.currentPct === null && !uiState.hasLoader && !uiState.isProcessing) {
                        if (sawProgress && elapsedSec >= 8) {
                            isUploadDone = true;
                        } else if (!sawProgress && elapsedSec >= 35) {
                            isUploadDone = true;
                        }
                    } else if (staleLoaderSec >= 45 && sawProgress && uiState.currentPct === null) {
                        // Headless false positive: loader stuck true with no percentage for 45s
                        // Upload actually completed but the loader indicator never cleared
                        console.log(`      ⚠️ Stale loader detected (${Math.round(staleLoaderSec)}s no progress) — treating upload as completed.`);
                        isUploadDone = true;
                    }

                    if (isUploadDone) {
                        console.log(`      ✅ Background upload completed in UI (${elapsedSec}s elapsed) — now attaching media to prompt...`);
                        uploadDoneInBackground = true;
                        break;
                    }

                    await page.waitForTimeout(1500);
                }

                if (uploadCompletedInUI) {
                    // Already attached — skip Phase 2
                } else if (!uploadDoneInBackground) {
                    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
                    throw new Error(`[GoogleFX] ❌ Media upload timed out or stalled.`);
                } else {
                    // ── PHASE 2: Ensure panel open → Select asset → Click "Add to Prompt" ──
                    console.log(`      📂 Phase 2: Opening media panel and adding asset to prompt...`);

                    let phase2Success = false;
                    for (let poll = 1; poll <= 20 && !phase2Success; poll++) {
                        // 1. Check current panel state using exact dialog & button indicators
                        const panelState = await page.evaluate(() => {
                            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                            // Check for "Add to Prompt" button on screen
                            const addBtn = Array.from(document.querySelectorAll('button')).find(b => {
                                if (!isVisible(b)) return false;
                                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                return txt === 'add to prompt' || txt.includes('add to prompt');
                            });
                            if (addBtn) {
                                const r = addBtn.getBoundingClientRect();
                                return { isOpen: true, hasAddBtn: true, addBtnCx: Math.round(r.left + r.width / 2), addBtnCy: Math.round(r.top + r.height / 2) };
                            }

                            // Check for role="dialog" or popover tabs (Uploads, Images, Videos)
                            const dialog = document.querySelector('[role="dialog"]');
                            const hasDialog = dialog && isVisible(dialog);
                            const hasTabs = Array.from(document.querySelectorAll('button, [role="tab"]')).some(b => {
                                if (!isVisible(b)) return false;
                                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                return txt === 'uploads' || txt === 'images' || txt === 'videos' || txt.includes('upload media');
                            });

                            return { isOpen: hasDialog || hasTabs, hasAddBtn: false, addBtnCx: null, addBtnCy: null };
                        });

                        // 2. If "Add to Prompt" button is ALREADY visible -> CLICK IT IMMEDIATELY!
                        if (panelState.hasAddBtn && panelState.addBtnCx !== null) {
                            console.log(`      🖱️ Clicking "Add to Prompt" button at [${panelState.addBtnCx}, ${panelState.addBtnCy}]...`);
                            try { await page.mouse.click(panelState.addBtnCx, panelState.addBtnCy); } catch {}
                            await page.waitForTimeout(2000);
                            phase2Success = true;
                            uploadCompletedInUI = true;
                            break;
                        }

                        // 3. If panel is NOT open -> click the + button near prompt input ONCE
                        if (!panelState.isOpen) {
                            const plusBtnCoords = await page.evaluate(() => {
                                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                                // Target exact trigger button: aria-haspopup="dialog" or icon text "add_2" / "Create"
                                const plusBtn = Array.from(document.querySelectorAll('button')).find(b => {
                                    if (!isVisible(b)) return false;
                                    const txt = (b.innerText || b.textContent || '').toLowerCase();
                                    const aria = (b.getAttribute('aria-haspopup') || '').toLowerCase();
                                    const r = b.getBoundingClientRect();
                                    return (aria === 'dialog' || txt.includes('add_2') || txt.includes('create')) && r.top > 500 && r.width < 65;
                                });
                                if (plusBtn) {
                                    const r = plusBtn.getBoundingClientRect();
                                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                                }
                                return null;
                            });

                            if (plusBtnCoords) {
                                console.log(`      🖱️ Opening media panel via + button at [${plusBtnCoords.cx}, ${plusBtnCoords.cy}]...`);
                                try { await page.mouse.click(plusBtnCoords.cx, plusBtnCoords.cy); } catch {}
                                await page.waitForTimeout(2000);
                                continue; // poll again now that panel is open
                            }
                        }

                        // 4. Panel is open but "Add to Prompt" not visible -> select an asset card in panel
                        const cardCoords = await page.evaluate(() => {
                            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                            // Target asset option card inside role="dialog" or with role="option"
                            const cards = Array.from(document.querySelectorAll('[role="option"], [role="listitem"], div')).filter(el => {
                                if (!isVisible(el)) return false;
                                const r = el.getBoundingClientRect();
                                if (r.left < 300 || r.left > 1100 || r.top < 50 || r.top > 650) return false;
                                if (r.width < 40 || r.height < 30) return false;
                                const txt = (el.innerText || el.textContent || '').toLowerCase();
                                return txt.includes('upload_ref') || txt.includes('video') || txt.includes('image') || el.getAttribute('role') === 'option';
                            });

                            if (cards.length > 0) {
                                cards.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                                const r = cards[0].getBoundingClientRect();
                                return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                            }
                            return null;
                        });

                        if (cardCoords) {
                            console.log(`      🖱️ Selecting asset option card at [${cardCoords.cx}, ${cardCoords.cy}] in media panel (poll ${poll}/20)...`);
                            try { await page.mouse.click(cardCoords.cx, cardCoords.cy); } catch {}
                            await page.waitForTimeout(1500);

                            // Re-check for "Add to Prompt" button
                            const retryAddBtn = await page.evaluate(() => {
                                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                                const addBtn = Array.from(document.querySelectorAll('button')).find(b => {
                                    if (!isVisible(b)) return false;
                                    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                    return txt === 'add to prompt' || txt.includes('add to prompt');
                                });
                                if (addBtn) {
                                    const r = addBtn.getBoundingClientRect();
                                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                                }
                                return null;
                            });

                            if (retryAddBtn) {
                                console.log(`      🖱️ Clicking "Add to Prompt" button at [${retryAddBtn.cx}, ${retryAddBtn.cy}]...`);
                                try { await page.mouse.click(retryAddBtn.cx, retryAddBtn.cy); } catch {}
                                await page.waitForTimeout(2000);
                                phase2Success = true;
                                uploadCompletedInUI = true;
                                break;
                            }
                        } else {
                            console.log(`      ⏳ Waiting for panel cards to finish processing (poll ${poll}/20)...`);
                            await page.waitForTimeout(1500);
                        }
                    }

                    if (!phase2Success) {
                        console.warn(`      ⚠️ Could not explicitly click Add to Prompt — proceeding to verify attachment`);
                        uploadCompletedInUI = true;
                    }
                }


                if (!uploadCompletedInUI) {
                    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
                    throw new Error(`[GoogleFX] ❌ Media upload in UI did not complete or was interrupted.`);
                }

                uploaded = true;
                break;

            } catch (fcErr) {
                console.warn(`      ⚠️ File chooser attempt ${attempt}/3 failed: ${fcErr.message}`);
                await page.waitForTimeout(1500);
            }
        }

        if (!uploaded) {
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Media upload failed: file chooser was not triggered or file set failed after 3 attempts.`);
        }

        // ── CRITICAL: Verify attachment actually appeared in prompt bar ──────
        console.log(`      🔍 Waiting for media attachment to appear in the prompt bar...`);
        let attachmentVerified = false;
        const MAX_ATTACH_ROUNDS = 5;

        for (let round = 1; round <= MAX_ATTACH_ROUNDS && !attachmentVerified; round++) {
            if (round > 1) {
                const waitSec = round <= 3 ? 1.5 : 2.5;
                console.log(`      🔄 Round ${round}/${MAX_ATTACH_ROUNDS}: Re-trying "Add to Prompt" click (${waitSec}s wait)...`);
                await page.waitForTimeout(waitSec * 1000);
                const retryCoords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const btn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                        return txt === 'add to prompt' || txt.includes('add to prompt');
                    });
                    if (btn) {
                        const r = btn.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                });
                if (retryCoords) {
                    await page.mouse.click(retryCoords.cx, retryCoords.cy);
                    await page.waitForTimeout(1500);
                } else {
                    // No "Add to Prompt" button visible — may already be attached
                    console.log(`      ℹ️ "Add to Prompt" not found in round ${round} — checking if already attached...`);
                }
            }

            for (let i = 0; i < 20 && !attachmentVerified; i++) {
                attachmentVerified = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                    // CHECK 1: A video element with blob/http src is visible anywhere (freshly uploaded media thumbnail)
                    const videos = Array.from(document.querySelectorAll('video'));
                    for (const v of videos) {
                        if (!isVisible(v)) continue;
                        const src = v.getAttribute('src') || (v.querySelector('source') && v.querySelector('source').getAttribute('src')) || '';
                        if (src.startsWith('blob:') || src.startsWith('http')) return true;
                    }

                    // CHECK 2: "Add to Prompt" button is GONE — means media was added and panel closed
                    const addToPromptVisible = Array.from(document.querySelectorAll('button')).some(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                        return txt === 'add to prompt' || txt.includes('add to prompt');
                    });
                    if (!addToPromptVisible) {
                        // Double-check: session panel (right side) exists with some content — means attachment succeeded
                        const rightPanelHasContent = Array.from(document.querySelectorAll('img[src]')).some(img => {
                            if (!isVisible(img)) return false;
                            const r = img.getBoundingClientRect();
                            return r.left > window.innerWidth * 0.55;
                        });
                        const rightInputVisible = Array.from(document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea')).some(el => {
                            if (!isVisible(el)) return false;
                            const r = el.getBoundingClientRect();
                            return r.left > window.innerWidth * 0.5;
                        });
                        if (rightPanelHasContent || rightInputVisible) return true;
                    }

                    // CHECK 3: Look for image/thumbnail chips in the bottom-right area (prompt input zone)
                    const imgs = Array.from(document.querySelectorAll('img[src]')).filter(img => {
                        if (!isVisible(img)) return false;
                        const src = img.getAttribute('src') || '';
                        if (src.startsWith('data:') || src === '') return false;
                        if (src.includes('googleusercontent') || src.includes('lh3.google') || src.includes('gstatic')) return false;
                        const r = img.getBoundingClientRect();
                        return r.left > window.innerWidth * 0.5 && r.top > window.innerHeight * 0.4;
                    });
                    if (imgs.length > 0) return true;

                    // CHECK 4: Submit/Create button is enabled AND "Add to Prompt" is gone → infer attachment succeeded
                    const submitBtn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').trim();
                        return txt.includes('Create') || txt.includes('arrow_forward') || txt === '→';
                    });
                    if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true' && !addToPromptVisible) {
                        return true;
                    }

                    return false;
                });

                if (!attachmentVerified) await page.waitForTimeout(600);
            }

            if (attachmentVerified) {
                console.log(`      ✅ Media attachment confirmed in prompt bar (round ${round}/${MAX_ATTACH_ROUNDS})!`);
                break;
            }
            console.log(`      ⏳ Attachment not yet visible after round ${round}/${MAX_ATTACH_ROUNDS}...`);
        }

        if (!attachmentVerified) {
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Failed to verify media attachment in prompt bar after ${MAX_ATTACH_ROUNDS} rounds. Aborting prompt submission.`);
        }


        // ── Final wait: ensure panel is fully closed and prompt bar is stable ──
        console.log(`      ⏳ Ensuring media panel is fully closed...`);
        const panelCloseStart = Date.now();
        while (Date.now() - panelCloseStart < 15000) {
            const panelStillOpen = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                return Array.from(document.querySelectorAll('button')).some(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                    return txt === 'add to prompt' || txt.includes('add to prompt');
                });
            });
            if (!panelStillOpen) {
                console.log(`      ✅ Media panel fully closed`);
                break;
            }
            await page.waitForTimeout(400);
        }

        await page.waitForTimeout(2000);

        console.log(`      📸 Capturing uploaded media DOM URLs for exclusion list...`);
        const capturedUploadUrls = await page.evaluate(() => {
            const urls = new Set();
            document.querySelectorAll('img[src], video[src], video source[src], [src]').forEach(el => {
                const src = el.getAttribute('src') || '';
                if (!src || src.startsWith('data:')) return;
                if (src.startsWith('blob:') || src.startsWith('http')) urls.add(src);
            });
            return Array.from(urls);
        });
        console.log(`      ✅ Captured ${capturedUploadUrls.length} uploaded media URLs for exclusion`);
        this._lastUploadedMediaUrls = capturedUploadUrls;

        try {
            if (existsSync(tmpPath)) {
                unlinkSync(tmpPath);
                console.log(`      🗑️ Temp upload file deleted: ${tmpPath}`);
            }
        } catch (cleanErr) {}

        return this._lastUploadedMediaUrls || [];
    }

    /**
     * Opens media panel, ensures the avatar card is selected, then clicks "Add to Prompt".
     *
     * UI Flow (verified via browser DOM inspection on 2026-08-11):
     * 1. Click the "+" (add_2 Create) button at bottom-right prompt bar → floating panel opens
     * 2. Panel layout:
     *    - Left sidebar tabs: All | Images | Videos | Voices | Characters | Avatar | Uploads (x: ~710-840)
     *    - Center asset list with [role="option"] cards (x: ~840-1090)
     *    - Right preview area + "Add to Prompt" button at bottom (x: ~1090-1480)
     * 3. When panel opens, the last-used asset (avatar "me") is ALREADY SELECTED
     *    → "Add to Prompt" button is immediately visible in the right preview area
     * 4. DO NOT click the avatar card again — clicking it TOGGLES selection and may close panel
     * 5. If avatar not pre-selected: click "Avatar" sidebar tab → card appears → "Add to Prompt" shows
     * 6. Click "Add to Prompt" → avatar thumbnail appears in prompt bar
     */
    async _addAvatarToPrompt(page, avatarName = 'me') {
        console.log(`\n[Avatar] 👤 Adding Avatar "${avatarName}" to prompt...`);

        // Step 1: Open the Media Drawer
        const panelOpened = await this._openMediaPanel(page);
        if (!panelOpened) {
            throw new Error('[GoogleFX] ❌ Could not open media drawer for Avatar selection.');
        }
        await page.waitForTimeout(1500);

        // Step 2: Check if "Add to Prompt" button is ALREADY visible (avatar pre-selected on panel open)
        // This is the common case — the last-used avatar is auto-selected.
        // We try clicking it directly WITHOUT clicking the card (which would toggle/deselect).
        console.log(`      🎯 Checking if "Add to Prompt" is already visible (pre-selected avatar)...`);

        let addToPromptClicked = false;

        for (let attempt = 1; attempt <= 8; attempt++) {
            const addBtnCoords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                // Find "Add to Prompt" button in the RIGHT preview panel area (x > 50% of viewport)
                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || b.textContent || '').trim();
                    // Use includes() not exact match — button may have icon chars appended
                    return txt.includes('Add to Prompt') || txt.toLowerCase().includes('add to prompt');
                });
                if (btn) {
                    const r = btn.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            });

            if (addBtnCoords) {
                console.log(`      ✅ "Add to Prompt" found at [${addBtnCoords.cx}, ${addBtnCoords.cy}] (attempt ${attempt}/8)`);
                console.log(`      🖱️ Clicking "Add to Prompt"...`);
                try { await page.mouse.click(addBtnCoords.cx, addBtnCoords.cy); } catch {}
                addToPromptClicked = true;
                break;
            }

            // If not found yet:
            if (attempt === 1) {
                // On first miss: click the "Avatar" sidebar tab to ensure avatar card is in view
                console.log(`      ↩️ "Add to Prompt" not visible — clicking "Avatar" sidebar tab...`);
                await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    // Sidebar tab buttons: text "Avatar" (NOT the card), located in the LEFT sidebar (x < 55% of viewport)
                    const avatarTab = Array.from(document.querySelectorAll('button, [role="tab"], [role="option"], li, [role="listitem"]')).find(el => {
                        if (!isVisible(el)) return false;
                        const r = el.getBoundingClientRect();
                        // Must be in left sidebar zone (x < 57% viewport) to avoid clicking the card itself
                        if (r.left > window.innerWidth * 0.57) return false;
                        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                        return txt === 'avatar';
                    });
                    if (avatarTab) avatarTab.click();
                });
                await page.waitForTimeout(1200);
                continue;
            }

            if (attempt === 3) {
                // On third miss: click the avatar CARD in the center panel to select it
                // Only if the card is in the CENTER area (x: 57%-80% of viewport) to avoid clicking sidebar
                console.log(`      📌 Clicking avatar card to select it...`);
                const cardCoords = await page.evaluate((targetName) => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    // The avatar card is in the CENTER of the panel (x: 57%-80% of viewport)
                    // Sidebar tabs end at ~57% viewport width; right preview starts at ~72%
                    let card = Array.from(document.querySelectorAll('[role="option"]')).find(el => {
                        if (!isVisible(el)) return false;
                        const r = el.getBoundingClientRect();
                        // Card must be in center panel zone (NOT sidebar, NOT right preview)
                        if (r.left < window.innerWidth * 0.57) return false;
                        if (r.left > window.innerWidth * 0.80) return false;
                        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                        return txt.includes(targetName.toLowerCase());
                    });
                    // Fallback: any [role="option"] in center zone
                    if (!card) {
                        card = Array.from(document.querySelectorAll('[role="option"]')).find(el => {
                            if (!isVisible(el)) return false;
                            const r = el.getBoundingClientRect();
                            return r.left >= window.innerWidth * 0.57 && r.left <= window.innerWidth * 0.80 && r.top > 50;
                        });
                    }
                    if (card) {
                        const r = card.getBoundingClientRect();
                        return {
                            cx: Math.round(r.left + r.width / 2),
                            cy: Math.round(r.top + r.height / 2),
                            text: (card.innerText || card.textContent || '').trim().substring(0, 40),
                        };
                    }
                    return null;
                }, avatarName);

                if (cardCoords) {
                    console.log(`      🖱️ Clicking avatar card "${cardCoords.text}" at [${cardCoords.cx}, ${cardCoords.cy}]`);
                    try { await page.mouse.click(cardCoords.cx, cardCoords.cy); } catch {}
                    await page.waitForTimeout(1200);
                } else {
                    console.warn(`      ⚠️ Avatar card not found in center panel zone`);
                }
                continue;
            }

            console.warn(`      ⚠️ "Add to Prompt" button not visible yet (attempt ${attempt}/8)...`);
            await page.waitForTimeout(700);
        }

        if (!addToPromptClicked) {
            throw new Error(`[GoogleFX] ❌ Could not click "Add to Prompt" for Avatar "${avatarName}" after 8 attempts.`);
        }

        await page.waitForTimeout(2000);
        console.log(`      ✨ Avatar "${avatarName}" successfully added to prompt bar!`);
    }

    async _logChatReplies(page, context = 'Chat') {
        try {
            const lines = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const panels = Array.from(document.querySelectorAll('[class*="sc-e4f4e472-3"], [class*="cRumFH"], [class*="sc-b9afcbbb"], [class*="sc-5c3af813"]'))
                    .filter(el => isVisible(el) && el.getBoundingClientRect().left > window.innerWidth * 0.4);
                const container = panels[0] || document.body;
                const text = container.innerText || '';
                return text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            });
            if (lines && lines.length > 0) {
                console.log(`\n      💬 AGENT CHAT REPLAY LOGS [${context}]:`);
                console.log(`      ${'─'.repeat(55)}`);
                lines.slice(-25).forEach(l => console.log(`      | ${l}`));
                console.log(`      ${'─'.repeat(55)}\n`);
            }
        } catch (e) {}
    }

    async _submitPrompt(page, prompt) {
        console.log(`      ⌨️ Submitting prompt into input bar (${prompt.length} chars)...`);

        // 1. Find and click the text editor element cleanly
        const editorLocator = page.locator('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]').last();
        try {
            if (await editorLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
                await editorLocator.click();
            } else {
                await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const ed = Array.from(document.querySelectorAll('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]'))
                        .find(el => isVisible(el));
                    if (ed) ed.focus();
                });
            }
        } catch (e) {}

        await page.waitForTimeout(300);

        // 2. Select All and Backspace to clear existing text safely via keyboard
        const isMac = process.platform === 'darwin';
        const modifier = isMac ? 'Meta' : 'Control';
        try {
            await page.keyboard.press(`${modifier}+A`);
            await page.keyboard.press('Backspace');
        } catch (e) {}
        await page.waitForTimeout(200);

        // 3. Type prompt using Playwright CDP trusted input (no execCommand, no innerHTML mutation)
        // CDP keyboard.insertText updates Slate.js / React editor state 100% cleanly without DOM corruption
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(500);

        // Final verification check of typed length
        const currentPromptLength = await page.evaluate(() => {
            const active = document.activeElement;
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const ed = active && isVisible(active) ? active : Array.from(document.querySelectorAll('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]')).find(el => isVisible(el));
            return ed ? (ed.innerText || ed.value || ed.textContent || '').trim().length : 0;
        });

        console.log(`      ✅ Prompt typed successfully into input bar (${currentPromptLength} / ${prompt.length} chars)`);

        // 4. Click Send (arrow_forward) button or press Enter
        const sendCoords = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const allBtns = Array.from(document.querySelectorAll('button'));
            const allTexts = b => Array.from(b.querySelectorAll('*'))
                .map(c => (c.textContent || '').trim())
                .concat([(b.textContent || '').trim()]);

            const isClearBtn = b => allTexts(b).some(t => t === 'close' || t === 'cancel' || t === 'clear');

            let sendBtn = allBtns.find(b => {
                if (!isVisible(b)) return false;
                if (isClearBtn(b)) return false;
                const r = b.getBoundingClientRect();
                if (r.left < window.innerWidth * 0.4) return false;
                if (r.top < window.innerHeight * 0.6) return false;
                return allTexts(b).some(t => t === 'arrow_forward');
            });

            if (!sendBtn) {
                sendBtn = allBtns.find(b => {
                    if (!isVisible(b)) return false;
                    if (isClearBtn(b)) return false;
                    return allTexts(b).some(t => t === 'arrow_forward');
                });
            }

            if (sendBtn) {
                if (window.__highlight) window.__highlight(sendBtn);
                const r = sendBtn.getBoundingClientRect();
                return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
            }
            return null;
        });

        if (sendCoords && sendCoords.cx > 0 && sendCoords.cy > 0) {
            console.log(`      📤 Clicked Send/Create button at [${sendCoords.cx}, ${sendCoords.cy}]`);
            try { await page.mouse.click(sendCoords.cx, sendCoords.cy); } catch {}
        } else {
            console.log(`      📤 Triggering submission via Enter key...`);
            await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(3000);

        // Log chat replay after prompt submission
        await this._logChatReplies(page, 'After Prompt Submit');

        // Capture post-submit snapshot of all media URLs
        const postSubmitUrls = await page.evaluate(() => {
            const urls = new Set();
            document.querySelectorAll('img[src], video[src], video source[src], [src]').forEach(el => {
                const src = el.getAttribute('src') || '';
                if (src && !src.startsWith('data:')) urls.add(src);
            });
            return Array.from(urls);
        });
        console.log(`      📸 Post-submit snapshot: ${postSubmitUrls.length} media URLs captured (uploaded reference video included in exclusions)`);
        return postSubmitUrls;
    }


    async _applyResultFilter(page) {
        // UI filter button step skipped as requested (relying 100% on pre/post-submit URL snapshot exclusions)
        return;
    }


    async _resubmitPromptForRetry(page) {
        // Stop or cancel any stuck UI state if possible
        try {
            await page.evaluate(() => {
                const stopBtns = Array.from(document.querySelectorAll('button')).filter(b => {
                    const text = (b.innerText || b.textContent || '').trim().toLowerCase();
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    return text === 'stop' || text === 'cancel' || aria.includes('stop') || aria.includes('cancel');
                });
                if (stopBtns.length > 0) stopBtns[0].click();
            });
            await page.waitForTimeout(1500);
        } catch (e) {}

        // Ensure session drawer is open before re-adding attachments
        await this._clickExpandButton(page);
        await page.waitForTimeout(800);

        // Check if avatar thumbnail is still in the prompt bar
        const avatarStillAttached = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const promptArea = Array.from(document.querySelectorAll('[role="textbox"], [contenteditable="true"]'))
                .find(el => isVisible(el) && el.getBoundingClientRect().left > window.innerWidth * 0.6);
            if (!promptArea) return false;
            let container = promptArea.parentElement;
            for (let i = 0; i < 8 && container; i++) {
                const imgs = container.querySelectorAll('img');
                if (imgs.length > 0) return true;
                container = container.parentElement;
            }
            return false;
        });

        const retryAvatarName = this._lastAvatarName || '';
        const retryMediaUrl = this._lastMediaUrl || '';

        if (!avatarStillAttached && retryAvatarName) {
            console.log(`      👤 Avatar not in prompt bar — re-adding avatar "${retryAvatarName}"...`);
            try {
                await this._addAvatarToPrompt(page, retryAvatarName);
                await page.waitForTimeout(1000);
            } catch (avatarErr) {
                console.warn(`      ⚠️ Could not re-add avatar: ${avatarErr.message}`);
            }
        } else if (avatarStillAttached) {
            console.log(`      ✅ Avatar still attached in prompt bar — skipping re-add`);
        }

        // RULE: In retry within the same project, do NOT re-upload image repeatedly.
        // The image is already uploaded into this project's library/context.
        if (retryMediaUrl) {
            console.log(`      🖼️ [RETRY RULE] Reference media already uploaded in this project. Skipping image upload step during retry in same project.`);
        }

        await this._clickExpandButton(page);
        await page.waitForTimeout(500);

        const retryPrompt = this._lastPrompt || '';
        if (retryPrompt) {
            await this._submitPrompt(page, retryPrompt);
            await page.waitForTimeout(3000);
            return true;
        }
        return false;
    }


    async _extractResult(page, type, itemId, preExistingUrls = []) {
        const excludedUrlSet = new Set(preExistingUrls);
        const startTime = Date.now();
        let lastActivityTime = Date.now();
        let lastProgressPct = -1;
        let stuckProgressCount = 0;
        const maxStaleMs = 600000; // Allow up to 10 minutes of active generation progress

        console.log(`      ⏳ Real-Time Generation Tracking: Monitoring live DOM percentage, spinners, & new ${type.toUpperCase()} assets...`);

        let resultData = null;
        let pollCount = 0;
        let retryCount = 0;
        let consecutiveMediaFound = 0; // safety net: if video seen N polls in a row, declare done

        // Apply filter ("Generated" ON, "Uploaded" OFF) once so uploaded reference media is hidden in feed
        await this._applyResultFilter(page);

        while (Date.now() - lastActivityTime < maxStaleMs) {
            pollCount++;
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);

            // Scan live DOM for percentages, progress loaders, and newly generated media URLs
            const liveState = await page.evaluate(({ targetType, excludedUrls }) => {
                const excludedSet = new Set(excludedUrls);
                const bodyText = (document.body && document.body.innerText) || '';

                // 1. Percentage tracking (e.g., 15%, 50%, 99%)
                const hasLoaderForPct = Array.from(document.querySelectorAll(
                    '[role="progressbar"], progress, [class*="spinner"], [class*="loading"], [class*="loader"], [class*="progress-bar"], mat-progress-bar, mat-spinner'
                )).some(el => el.offsetWidth > 0 && el.offsetHeight > 0);

                const pctMatches = bodyText.match(/(\d{1,3})\s*%/g);
                let currentPct = null;
                if (pctMatches && pctMatches.length > 0 && hasLoaderForPct) {
                    for (const match of pctMatches) {
                        const val = parseInt(match.replace('%', '').trim(), 10);
                        if (val >= 0 && val <= 100) {
                            currentPct = val;
                            break;
                        }
                    }
                }

                // Check aria-valuenow attributes on progress elements as fallback
                if (currentPct === null) {
                    const progressEls = Array.from(document.querySelectorAll('[role="progressbar"], progress, [aria-valuenow], [style*="width"]'));
                    for (const el of progressEls) {
                        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
                            const val = el.getAttribute('aria-valuenow') || el.getAttribute('value');
                            if (val && !isNaN(parseFloat(val))) {
                                const parsed = Math.round(parseFloat(val));
                                if (parsed >= 0 && parsed <= 100) {
                                    currentPct = parsed;
                                    break;
                                }
                            }
                        }
                    }
                }

                // 2. Active generation loaders / spinners / status text
                // IMPORTANT: Do NOT include 'svg' or 'canvas' here — Google Flow always has SVG icons on screen
                // which causes hasActiveSpinner to always be true even after generation completes!
                const hasActiveSpinner = Array.from(document.querySelectorAll(
                    '[role="progressbar"], progress, [class*="spinner"], [class*="loading"], [class*="loader"], [class*="progress-bar"], mat-progress-bar, mat-spinner'
                )).some(
                    el => el.offsetWidth > 0 && el.offsetHeight > 0
                );

                const isGeneratingText = bodyText.includes('Generating') || bodyText.includes('generating') ||
                                         bodyText.includes('Creating') || bodyText.includes('creating') ||
                                         bodyText.includes('Rendering') || bodyText.includes('processing') ||
                                         bodyText.includes('Thinking') || bodyText.includes('Analyzing');

                let statusText = '';
                const statusMatch = bodyText.match(/(Generating[^\.\n]*|Creating[^\.\n]*|Rendering[^\.\n]*|Thinking[^\.\n]*|Analyzing[^\.\n]*|Processing[^\.\n]*)/i);
                if (statusMatch) {
                    statusText = statusMatch[1].trim();
                }

                // 3. Scan for NEW generated media URLs (excluding uploaded reference media & pre-existing URLs)
                const isProfileOrUi = (src) => {
                    if (!src || src.startsWith('data:')) return true;
                    if (excludedSet.has(src)) return true;
                    // NOTE: Do NOT exclude blob: URLs here — Google Flow serves generated VIDEOS as blob: URLs!
                    // blob: exclusion only applies to the uploaded reference media (handled via excludedSet).

                    const lowerSrc = src.toLowerCase();
                    if (
                        lowerSrc.includes('googleusercontent.com') ||
                        lowerSrc.includes('lh3.google') ||
                        lowerSrc.includes('ggpht.com') ||
                        lowerSrc.includes('profile') ||
                        lowerSrc.includes('favicon') ||
                        lowerSrc.includes('gstatic') ||
                        lowerSrc.includes('google.png') ||
                        lowerSrc.includes('logo')
                    ) return true;

                    return false;
                };

                const newMediaUrls = [];
                let newVideoUrl = null;
                let newImageUrl = null;

                // Scan video elements — blob: srcs are VALID generated video results in Google Flow
                document.querySelectorAll('video').forEach((vid) => {
                    if (!vid.offsetWidth && !vid.offsetHeight) return; // skip hidden
                    const src = vid.getAttribute('src') || vid.currentSrc ||
                        (vid.querySelector('source') && vid.querySelector('source').getAttribute('src')) || '';
                    if (src && !isProfileOrUi(src)) {
                        newMediaUrls.push(src);
                        if (!newVideoUrl) newVideoUrl = src;
                    }
                });

                // Scan image elements (only large ones — not icons/UI)
                document.querySelectorAll('img').forEach((img) => {
                    const src = img.getAttribute('src') || '';
                    if (src && !isProfileOrUi(src)) {
                        const w = img.clientWidth || img.naturalWidth || 0;
                        const h = img.clientHeight || img.naturalHeight || 0;
                        if ((w === 0 || w >= 150) && (h === 0 || h >= 150)) {
                            newMediaUrls.push(src);
                            if (!newImageUrl) newImageUrl = src;
                        }
                    }
                });

                // Detect Google's "Something went wrong" OR "The agent failed" error UI
                const hasTryAgainBtn = !!Array.from(document.querySelectorAll('button')).find(b =>
                    b.offsetWidth > 0 && (b.innerText || b.textContent || '').trim().toLowerCase() === 'try again'
                );
                const isGoogleError = hasTryAgainBtn && (
                    bodyText.includes('Something went wrong') ||
                    bodyText.includes('something went wrong') ||
                    bodyText.includes('The agent failed') ||
                    bodyText.includes('agent failed') ||
                    bodyText.includes('Agent failed')
                );

                // ── KEY DETECTION: flow-video-tile custom element ──
                // Google Flow renders completed generated videos as <flow-video-tile> web components
                // with an <img> thumbnail — there is NO <video> element on the project page.
                // Clicking the tile navigates to /edit/<sceneId> where the actual video plays.
                const newVideoTiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"]')).filter(tile => {
                    if (!tile.offsetWidth && !tile.offsetHeight) return false;
                    const img = tile.querySelector('img[src]');
                    if (!img) return false;
                    const src = img.getAttribute('src') || '';
                    // Must be a real content URL (not excluded/profile)
                    return src && !src.startsWith('data:') && !excludedSet.has(src) &&
                        !src.includes('googleusercontent.com') && !src.includes('gstatic') &&
                        !src.includes('lh3.google');
                });

                // Also detect the session chat panel video result: div[aria-label="Open video in editor"]
                const chatVideoContainers = Array.from(document.querySelectorAll('[aria-label="Open video in editor"], .video-container.clickable')).filter(el => {
                    if (!el.offsetWidth && !el.offsetHeight) return false;
                    const img = el.querySelector('img[src]');
                    if (!img) return false;
                    const src = img.getAttribute('src') || '';
                    return src && !src.startsWith('data:') && !excludedSet.has(src);
                });

                // Collect thumbnail URLs from video tiles as the preview thumbnail
                const videoTileUrl = newVideoTiles.length > 0
                    ? (newVideoTiles[0].querySelector('img[src]')?.getAttribute('src') || null)
                    : (chatVideoContainers.length > 0
                        ? (chatVideoContainers[0].querySelector('img[src]')?.getAttribute('src') || null)
                        : null);

                // Note: Keep newVideoUrl strictly for real <video> sources so video jobs never return thumbnails
                if (videoTileUrl && !newMediaUrls.includes(videoTileUrl)) newMediaUrls.push(videoTileUrl);

                return {
                    currentPct,
                    statusText,
                    hasActiveSpinner,
                    isGeneratingText,
                    mediaUrls: Array.from(new Set(newMediaUrls)),
                    videoUrl: newVideoUrl,      // blob: or http: URL from <video> if mounted
                    imageUrl: newImageUrl || videoTileUrl,      // standalone <img> URL or tile thumbnail
                    thumbnailUrl: videoTileUrl,
                    videoTileCount: newVideoTiles.length + chatVideoContainers.length,  // flow-video-tile count
                    text: bodyText.substring(0, 3000),
                    isCancelled: bodyText.includes('Response was cancelled') || bodyText.includes('response was cancelled'),
                    isGoogleError,
                    hasTryAgainBtn,
                };
            }, { targetType: type, excludedUrls: Array.from(excludedUrlSet) });

            // ── GOOGLE ERROR CHECK: "Something went wrong" / "The agent failed" / "Rendering failure" ──
            // Only trigger on VISIBLE "Try again" button — NOT on chat text containing those words
            if ((liveState.isGoogleError || liveState.isRenderingFailure) && liveState.hasTryAgainBtn) {
                const errLabel = liveState.isRenderingFailure ? '"Rendering failure"' : '"Agent failed / Something went wrong"';
                console.warn(`      ⚠️ ${errLabel} detected in Google Flow UI — immediate retry triggered!`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 3) {
                    throw new Error(`[GoogleFX] ❌ ${errLabel} error repeated 3 times — aborting.`);
                }
                console.log(`      🔄 Google error retry ${retryCount}/3 — restoring state and re-submitting...`);

                // Auto-click the "Try again" button to reset the error state
                await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b =>
                        b.offsetWidth > 0 && (b.innerText || b.textContent || '').trim().toLowerCase() === 'try again'
                    );
                    if (btn) btn.click();
                });
                console.log(`      🖱️ Clicked "Try again" button.`);
                await page.waitForTimeout(3000);

                stuckProgressCount = 0;
                lastProgressPct = -1;
                const resubmitted = await this._resubmitPromptForRetry(page);
                if (resubmitted) {
                    lastActivityTime = Date.now();
                    continue;
                }
            }

            // ── CANCELLATION CHECK: if Google cancelled the response, retry the prompt ──
            if (liveState.isCancelled) {
                console.warn(`      ⚠️ "Response was cancelled." detected — retrying prompt submission...`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 3) {
                    throw new Error('[GoogleFX] ❌ Prompt was cancelled 3 times — aborting.');
                }
                console.log(`      🔄 Retry attempt ${retryCount}/3 — re-submitting prompt...`);
                await page.waitForTimeout(2000);
                stuckProgressCount = 0;
                lastProgressPct = -1;
                const resubmitted = await this._resubmitPromptForRetry(page);
                if (resubmitted) {
                    lastActivityTime = Date.now();
                    continue;
                }
            }

            // ── LIVE PERCENTAGE LOGGING & DATABASE UPDATE ──
            // Calculate effective progress percentage (DOM exact % or smooth time-based estimate)
            let effectivePct = liveState.currentPct;

            // If DOM doesn't show numeric % but generation is in progress (spinner / status text active):
            if (effectivePct === null && (liveState.hasActiveSpinner || liveState.isGeneratingText)) {
                // Smooth time-based percentage progression during active generation:
                // Starts at 10% after submit, smoothly advances up to 95% over ~60s
                const estimatedPct = Math.min(95, Math.floor(10 + (elapsedSec / 60) * 75));
                effectivePct = estimatedPct;
            }

            if (effectivePct !== null) {
                // Guard: skip false-positive 100% if active spinner is still running
                if (!(effectivePct === 100 && liveState.hasActiveSpinner)) {
                    if (effectivePct !== lastProgressPct || pollCount % 2 === 0) {
                        console.log(`      🎬 Live UI Generation Progress: ${effectivePct}% ${liveState.statusText ? `(${liveState.statusText})` : ''} (${elapsedSec}s)`);

                        if (itemId) {
                            try {
                                const jobsCol = getJobsCollection();
                                await jobsCol.updateOne(
                                    { itemId },
                                    {
                                        $set: {
                                            progressPct: effectivePct,
                                            progressStatus: liveState.statusText ? `Generating: ${liveState.statusText} (${effectivePct}%)` : `Generating video (${effectivePct}%)...`,
                                            updatedAt: new Date(),
                                        }
                                    }
                                );
                            } catch (e) {}
                        }
                    }

                    // ── Increment stuck counter on every poll tick if progress >= 90% and not completed ──
                    if (effectivePct >= 95 || (effectivePct === lastProgressPct && effectivePct >= 90)) {
                        stuckProgressCount++;
                        console.log(`      ⏳ Generation holding at ${effectivePct}% [stuck check ${stuckProgressCount}/10] (${elapsedSec}s)`);
                    } else {
                        stuckProgressCount = 0;
                    }

                    lastProgressPct = effectivePct;
                    lastActivityTime = Date.now();
                }
            } else {
                if (elapsedSec > 30) {
                    stuckProgressCount++;
                }
            }

            // ── STUCK AT 95% PROGRESS CHECK: if stuck count >= 10, mark as failed & retry prompt ──
            if (stuckProgressCount >= 10) {
                console.warn(`      ⚠️ Generation progress stuck at ${effectivePct || 95}% ${liveState.statusText ? `(${liveState.statusText})` : ''} for 10 checks (~50s) — generation stalled/failed. Triggering instant retry...`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 3) {
                    throw new Error(`[GoogleFX] ❌ Generation stuck at ${effectivePct || 95}% repeated 3 times — aborting.`);
                }
                console.log(`      🔄 Stuck generation retry ${retryCount}/3 — resetting and re-submitting prompt...`);
                stuckProgressCount = 0;
                lastProgressPct = -1;

                if (itemId) {
                    try {
                        const jobsCol = getJobsCollection();
                        await jobsCol.updateOne(
                            { itemId },
                            {
                                $set: {
                                    progressStatus: `Generation stalled at ${effectivePct || 95}%. Retrying attempt ${retryCount}/3...`,
                                    updatedAt: new Date(),
                                }
                            }
                        );
                    } catch (e) {}
                }

                const resubmitted = await this._resubmitPromptForRetry(page);
                if (resubmitted) {
                    lastActivityTime = Date.now();
                    continue;
                }
            }

            // CRITICAL GATE: COMPLETED when a new generated asset appears
            const isVideoType = type === 'video' || type === 'avatar_video';
            // For VIDEO type: Google Flow shows ONLY <flow-video-tile> (with img thumbnail) — no <video> element.
            // So targetAsset = videoUrl (which now includes tile thumbnail) OR imageUrl as fallback.
            const targetAsset = liveState.videoUrl || liveState.imageUrl || null;

            // Always update activity time when any new media is found (even if spinner is still visible)
            if (liveState.mediaUrls.length > 0 || liveState.videoTileCount > 0) {
                lastActivityTime = Date.now();
                consecutiveMediaFound++;
            } else {
                consecutiveMediaFound = 0;
            }

            const spinnerGone = !liveState.hasActiveSpinner;
            const hadHighProgress = lastProgressPct >= 90;
            const videoFoundAfterProgress = targetAsset && hadHighProgress;
            // Safety net: if video found 3+ consecutive polls but spinner still detected (false positive)
            const persistentMediaFound = (targetAsset || liveState.videoTileCount > 0) && consecutiveMediaFound >= 3;

            if ((targetAsset || liveState.videoTileCount > 0) && (liveState.mediaUrls.length > 0 || liveState.videoTileCount > 0) && (spinnerGone || videoFoundAfterProgress || persistentMediaFound)) {
                const reason = spinnerGone ? 'spinner gone' : hadHighProgress ? 'progress>=90%' : `seen ${consecutiveMediaFound} polls`;
                const bestUrl = targetAsset || `flow-video-tile detected (${liveState.videoTileCount} tile(s))`;
                console.log(`      ✨ GENERATION COMPLETED! ${liveState.videoTileCount > 0 ? liveState.videoTileCount + ' video tile(s)' : liveState.mediaUrls.length + ' asset(s)'} in ${elapsedSec}s. [${reason}]`);
                console.log(`      🔗 Result URL: ${bestUrl}`);
                resultData = {
                    videoUrl: isVideoType ? (liveState.videoUrl || null) : null,
                    imageUrl: type === 'image' ? (liveState.imageUrl || liveState.thumbnailUrl) : null,
                    thumbnailUrl: liveState.thumbnailUrl || null,
                    mediaUrls: liveState.mediaUrls,
                    videoTileCount: liveState.videoTileCount,
                    text: liveState.text,
                };
                break;
            }

            if (liveState.mediaUrls.length > 0) {
                console.log(`      🎥 Media assets found (${liveState.mediaUrls.length}) — waiting for spinner to clear or ${3 - consecutiveMediaFound} more polls... [poll ${consecutiveMediaFound}/3]`);
            }

            if (page.isClosed()) break;
            await page.waitForTimeout(5000);
        }

        if (!resultData || (!resultData.videoUrl && !resultData.imageUrl && (!resultData.mediaUrls || resultData.mediaUrls.length === 0) && (!resultData.videoTileCount || resultData.videoTileCount === 0))) {
            throw new Error(`[GoogleFX] ❌ Generation failed or timed out — Total Assets was 0 (No new generated video/image URL detected in DOM).`);
        }

        // ─── Fix relative URLs → absolute & Enforce Strict Type Isolation ───
        const BASE = 'https://labs.google';
        const toAbs = (url) => {
            if (!url) return url;
            return url.startsWith('http') ? url : `${BASE}${url.startsWith('/') ? '' : '/'}${url}`;
        };
        if (resultData) {
            if (type === 'image') {
                resultData.videoUrl = null; // Strict isolation: Image job has videoUrl = null
                if (resultData.imageUrl) resultData.imageUrl = toAbs(resultData.imageUrl);
            } else if (type === 'video' || type === 'avatar_video') {
                resultData.imageUrl = null; // Strict isolation: Video/Avatar job has imageUrl = null
                if (resultData.videoUrl) resultData.videoUrl = toAbs(resultData.videoUrl);
            }
            resultData.mediaUrls = (resultData.mediaUrls || []).map(toAbs);
        }

        // ─── Download Generated Asset (Video or Image) ─────────────────────
        try {
            const downloadDir = path.join(process.cwd(), 'downloads');
            if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

            let downloaded = false;
            const isVideoType = type === 'video' || type === 'avatar_video';

            if (isVideoType) {
                console.log(`      🎬 Starting multi-layer video download workflow...`);

                // ─────────────────────────────────────────────────────────────
                // LAYER 1: Hover over video tile to activate playback & extract video blob/src
                // (In Google Flow UI, hovering on the tile starts live video playback)
                // ─────────────────────────────────────────────────────────────
                try {
                    const tileBox = await page.evaluate(({ excludedUrls }) => {
                        const excluded = new Set(excludedUrls || []);
                        const tiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]'))
                            .filter(t => t.offsetWidth > 0 && t.offsetHeight > 0);
                        // Prioritize new video tile whose thumbnail is NOT an excluded uploaded media URL
                        const targetTile = tiles.find(t => {
                            const img = t.querySelector('img[src]');
                            if (!img) return false;
                            const src = img.getAttribute('src') || '';
                            return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                        }) || tiles[tiles.length - 1] || null;

                        if (!targetTile) return null;
                        const r = targetTile.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
                    }, { excludedUrls: Array.from(excludedUrlSet) });

                    if (tileBox) {
                        console.log(`      🖱️ Layer 1: Hovering over video tile at (${Math.round(tileBox.x)}, ${Math.round(tileBox.y)})...`);
                        await page.mouse.move(tileBox.x, tileBox.y);
                        await page.waitForTimeout(1500); // Wait for UI hover state to trigger <video> playback

                        // Check if a <video> element mounted inside the tile
                        const videoData = await page.evaluate(() => {
                            const v = document.querySelector('flow-video-tile video, [class*="video-tile"] video, video');
                            if (!v) return null;
                            const src = v.getAttribute('src') || v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').getAttribute('src')) || '';
                            return {
                                src,
                                isBlob: src.startsWith('blob:'),
                                isHttp: src.startsWith('http'),
                            };
                        });

                        if (videoData && videoData.src) {
                            console.log(`      🎥 Detected mounted <video> on hover: src="${videoData.src.substring(0, 80)}" (blob=${videoData.isBlob})`);

                            if (videoData.isBlob) {
                                console.log(`      ⚡ Extracting video blob data from browser memory...`);
                                const base64Data = await page.evaluate(async (blobUrl) => {
                                    try {
                                        const res = await fetch(blobUrl);
                                        const blob = await res.blob();
                                        return new Promise((resolve, reject) => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => resolve(reader.result);
                                            reader.onerror = reject;
                                            reader.readAsDataURL(blob);
                                        });
                                    } catch (e) {
                                        return null;
                                    }
                                }, videoData.src);

                                if (base64Data && base64Data.startsWith('data:')) {
                                    const base64Str = base64Data.split(',')[1];
                                    const buffer = Buffer.from(base64Str, 'base64');
                                    if (buffer.length > 50000 && isVideoBuffer(buffer)) {
                                        const filename = `flow_video_${Date.now()}.mp4`;
                                        const localPath = path.join(downloadDir, filename);
                                        writeFileSync(localPath, buffer);
                                        const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                        console.log(`      💾 ✅ Video extracted from blob: ${localPath} (${Math.round(buffer.length / 1024)}KB)`);
                                        resultData.downloadPath = localPath;
                                        resultData.downloadUrl = localUrl;
                                        resultData.videoUrl = localUrl;
                                        resultData.imageUrl = null;
                                        resultData.filename = filename;
                                        downloaded = true;
                                    } else if (buffer.length > 50000) {
                                        console.warn(`      ⚠️ Blob data extracted was NOT a valid video stream (image/invalid content detected). Discarding.`);
                                    }
                                }
                            } else if (videoData.isHttp && !videoData.src.includes('googleusercontent.com') && !videoData.src.includes('gstatic')) {
                                try {
                                    const response = await page.request.get(videoData.src);
                                    if (response.ok()) {
                                        const buffer = await response.body();
                                        if (buffer.length > 50000 && isVideoBuffer(buffer)) {
                                            const filename = `flow_video_${Date.now()}.mp4`;
                                            const localPath = path.join(downloadDir, filename);
                                            writeFileSync(localPath, buffer);
                                            const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                            console.log(`      💾 ✅ Video saved from HTTP src: ${localPath} (${Math.round(buffer.length / 1024)}KB)`);
                                            resultData.downloadPath = localPath;
                                            resultData.downloadUrl = localUrl;
                                            resultData.videoUrl = localUrl;
                                            resultData.imageUrl = null;
                                            resultData.filename = filename;
                                            downloaded = true;
                                        } else if (buffer.length > 50000) {
                                            console.warn(`      ⚠️ HTTP resource was NOT a valid video stream. Discarding.`);
                                        }
                                    }
                                } catch (httpErr) {
                                    console.warn(`      ⚠️ HTTP video fetch error: ${httpErr.message}`);
                                }
                            }
                        }
                    }
                } catch (hoverErr) {
                    console.warn(`      ⚠️ Layer 1 hover/blob video extraction warning: ${hoverErr.message}`);
                }

                // ─────────────────────────────────────────────────────────────
                // LAYER 2: 3-dot Menu (⋮) -> Download -> 720p (Original size)
                // ─────────────────────────────────────────────────────────────
                if (!downloaded) {
                    try {
                        console.log(`      🔍 Layer 2: Attempting download via video tile 3-dot (⋮) menu...`);

                        // Ensure mouse is hovering over the target video tile so the top-right icons appear
                        const tileCoords = await page.evaluate(({ excludedUrls }) => {
                            const excluded = new Set(excludedUrls || []);
                            const tiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]'))
                                .filter(t => t.offsetWidth > 0 && t.offsetHeight > 0);
                            const tile = tiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            }) || tiles[tiles.length - 1] || null;

                            if (!tile) return null;
                            const r = tile.getBoundingClientRect();
                            return {
                                cx: r.left + r.width / 2,
                                cy: r.top + r.height / 2,
                                trX: r.right - 25,
                                trY: r.top + 25,
                            };
                        }, { excludedUrls: Array.from(excludedUrlSet) });

                        if (tileCoords) {
                            await page.mouse.move(tileCoords.cx, tileCoords.cy);
                            await page.waitForTimeout(600);
                            await page.mouse.move(tileCoords.trX, tileCoords.trY);
                            await page.waitForTimeout(400);
                        }

                        // Find the 3-dot button in the top-right area of the video tile
                        const menuBtnClicked = await page.evaluate(({ excludedUrls }) => {
                            const excluded = new Set(excludedUrls || []);
                            const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                            const tiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]'))
                                .filter(t => t.offsetWidth > 0 && t.offsetHeight > 0);
                            const tile = tiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            }) || tiles[tiles.length - 1] || null;

                            const tBox = tile ? tile.getBoundingClientRect() : null;

                            const btn = buttons.find(b => {
                                if (!b.offsetWidth) return false;
                                const r = b.getBoundingClientRect();
                                if (tBox && (r.left < tBox.left || r.right > tBox.right + 20 || r.top < tBox.top - 10 || r.bottom > tBox.bottom)) {
                                    return false;
                                }
                                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                return txt === 'more_vert' || txt === 'more_horiz' || txt === '⋮' ||
                                    aria.includes('more') || aria.includes('menu');
                            }) || buttons.find(b => {
                                if (!b.offsetWidth) return false;
                                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                return txt === 'more_vert' || txt === '⋮';
                            });

                            if (btn) {
                                btn.click();
                                return true;
                            }
                            return false;
                        }, { excludedUrls: Array.from(excludedUrlSet) });

                        if (menuBtnClicked) {
                            console.log(`      🖱️ Clicked 3-dot menu button. Waiting for dropdown...`);
                            await page.waitForTimeout(700);

                            // Find and hover/click the "Download" item in the menu
                            const dlClicked = await page.evaluate(() => {
                                const allItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, div'));
                                const dlItem = allItems.find(el => {
                                    if (!el.offsetWidth) return false;
                                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                    return txt.startsWith('download') || txt === 'download';
                                });
                                if (dlItem) {
                                    const r = dlItem.getBoundingClientRect();
                                    dlItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                                    dlItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                                    dlItem.click();
                                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                                }
                                return null;
                            });

                            if (dlClicked) {
                                console.log(`      🖱️ Hovered/clicked "Download" menu item at (${Math.round(dlClicked.x)}, ${Math.round(dlClicked.y)})...`);
                                await page.mouse.move(dlClicked.x, dlClicked.y);
                                await page.waitForTimeout(600);

                                // Find "720p (Original size)" or "Original size" submenu item
                                const subItem720 = await page.evaluateHandle(() => {
                                    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, div, span'));
                                    return items.find(el => {
                                        if (!el.offsetWidth) return false;
                                        const txt = (el.innerText || el.textContent || '').trim();
                                        return txt.includes('720p') || txt.includes('Original size');
                                    }) || null;
                                });

                                if (subItem720 && subItem720.asElement()) {
                                    console.log(`      📥 Found "720p (Original size)" option! Triggering browser download event...`);
                                    const [download] = await Promise.all([
                                        page.waitForEvent('download', { timeout: 25000 }).catch(() => null),
                                        subItem720.asElement().click(),
                                    ]);

                                    if (download) {
                                        const suggested = download.suggestedFilename() || '';
                                        console.log(`      📥 Browser download triggered: suggestedFilename="${suggested}"`);
                                        if (/\.(png|jpe?g|webp|gif)$/i.test(suggested)) {
                                            console.warn(`      ⚠️ Download event returned an IMAGE (${suggested}), not a video! Rejecting.`);
                                        } else {
                                            const filename = `flow_video_${Date.now()}.mp4`;
                                            const localPath = path.join(downloadDir, filename);
                                            await download.saveAs(localPath);
                                            const fileBuf = readFileSync(localPath);
                                            if (isVideoBuffer(fileBuf)) {
                                                const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                                console.log(`      💾 ✅ Video verified and saved via 3-dot menu 720p: ${localPath} (${Math.round(fileBuf.length / 1024)}KB)`);
                                                resultData.downloadPath = localPath;
                                                resultData.downloadUrl = localUrl;
                                                resultData.videoUrl = localUrl;
                                                resultData.imageUrl = null;
                                                resultData.filename = filename;
                                                downloaded = true;
                                            } else {
                                                console.warn(`      ⚠️ Downloaded file is NOT a valid video stream (image/invalid bytes). Deleting ${localPath}.`);
                                                try { unlinkSync(localPath); } catch {}
                                            }
                                        }
                                    } else {
                                        console.warn(`      ⚠️ Download event not fired after clicking 720p`);
                                    }
                                } else {
                                    console.warn(`      ⚠️ "720p (Original size)" submenu option not found in DOM`);
                                }
                            } else {
                                console.warn(`      ⚠️ "Download" option not found in 3-dot menu`);
                            }
                        } else {
                            console.warn(`      ⚠️ 3-dot menu button not found on video tile`);
                        }
                    } catch (menuErr) {
                        console.warn(`      ⚠️ Layer 2 3-dot menu download error: ${menuErr.message}`);
                    }
                }

                // ─────────────────────────────────────────────────────────────
                // LAYER 3: Click Play/Video Icon (▶) -> Open Editor/Player -> Toolbar Download
                // ─────────────────────────────────────────────────────────────
                if (!downloaded) {
                    try {
                        console.log(`      🎬 Layer 3: Clicking play icon / video tile to open player & download...`);
                        const tileClicked = await page.evaluate(({ excludedUrls }) => {
                            const excluded = new Set(excludedUrls || []);
                            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                            const tiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]'))
                                .filter(t => t.offsetWidth > 0 && t.offsetHeight > 0);
                            const tile = tiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            }) || tiles[tiles.length - 1] || null;

                            if (!tile) return false;
                            const tBox = tile.getBoundingClientRect();
                            const playBtn = btns.find(b => {
                                if (!b.offsetWidth) return false;
                                const r = b.getBoundingClientRect();
                                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                const isPlay = txt.includes('play') || (b.querySelector('svg, [class*="icon"]') && r.left < tBox.left + 100);
                                return isPlay && r.top >= tBox.top && r.top <= tBox.top + 100;
                            });
                            if (playBtn) {
                                playBtn.click();
                                return true;
                            }
                            tile.click();
                            return true;
                        }, { excludedUrls: Array.from(excludedUrlSet) });

                        if (tileClicked) {
                            console.log(`      🖱️ Opened player/editor view. Waiting 3s for player to render...`);
                            await page.waitForTimeout(3000);

                            // Check for <video> element in player view
                            const playerVideoSrc = await page.evaluate(() => {
                                const v = document.querySelector('video');
                                return v ? (v.getAttribute('src') || v.currentSrc || v.src || null) : null;
                            });

                            if (playerVideoSrc && playerVideoSrc.startsWith('blob:')) {
                                console.log(`      ⚡ Extracting blob video data from editor player: ${playerVideoSrc}`);
                                const base64Data = await page.evaluate(async (blobUrl) => {
                                    try {
                                        const res = await fetch(blobUrl);
                                        const blob = await res.blob();
                                        return new Promise((resolve) => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => resolve(reader.result);
                                            reader.readAsDataURL(blob);
                                        });
                                    } catch (e) {
                                        return null;
                                    }
                                }, playerVideoSrc);

                                if (base64Data && base64Data.startsWith('data:')) {
                                    const buffer = Buffer.from(base64Data.split(',')[1], 'base64');
                                    if (buffer.length > 50000 && isVideoBuffer(buffer)) {
                                        const filename = `flow_video_${Date.now()}.mp4`;
                                        const localPath = path.join(downloadDir, filename);
                                        writeFileSync(localPath, buffer);
                                        const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                        console.log(`      💾 ✅ Video saved from editor blob: ${localPath} (${Math.round(buffer.length / 1024)}KB)`);
                                        resultData.downloadPath = localPath;
                                        resultData.downloadUrl = localUrl;
                                        resultData.videoUrl = localUrl;
                                        resultData.imageUrl = null;
                                        resultData.filename = filename;
                                        downloaded = true;
                                    } else if (buffer.length > 50000) {
                                        console.warn(`      ⚠️ Editor blob data was NOT a valid video stream. Rejecting.`);
                                    }
                                }
                            }

                            if (!downloaded) {
                                // Try toolbar download button in editor
                                const editorDlBtn = await page.evaluateHandle(() => {
                                    const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
                                    return btns.find(b => {
                                        if (!b.offsetWidth) return false;
                                        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                        return txt.includes('download') || txt.includes('file_download') ||
                                            aria.includes('download') || aria.includes('export');
                                    }) || null;
                                });

                                if (editorDlBtn && editorDlBtn.asElement()) {
                                    console.log(`      📥 Clicking toolbar download/export button in editor...`);
                                    const [download] = await Promise.all([
                                        page.waitForEvent('download', { timeout: 25000 }).catch(() => null),
                                        editorDlBtn.asElement().click(),
                                    ]);

                                    if (download) {
                                        const suggested = download.suggestedFilename() || '';
                                        console.log(`      📥 Editor toolbar download triggered: suggestedFilename="${suggested}"`);
                                        if (/\.(png|jpe?g|webp|gif)$/i.test(suggested)) {
                                            console.warn(`      ⚠️ Editor toolbar downloaded an IMAGE (${suggested}), not a video! Rejecting.`);
                                        } else {
                                            const filename = `flow_video_${Date.now()}.mp4`;
                                            const localPath = path.join(downloadDir, filename);
                                            await download.saveAs(localPath);
                                            const fileBuf = readFileSync(localPath);
                                            if (isVideoBuffer(fileBuf)) {
                                                const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                                console.log(`      💾 ✅ Video verified and saved from editor toolbar: ${localPath} (${Math.round(fileBuf.length / 1024)}KB)`);
                                                resultData.downloadPath = localPath;
                                                resultData.downloadUrl = localUrl;
                                                resultData.videoUrl = localUrl;
                                                resultData.imageUrl = null;
                                                resultData.filename = filename;
                                                downloaded = true;
                                            } else {
                                                console.warn(`      ⚠️ Editor toolbar downloaded file is NOT a valid video stream. Deleting ${localPath}.`);
                                                try { unlinkSync(localPath); } catch {}
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (editorErr) {
                        console.warn(`      ⚠️ Layer 3 editor download error: ${editorErr.message}`);
                    }
                }

                // Strict enforcement: For video generation, download MUST produce a real video file
                if (!downloaded || !resultData.downloadPath) {
                    throw new Error('[GoogleFX] ❌ Video generation was completed in UI, but downloading valid video asset (.mp4) failed. Refusing to complete job without a valid video file.');
                }
            } else {
                // ─────────────────────────────────────────────────────────────
                // IMAGE DOWNLOAD WORKFLOW
                // ─────────────────────────────────────────────────────────────
                console.log(`      🖼️ Starting image download workflow...`);
                const mediaCards = await page.evaluate(() => {
                    const results = [];
                    const isUiOrProfile = (src) => {
                        if (!src || src.startsWith('data:')) return true;
                        const s = src.toLowerCase();
                        return s.includes('googleusercontent.com') || s.includes('lh3.google') ||
                               s.includes('gstatic') || s.includes('favicon') || s.includes('avatar') ||
                               s.includes('logo');
                    };
                    document.querySelectorAll('img').forEach((el, idx) => {
                        const src = el.getAttribute('src') || '';
                        if (isUiOrProfile(src)) return;
                        const rect = el.getBoundingClientRect();
                        if (rect.width < 100 || rect.height < 100 || rect.top < 80) return;
                        results.push({
                            idx,
                            tag: el.tagName.toLowerCase(),
                            src,
                            cx: Math.round(rect.left + rect.width / 2),
                            cy: Math.round(rect.top + rect.height / 2),
                            top: Math.round(rect.top),
                        });
                    });
                    return results;
                });

                for (const card of mediaCards) {
                    if (downloaded) break;
                    try {
                        console.log(`      🖱️ Hovering over ${card.tag} at (${card.cx}, ${card.cy})...`);
                        await page.mouse.move(card.cx, card.cy);
                        await page.waitForTimeout(800);

                        const DOWNLOAD_TEXTS = ['download_2', 'file_download', 'download', 'save', 'save_alt'];
                        const allBtns = await page.$$('button, a, [role="button"]');
                        let dlBtn = null;

                        for (const btn of allBtns) {
                            try {
                                if (!(await btn.isVisible())) continue;
                                const txt = (await btn.innerText()).trim().toLowerCase();
                                const aria = (await btn.getAttribute('aria-label') || '').toLowerCase();
                                const cls = (await btn.getAttribute('class') || '').toLowerCase();

                                if (
                                    DOWNLOAD_TEXTS.some(d => txt === d || txt.includes(d)) ||
                                    aria.includes('download') || aria.includes('save') ||
                                    cls.includes('download') || cls.includes('save')
                                ) {
                                    dlBtn = btn;
                                    break;
                                }
                            } catch {}
                        }

                        if (dlBtn && (await dlBtn.isVisible())) {
                            console.log(`      📥 Clicking image download button...`);
                            const filename = `flow_image_${Date.now()}.png`;
                            const localPath = path.join(downloadDir, filename);

                            const [download] = await Promise.all([
                                page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
                                dlBtn.click(),
                            ]);

                            if (download) {
                                await download.saveAs(localPath);
                                const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                console.log(`      💾 Image file saved: ${localPath}`);
                                resultData.downloadPath = localPath;
                                resultData.downloadUrl = localUrl;
                                resultData.filename = filename;
                                downloaded = true;
                            }
                        }
                    } catch (cardErr) {
                        console.warn(`      ⚠️ Image card download attempt failed: ${cardErr.message}`);
                    }
                }

                // Fallback: direct HTTP fetch for images
                if (!downloaded && resultData && resultData.imageUrl) {
                    try {
                        console.log(`      🌐 Downloading image via request: ${resultData.imageUrl.substring(0, 80)}...`);
                        const response = await page.request.get(resultData.imageUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Referer': 'https://labs.google/',
                            }
                        });

                        if (response.ok()) {
                            const buffer = await response.body();
                            const filename = `flow_image_${Date.now()}.png`;
                            const localPath = path.join(downloadDir, filename);
                            if (buffer && buffer.length > 500) {
                                writeFileSync(localPath, buffer);
                                const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                console.log(`      💾 Image saved via request: ${localPath} (${Math.round(buffer.length / 1024)}KB)`);
                                resultData.downloadPath = localPath;
                                resultData.downloadUrl = localUrl;
                                resultData.filename = filename;
                                downloaded = true;
                            }
                        }
                    } catch (dlErr) {
                        console.warn(`      ⚠️ Image request download error: ${dlErr.message}`);
                    }
                }
            }

            // Step 4: Upload downloaded asset to Cloudflare R2 under ai-content/${itemId}/${filename} & cleanup local file
            if (downloaded && resultData && resultData.downloadPath) {
                try {
                    const filename = resultData.filename || `flow_${type}_${Date.now()}.${isVideoType ? 'mp4' : 'png'}`;
                    const destinationKey = `ai-content/${itemId || 'gen_unknown'}/${filename}`;

                    // Detect contentType from actual saved file extension
                    const fileExt = filename.split('.').pop().toLowerCase();
                    const extToMime = {
                        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
                        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                        webp: 'image/webp', gif: 'image/gif',
                    };
                    const contentType = extToMime[fileExt] || (isVideoType ? 'video/mp4' : 'image/png');
                    console.log(`      ☁️ R2 contentType: ${contentType} (from .${fileExt})`);

                    console.log(`      ☁️ Uploading asset to Cloudflare R2 key: ${destinationKey}...`);
                    const r2Result = await uploadToR2(resultData.downloadPath, destinationKey, contentType);

                    if (r2Result && r2Result.r2Url) {
                        resultData.r2Url = r2Result.r2Url;
                        resultData.r2Key = r2Result.r2Key;
                        if (isVideoType) {
                            resultData.videoUrl = r2Result.r2Url;
                            resultData.imageUrl = null; // Strict isolation: Video job NEVER returns imageUrl
                        } else {
                            resultData.imageUrl = r2Result.r2Url;
                            resultData.videoUrl = null;
                        }
                        console.log(`      ☁️ ✅ Cloudflare R2 Public URL: ${r2Result.r2Url}`);

                        // Delete local temporary file after successful upload to R2
                        if (existsSync(resultData.downloadPath)) {
                            try {
                                unlinkSync(resultData.downloadPath);
                                console.log(`      🗑️ Successfully deleted local temp file: ${resultData.downloadPath}`);
                                resultData.downloadPath = null;
                            } catch (unlinkErr) {
                                console.warn(`      ⚠️ Could not delete local temp file: ${unlinkErr.message}`);
                            }
                        }
                    }
                } catch (r2Err) {
                    console.warn(`      ⚠️ R2 upload warning: ${r2Err.message}`);
                }
            }

            if (downloaded) {
                console.log(`      ✅ Asset download & R2 processing complete!`);
            } else {
                console.warn(`      ⚠️ Could not download asset — returning URL only`);
                if (isVideoType) {
                    throw new Error('[GoogleFX] ❌ Video was generated in UI, but downloading valid video asset (.mp4) failed. Refusing to complete job without a valid video file.');
                }
            }
        } catch (errDl) {
            console.error(`      ❌ Download section error: ${errDl.message}`);
            if (isVideoType) throw errDl;
        }

        return resultData;
    }
}

