// src/tools/googleFxFlow.js
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, createWriteStream, renameSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
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
const GOOGLE_FX_URL = 'https://flow.google.com/';

let sharedContext = null;
let isInitializing = false;
let sharedProjectPage = null;
let lastExtractedFramePath = null;
let lastExtractedFrameUrl = null;

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
    // Static property: tracks current proxy so browser context restarts on proxy change
    static _activeProxy = null;

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
                    '--disable-http2',
                    '--disable-quic',
                ],
                viewport: { width: 1280, height: 800 },
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            };

            // ── Inject Webshare proxy into Playwright if provided ──
            // proxyConfig = { server: 'http://host:port', username: '...', password: '...' }
            if (GoogleFxFlowTool._activeProxy && GoogleFxFlowTool._activeProxy.server) {
                launchOptions.proxy = {
                    server: GoogleFxFlowTool._activeProxy.server,
                    username: GoogleFxFlowTool._activeProxy.username || undefined,
                    password: GoogleFxFlowTool._activeProxy.password || undefined,
                };
                logger.info(`[🌐 GoogleFX] Launching Playwright with proxy: ${GoogleFxFlowTool._activeProxy.server}`);
                console.log(`🌐 [GoogleFX] Proxy injected into Playwright: ${GoogleFxFlowTool._activeProxy.server}`);
            } else {
                console.log(`🔗 [GoogleFX] No proxy — launching Playwright with direct VPS IP`);
            }

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

    async execute({ itemId, prompt, type = 'avatar_video', settings = {}, mediaUrl = null, imageUrl = null, avatarName = null, proxy = null, sceneNumber = 1, totalScenes = 1, previousSceneLastFrameUrl = null, isFirstScene = true }) {
        let cleanPrompt = this._cleanPromptText(prompt);
        if (sceneNumber === 1 && !cleanPrompt.toLowerCase().includes('scene 1') && !cleanPrompt.includes('generate video for scnee 1 only now')) {
            cleanPrompt = `${cleanPrompt.trim()}\n\ngenerate video for scnee 1 only now`;
        }
        const effectiveMediaUrl = mediaUrl || imageUrl || null;
        const effectiveAvatarName = (avatarName && String(avatarName).trim()) || 'me';
        const actualGenType = type === 'avatar_video' ? 'video' : type;
        const execStart = Date.now();

        // ── Proxy handling: if proxy not provided, load from DB; if changed, restart context ──
        let effectiveProxy = proxy;
        if (!effectiveProxy || !effectiveProxy.server) {
            try {
                const { getActiveProxyFromDB } = await import('../db.js');
                effectiveProxy = await getActiveProxyFromDB();
                if (effectiveProxy) {
                    console.log(`🌐 [GoogleFX] Loaded active proxy dynamically from DB: ${effectiveProxy.displayHost || effectiveProxy.server}`);
                }
            } catch (e) {
                console.warn(`⚠️ [GoogleFX] Could not load proxy from DB: ${e.message}`);
            }
        }

        const newProxyServer = effectiveProxy?.server || null;
        const activeProxyServer = GoogleFxFlowTool._activeProxy?.server || null;
        if (newProxyServer !== activeProxyServer) {
            if (sharedContext) {
                logger.info(`[🌐 GoogleFX] Proxy changed (${activeProxyServer || 'none'} → ${newProxyServer || 'none'}) — closing browser context for fresh launch`);
                console.log(`🔄 [GoogleFX] Proxy changed — closing existing browser context to launch with new proxy...`);
                await closeSharedContext();
            }
            GoogleFxFlowTool._activeProxy = effectiveProxy ? { ...effectiveProxy } : null;
        }

        console.log('\n' + '─'.repeat(60));
        console.log('🌐  [GoogleFxFlowTool] BROWSER AUTOMATION STARTED');
        console.log('─'.repeat(60));
        console.log(`🆔  Job ID      : ${itemId || 'N/A'}`);
        console.log(`🎬  Type        : ${type.toUpperCase()}`);
        console.log(`⚙️   Settings    : ${JSON.stringify(settings, null, 2)}`);
        if (effectiveMediaUrl) console.log(`🖼️   Media URL   : ${effectiveMediaUrl}`);
        console.log(`👤  Avatar Name : ${effectiveAvatarName} (REQUIRED)`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`💬  EXACT FULL PROMPT TO BE SUBMITTED INTO BROWSER (${cleanPrompt.length} chars):`);
        console.log(cleanPrompt);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.info(`[GoogleFxFlowTool] Executing (${type}) [${itemId}]: "${cleanPrompt}"`);

        let context = null;
        let page = null;
        let result = null;
        let totalMs = 0;

        try {
            // ── Scene 2+ OR Retry: Reuse shared project page if available ──────────────────
            const canReuseProjectPage = sharedProjectPage && !sharedProjectPage.isClosed() && sharedProjectPage.url().includes('/project/');

            if (canReuseProjectPage) {
                console.log(`\n♻️  [SAME SESSION] Reusing existing open project editor (${sharedProjectPage.url()}) — NO new project created!`);
                page = sharedProjectPage;

                // Ensure session drawer is open
                await this._clickExpandButton(page);
                await page.waitForTimeout(600);

                if (sceneNumber > 1) {
                    // Step 1: Upload and attach the LAST FRAME of the previous scene [STEP 1/2]
                    const frameToAttach = previousSceneLastFrameUrl || lastExtractedFramePath || lastExtractedFrameUrl || effectiveMediaUrl;
                    console.log(`\n🖼️ [Scene ${sceneNumber}] [STEP 1/2] Attaching last frame of previous scene to prompt bar: ${frameToAttach}...`);
                    if (frameToAttach) {
                        await this._uploadMediaFromUrl(page, frameToAttach, itemId);
                        console.log(`      ✅ [Scene ${sceneNumber}] Attached previous scene last frame to prompt bar!`);
                    } else {
                        console.warn(`      ⚠️ No last frame found for scene ${sceneNumber}!`);
                    }
                } else if (effectiveMediaUrl) {
                    // Scene 1 retry: ensure reference media is in prompt bar
                    const hasChip = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll('button.chip-container, button[class*="chip-container"]')).some(el => el.offsetWidth > 0);
                    });
                    if (!hasChip) {
                        console.log(`\n🖼️ [Scene 1 Retry] Attaching reference storyboard image to prompt bar: ${effectiveMediaUrl}...`);
                        await this._uploadMediaFromUrl(page, effectiveMediaUrl, itemId);
                    }
                }

                // Step 2: Add account Avatar to prompt [STEP 2/2] (MANDATORY & REQUIRED)
                if (effectiveAvatarName) {
                    this._lastAvatarName = effectiveAvatarName;
                    console.log(`\n👤 [Scene ${sceneNumber}] [STEP 2/2] Selecting Avatar "${effectiveAvatarName}" and adding to prompt...`);
                    await this._clickExpandButton(page);
                    await page.waitForTimeout(500);
                    await this._addAvatarToPrompt(page, effectiveAvatarName);
                }

                // Step 3: Check prompt bar chips
                await page.waitForTimeout(1000);
                const chipsCount = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    return Array.from(document.querySelectorAll('button.chip-container, button[class*="chip-container"]')).filter(isVisible).length;
                });
                console.log(`      🔎 [Scene ${sceneNumber}] Prompt bar chips count: ${chipsCount}`);

                // Step 4: Submit Scene prompt
                const defaultNextScenePrompt = `Generate the Scene ${sceneNumber} video now, using the storyboard image and the final frame of the previous scene as the continuation reference. Refer to the reference image included in the images.`;
                const scenePrompt = (cleanPrompt && !cleanPrompt.toLowerCase().includes('generate video scene number')) ? cleanPrompt : defaultNextScenePrompt;
                this._lastPrompt = scenePrompt;
                console.log(`\n⌨️ [Scene ${sceneNumber}] Submitting prompt into generation bar: "${scenePrompt}"...`);
                const postSubmitUrls = await this._submitPrompt(page, scenePrompt);
                console.log(`      ✅ [Scene ${sceneNumber}] Prompt submitted!`);

                // Step 5: Extract result
                const allExcludedUrls = Array.from(new Set([...(postSubmitUrls || [])]));
                result = await this._extractResult(page, type, itemId, allExcludedUrls);

                if (sceneNumber >= totalScenes && result && result.videoUrl) {
                    sharedProjectPage = null;
                }
            } else {
            // ── Scene 1 (or fallback): Full new project flow ──────────────────────

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
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'commit', timeout: config.browser.timeoutMs });
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
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

            // 2. Always click "New Project" button first (with multi-attempt new project retry if generation stalls)
            const MAX_PROJECT_ATTEMPTS = 3;
            result = null;

            for (let projectAttempt = 1; projectAttempt <= MAX_PROJECT_ATTEMPTS; projectAttempt++) {
                try {
                    if (projectAttempt > 1) {
                        console.log(`\n🔄 [GoogleFX] [RETRY ATTEMPT ${projectAttempt}/${MAX_PROJECT_ATTEMPTS}] Retrying in SAME session / project editor...`);
                        if (page && !page.isClosed() && page.url().includes('/project/')) {
                            console.log(`      ♻️  Reusing active project URL: ${page.url()} (no new project)`);
                            sharedProjectPage = page;
                            await this._dismissOverlays(page);
                        } else {
                            if (page && !page.isClosed()) await page.close().catch(() => {});
                            page = await context.newPage();
                            await page.goto(GOOGLE_FX_URL, { waitUntil: 'commit', timeout: config.browser.timeoutMs });
                            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                            await page.waitForTimeout(2500);
                            await this._dismissOverlays(page);
                            await this._createNewProject(page, false);
                            sharedProjectPage = page;
                        }
                    } else {
                        if (!page.url().includes('/project/')) {
                            console.log(`\n[3/6] ➕ Entering project editor...`);
                            await this._createNewProject(page, false);
                        }
                        sharedProjectPage = page;
                    }
                    let projectUrl = page.url();
                    console.log(`      ✅ Project active: ${projectUrl}`);

                    // Auto-handle OAuth consent screen / account chooser if redirected to accounts.google.com
                    if (projectUrl.includes('accounts.google.com') || projectUrl.includes('signin') || projectUrl.includes('oauth')) {
                        console.log(`      ⚠️ Redirected to Google account chooser / authorization screen...`);
                        try {
                            const accountItem = await page.$('li[data-identifier], div[data-identifier], [data-email], ul > li:has(img), button:has-text("Continue"), button:has-text("Confirm")');
                            if (accountItem && (await accountItem.isVisible())) {
                                await accountItem.click();
                                console.log(`      👉 Clicked account / consent item.`);
                            }
                        } catch (e) {}

                        // Wait for redirect back to Flow (or let user click in headful window)
                        console.log(`      ⏳ Waiting up to 25s for redirect back to Google Flow...`);
                        await page.waitForURL(url => !url.href.includes('accounts.google.com') && !url.href.includes('signin'), { timeout: 25000 }).catch(() => {});
                        await page.waitForTimeout(3000);
                        projectUrl = page.url();
                        console.log(`      ✅ URL after account selection: ${projectUrl}`);
                    }

                    // If redirected to home/dashboard rather than project editor, ensure we enter/create a project
                    if (!page.url().includes('/project/')) {
                        console.log(`      ➕ Not yet inside project editor (${page.url()}) — clicking New Project to enter...`);
                        await this._createNewProject(page, false);
                        projectUrl = page.url();
                        console.log(`      ✅ Project URL confirmed: ${projectUrl}`);
                    }

                    // Session check after project creation
                    if (projectUrl.includes('accounts.google.com') || projectUrl.includes('signin')) {
                        throw new Error('Google session requires login in browser. Please select account/log in in the open browser window.');
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

                            // 4. Upload reference storyboard image & add to prompt FIRST [STEP 1/2]
                            if (effectiveMediaUrl) {
                                this._lastMediaUrl = effectiveMediaUrl;
                                if (mediaUploadedInThisProject) {
                                    console.log(`\n[4/7] ℹ️ [RULE] Reference image was already uploaded in this project (${uploadedMediaUrls.length} url(s)). Skipping re-upload on retry in same project.`);
                                } else {
                                    console.log(`\n[4/7] 🖼️ [STEP 1/2] Uploading reference storyboard image and adding to prompt... (attempt ${uploadAttempt}/${MAX_UPLOAD_RETRIES + 1})`);
                                    uploadedMediaUrls = await this._uploadMediaFromUrl(page, effectiveMediaUrl, itemId);
                                    mediaUploadedInThisProject = true;
                                    this._mediaUploadedInCurrentProject = true;
                                    console.log(`      🔒 Uploaded media URLs captured for exclusion: ${uploadedMediaUrls.length}`);
                                }
                            }

                            // 5. Add account Avatar to prompt SECOND [STEP 2/2] (MANDATORY & REQUIRED)
                            this._lastAvatarName = effectiveAvatarName;
                            console.log(`\n[5/7] 👤 [STEP 2/2] Selecting Avatar "${effectiveAvatarName}" and adding to prompt (REQUIRED)...`);
                            await this._clickExpandButton(page);
                            await page.waitForTimeout(500);
                            await this._addAvatarToPrompt(page, effectiveAvatarName);

                            // ── MANDATORY POST-CALL VERIFICATION ──────────────────────────────────
                            console.log(`      🔎 [POST-AVATAR CHECK] Performing mandatory final avatar verification in prompt bar...`);
                            const avatarConfirmed = await page.evaluate(() => {
                                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                                const chips = Array.from(document.querySelectorAll('button.chip-container, button[class*="chip-container"]')).filter(isVisible);
                                // STRICT REQUIREMENT: Storyboard (chip 1) AND Avatar (chip 2) must BOTH be present!
                                return chips.length >= 2;
                            });
                            if (!avatarConfirmed) {
                                throw new Error(`[GoogleFX] ❌ MANDATORY AVATAR CHECK FAILED: Both Storyboard and Avatar "${effectiveAvatarName}" must be attached (found < 2 chips in prompt bar).`);
                            }
                            console.log(`      ✅ [POST-AVATAR CHECK] Both Storyboard and Avatar "${effectiveAvatarName}" confirmed in prompt bar (chips >= 2) — proceeding.`);
                            // ─────────────────────────────────────────────────────────────────────

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
                    result = await this._extractResult(page, type, itemId, allExcludedUrls);

                    // Preserve last frame of scene 1 for subsequent scenes in same project
                    if (totalScenes > 1) {
                        console.log(`\n📸 [Scene 1/${totalScenes}] Preserving last frame for next scene...`);
                        if (result && (result.lastFrameUrl || result.lastFramePath)) {
                            console.log(`      ✅ Last frame ready for scene 2: ${result.lastFrameUrl || result.lastFramePath}`);
                        }
                        sharedProjectPage = page;
                    }

                    break; // SUCCESS! Break out of project attempt loop
                } catch (projErr) {
                    console.warn(`\n⚠️ [GoogleFX] Generation error in current project: ${projErr.message}`);
                    if (page && !page.isClosed() && page.url().includes('/project/')) {
                        sharedProjectPage = page;
                        console.log(`      ♻️  Preserving project URL (${page.url()}) — staying in SAME project!`);
                    }
                    throw projErr;
                }
            }
            }

            if (!result) {
                throw new Error('[GoogleFX] ❌ Failed to generate video across all project attempts.');
            }

            totalMs = Date.now() - execStart;
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
            const isCompletedSuccessfully = !!(result && (result.videoUrl || result.imageUrl));
            const isLastScene = sceneNumber >= totalScenes;

            if (isLastScene && isCompletedSuccessfully) {
                console.log(`🎉 [GoogleFX] Generation successfully finished for all scenes!`);
                if (config.browser.headless) {
                    if (page && !page.isClosed()) {
                        try {
                            await page.close();
                            console.log(`      🔒 Browser tab closed cleanly.`);
                        } catch (closeErr) {}
                    }
                    try {
                        await closeSharedContext();
                    } catch (closeContextErr) {}
                } else {
                    console.log(`      📌 Headful mode: keeping browser open so you can view the final result.`);
                }
                sharedProjectPage = null;
            } else if (page && !page.isClosed() && page.url().includes('/project/')) {
                // ALWAYS preserve sharedProjectPage for any retries or next scenes in the SAME project
                sharedProjectPage = page;
                console.log(`      📌 [SAME PROJECT] Preserving active project editor page (${page.url()}) for retry or next scene.`);
            } else {
                console.log(`      📌 Multi-scene flow in progress — keeping browser open.`);
            }
        }
    }

    async _createNewProject(page, forceNavigate = false) {
        // If already inside an active project editor and not explicitly forced, do NOT create a new project!
        if (!forceNavigate && page.url().includes('/project/')) {
            console.log(`      ℹ️ Already inside project editor (${page.url()}) — staying in same session/project.`);
            return;
        }

        // If not on main lander, or forceNavigate, navigate to GOOGLE_FX_URL first to locate New Project button
        if (forceNavigate || (!page.url().includes('flow.google.com') && !page.url().includes('labs.google/fx/tools/flow'))) {
            console.log(`      🌍 Navigating to main flow landing page to open New Project...`);
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'commit', timeout: config.browser.timeoutMs });
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(2500);
            await this._dismissOverlays(page);
        }

        if (page.url().includes('/about')) {
            console.log(`      ℹ️ Landed on /about page, clicking Create to get to studio...`);
            const createLnk = await page.$('button:has-text("Create"), a:has-text("Create")');
            if (createLnk && (await createLnk.isVisible())) {
                await createLnk.click();
                await page.waitForTimeout(3000);
                await this._dismissOverlays(page);
            }
        }

        const newProjectSelectors = [
            'button.new-project-button',
            'button:has-text("New project")',
            'button:has-text("New Project")',
            '[aria-label*="new project" i]',
            '[class*="new-project"]',
            'a:has-text("New project")',
            'button:has-text("+ New")',
            'button:has-text("Start")',
        ];

        let clicked = false;
        for (const sel of newProjectSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn && (await btn.isVisible())) {
                    await btn.click();
                    clicked = true;
                    console.log(`      ➕ Clicked "New Project" button: ${sel}`);
                    break;
                }
            } catch {}
        }

        if (!clicked) {
            // Check if page has CTA buttons in body
            const buttons = await page.$$('button, a');
            for (const btn of buttons) {
                const text = (await btn.innerText()).toLowerCase();
                if (text.includes('new project') || text.includes('try flow') || text.includes('open studio')) {
                    await btn.click();
                    clicked = true;
                    console.log(`      ➕ Clicked CTA button for New Project: "${text.trim()}"`);
                    break;
                }
            }
        }

        if (clicked) {
            try {
                await page.waitForURL(url => url.pathname.includes('/project/'), { timeout: 25000 });
                console.log(`      ✅ Successfully entered project: ${page.url()}`);
            } catch (waitErr) {
                console.warn(`      ⚠️ Waiting for /project/ URL: current is ${page.url()}`);
            }
            await page.waitForTimeout(3000);
        } else {
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

            // Ensure Agent panel is expanded first
            await this._clickExpandButton(page);
            await page.waitForTimeout(600);

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
                const textPresent = (document.body.innerText || '').includes('Confirm before generating') ||
                    (document.body.innerText || '').includes('Video generation default') ||
                    (document.body.innerText || '').includes('Image generation default');
                const hasNeverToggle = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"]'))
                    .some(el => (el.innerText || el.textContent || '').toLowerCase().includes('never'));
                return textPresent || hasNeverToggle;
            });

            // ── STEP 2: Find & Click Settings Button ─────────────────────────────
            if (panelOpened) {
                console.log(`      ✅ Agent Settings drawer is already open`);
            } else {
                for (let attempt = 1; attempt <= 5; attempt++) {
                    const coords = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                        // STRATEGY 1 (NEW UI): button[aria-label="Agent settings"] in Agent panel header
                        const agentSettingsBtn = Array.from(document.querySelectorAll('button')).find(b => {
                            if (!isVisible(b)) return false;
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
                            return aria === 'agent settings';
                        });
                        if (agentSettingsBtn) {
                            if (window.__highlight) window.__highlight(agentSettingsBtn);
                            const r = agentSettingsBtn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), strategy: 'button[aria-label="Agent settings"]' };
                        }

                        // STRATEGY 2: settings_2 icon in Agent panel header (top < 150, right half)
                        const headerSettingsBtn = Array.from(document.querySelectorAll('button')).find(b => {
                            if (!isVisible(b)) return false;
                            const r = b.getBoundingClientRect();
                            if (r.top > 150 || r.left < window.innerWidth * 0.5) return false;
                            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
                            return txt.includes('settings_2') || aria.includes('setting');
                        });
                        if (headerSettingsBtn) {
                            if (window.__highlight) window.__highlight(headerSettingsBtn);
                            const r = headerSettingsBtn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), strategy: 'header-settings_2-button' };
                        }

                        // STRATEGY 3: "tune" button inside prompt bar (legacy UI)
                        const inPromptBar = b => {
                            const r = b.getBoundingClientRect();
                            return r.left > window.innerWidth * 0.5 && r.top > window.innerHeight * 0.6;
                        };
                        const tuneBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return txt === 'tune' || Array.from(b.querySelectorAll('*')).some(el => (el.textContent || '').trim().toLowerCase() === 'tune');
                        });
                        const tuneBtn = tuneBtns.find(inPromptBar) || tuneBtns[0];
                        if (tuneBtn) {
                            if (window.__highlight) window.__highlight(tuneBtn);
                            const r = tuneBtn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), strategy: 'tune-button' };
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
                        const textPresent = (document.body.innerText || '').includes('Confirm before generating') ||
                            (document.body.innerText || '').includes('Video generation default') ||
                            (document.body.innerText || '').includes('Image generation default');
                        const hasNeverToggle = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"]'))
                            .some(el => (el.innerText || el.textContent || '').toLowerCase().includes('never'));
                        return textPresent || hasNeverToggle;
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
            // In the new UI, this uses mat-button-toggle ("Always", "Never")
            console.log(`      🔴 [MANDATORY] Forcing "Confirm before generating" → Never...`);
            let neverConfirmed = false;

            for (let attempt = 1; attempt <= 5; attempt++) {
                // First: check if Never is already selected
                const isAlreadyNever = await page.evaluate(() => {
                    // Check mat-button-toggle (new UI)
                    const toggles = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"]'));
                    const neverToggle = toggles.find(t => (t.innerText || t.textContent || '').toLowerCase().includes('never'));
                    if (neverToggle) {
                        if (neverToggle.classList.contains('mat-button-toggle-checked') ||
                            neverToggle.getAttribute('aria-pressed') === 'true' ||
                            neverToggle.getAttribute('aria-checked') === 'true') {
                            return true;
                        }
                        const innerBtn = neverToggle.querySelector('button');
                        if (innerBtn && (innerBtn.getAttribute('aria-pressed') === 'true' || innerBtn.getAttribute('aria-checked') === 'true')) {
                            return true;
                        }
                    }
                    // Legacy radio inputs
                    const allNativeRadios = Array.from(document.querySelectorAll('input[type="radio"].mdc-radio__native-control, input[type="radio"]'));
                    for (const radio of allNativeRadios) {
                        const label = radio.closest('label') || radio.closest('.mdc-form-field') || radio.parentElement;
                        const labelText = (label?.innerText || label?.textContent || '').toLowerCase();
                        if (labelText.includes('never') || labelText.includes('auto_approve')) {
                            return radio.checked === true;
                        }
                    }
                    return false;
                });

                if (isAlreadyNever) {
                    console.log(`      ✅ "Never" is already selected ✓`);
                    neverConfirmed = true;
                    break;
                }

                // Find Never toggle / button and click it
                const clickCoords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                    // Strategy A: mat-button-toggle containing Never (new UI)
                    const toggles = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"]'));
                    const neverToggle = toggles.find(t => isVisible(t) && (t.innerText || t.textContent || '').toLowerCase().includes('never'));
                    if (neverToggle) {
                        const clickEl = neverToggle.querySelector('button') || neverToggle;
                        clickEl.click();
                        const r = clickEl.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), via: 'mat-button-toggle' };
                    }

                    // Strategy B: Button or span with text Never
                    const allButtons = Array.from(document.querySelectorAll('button, span')).filter(isVisible);
                    const neverBtn = allButtons.find(b => (b.innerText || b.textContent || '').trim().toLowerCase().startsWith('never'));
                    if (neverBtn) {
                        neverBtn.click();
                        const r = neverBtn.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), via: 'button-never' };
                    }

                    // Strategy C: Legacy native radio input
                    const allNativeRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
                    for (const radio of allNativeRadios) {
                        const label = radio.closest('label') || radio.parentElement;
                        if ((label?.innerText || '').toLowerCase().includes('never')) {
                            radio.click();
                            const r = label.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), via: 'legacy-radio' };
                        }
                    }

                    return null;
                });

                if (clickCoords && clickCoords.cx > 0 && clickCoords.cy > 0) {
                    console.log(`      🖱️ Clicking "Never" at [${clickCoords.cx}, ${clickCoords.cy}] (attempt ${attempt}/5, via: ${clickCoords.via})`);
                    try { await page.mouse.click(clickCoords.cx, clickCoords.cy); } catch {}
                } else {
                    console.warn(`      ⚠️ "Never" toggle element not found on attempt ${attempt}/5`);
                }
                await page.waitForTimeout(600);

                // Verify
                neverConfirmed = await page.evaluate(() => {
                    const toggles = Array.from(document.querySelectorAll('mat-button-toggle, [role="radio"]'));
                    const neverToggle = toggles.find(t => (t.innerText || t.textContent || '').toLowerCase().includes('never'));
                    if (neverToggle) {
                        if (neverToggle.classList.contains('mat-button-toggle-checked') ||
                            neverToggle.getAttribute('aria-pressed') === 'true' ||
                            neverToggle.getAttribute('aria-checked') === 'true') {
                            return true;
                        }
                        const innerBtn = neverToggle.querySelector('button');
                        if (innerBtn && (innerBtn.getAttribute('aria-pressed') === 'true' || innerBtn.getAttribute('aria-checked') === 'true')) {
                            return true;
                        }
                    }
                    const allNativeRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
                    for (const radio of allNativeRadios) {
                        const label = radio.closest('label') || radio.parentElement;
                        if ((label?.innerText || '').toLowerCase().includes('never')) return radio.checked === true;
                    }
                    return false;
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


            // ── STEP 5: Save / Close Settings Drawer ───────────────────────────
            let saveConfirmed = false;
            for (let closeAttempt = 1; closeAttempt <= 3; closeAttempt++) {
                const closed = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const allBtns = Array.from(document.querySelectorAll('button')).filter(isVisible);

                    // PRIORITY 1: Click Back (arrow_back) button in the settings drawer header
                    const backBtn = allBtns.find(b => {
                        const r = b.getBoundingClientRect();
                        if (r.top > 150 || r.left < window.innerWidth * 0.5) return false;
                        const txt = (b.innerText || b.textContent || '').trim();
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        return txt === 'arrow_back' || aria.includes('back');
                    });
                    if (backBtn) {
                        backBtn.click();
                        return 'clicked_arrow_back';
                    }

                    // PRIORITY 2: If a Save button exists, click it
                    let saveBtn = allBtns.find(b => (b.innerText || b.textContent || '').trim() === 'Save');
                    if (saveBtn) {
                        saveBtn.click();
                        return 'clicked_save';
                    }

                    // PRIORITY 3: Toggle off Agent settings button
                    const agentSettingsBtn = allBtns.find(b => {
                        const r = b.getBoundingClientRect();
                        return r.top < 150 && (b.getAttribute('aria-label') || '').toLowerCase().trim() === 'agent settings';
                    });
                    if (agentSettingsBtn) {
                        agentSettingsBtn.click();
                        return 'clicked_agent_settings_toggle';
                    }

                    return null;
                });

                if (closed) {
                    console.log(`      ✅ Settings drawer closed via ${closed}`);
                }
                await page.waitForTimeout(800);

                saveConfirmed = await page.evaluate(() => {
                    const textPresent = (document.body.innerText || '').includes('Confirm before generating');
                    return !textPresent;
                });

                if (saveConfirmed) {
                    console.log(`      ✅ Settings drawer confirmed closed cleanly`);
                    break;
                }
            }

            // Always ensure the right-side Agent panel is expanded and ready
            await this._clickExpandButton(page);
            await page.waitForTimeout(600);

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

        // Check if media drawer is ALREADY open
        const isPanelAlreadyOpen = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const popover = document.querySelector('flow-add-menu-popover-content, [class*="add-menu-popover"]');
            return !!popover && isVisible(popover);
        });

        if (isPanelAlreadyOpen) {
            console.log(`      ✅ Media drawer is already open!`);
            return true;
        }

        for (let attempt = 1; attempt <= 4; attempt++) {
            const coords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const isNotChip = b => {
                    const cls = (b.className || '').toLowerCase();
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (cls.includes('chip') || aria.includes('ingredient') || aria.includes('remove') || aria.includes('close')) return false;
                    return true;
                };

                // Priority 1: Exact aria-label
                const addByAria = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
                if (addByAria && isVisible(addByAria)) {
                    const r = addByAria.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), name: 'aria-button' };
                }

                // Priority 2: Button with add_2 icon
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => isVisible(b) && isNotChip(b));
                const addByIcon = allBtns.find(b => {
                    const txt = (b.innerText || b.textContent || '').trim();
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    return txt === 'add_2' || txt.includes('add_2') || aria.includes('add ingredient');
                });
                if (addByIcon) {
                    const r = addByIcon.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), name: 'icon-button' };
                }

                // Priority 3: Fallback button near prompt bar
                const rightTextbox = Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]'))
                    .find(el => isVisible(el) && el.getBoundingClientRect().left > window.innerWidth * 0.4);
                if (rightTextbox) {
                    let parent = rightTextbox.parentElement;
                    for (let i = 0; i < 6 && parent; i++) {
                        const candidateBtns = Array.from(parent.querySelectorAll('button')).filter(b => {
                            if (!isVisible(b) || !isNotChip(b)) return false;
                            const r = b.getBoundingClientRect();
                            return r.left > window.innerWidth * 0.4 && r.top > window.innerHeight * 0.65;
                        });
                        const plusBtn = candidateBtns.find(b => {
                            const txt = (b.innerText || b.textContent || '').trim();
                            return txt === '+' || txt === 'add_2' || (b.getAttribute('aria-label') || '').includes('add');
                        });
                        if (plusBtn) {
                            const r = plusBtn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), name: 'nearby-plus-btn' };
                        }
                        parent = parent.parentElement;
                    }
                }

                return null;
            });

            if (coords) {
                console.log(`      🖱️ Clicked "${coords.name}" (+) button at [${coords.cx}, ${coords.cy}] (attempt ${attempt}/4)...`);
                try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                await page.waitForTimeout(1500);

                const panelOpen = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const popover = document.querySelector('flow-add-menu-popover-content, [class*="add-menu-popover"]');
                    return !!popover && isVisible(popover);
                });

                if (panelOpen) {
                    console.log(`      ✅ Media drawer opened successfully!`);
                    return true;
                }
            }

            await page.waitForTimeout(1000);
        }


        console.warn('[GoogleFX] ⚠️ Could not open media drawer via "+" button.');
        return false;
    }

    /**
     * Switches tab in the ingredients popover (e.g. 'Images', 'Avatars', 'Uploads')
     */
    async _switchMediaTab(page, tabName) {
        console.log(`      📂 Switching to "${tabName}" tab in ingredients popover...`);
        const switched = await page.evaluate((targetTab) => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const tabs = Array.from(document.querySelectorAll('mat-list-item[role="tab"], [role="tab"], mat-list-item')).filter(isVisible);
            const match = tabs.find(t => (t.innerText || '').toLowerCase().includes(targetTab.toLowerCase()));
            if (match) {
                match.click();
                return true;
            }
            return false;
        }, tabName);
        await page.waitForTimeout(1000);
        return switched;
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

        let tmpPath, mediaType, ext, contentType;
        if (typeof mediaUrl === 'string' && existsSync(mediaUrl)) {
            tmpPath = mediaUrl;
            ext = path.extname(mediaUrl).replace('.', '').toLowerCase() || 'jpg';
            mediaType = ['mp4', 'mov', 'webm'].includes(ext) ? 'video' : 'image';
            contentType = mediaType === 'video' ? `video/${ext}` : `image/${ext}`;
            console.log(`      📁 Using existing local reference file [${mediaType.toUpperCase()}, .${ext}]: ${tmpPath}`);
        } else {
            const mediaInfo = await fetchAndDetectMedia(mediaUrl);
            tmpPath = mediaInfo.tmpPath;
            mediaType = mediaInfo.mediaType;
            ext = mediaInfo.ext;
            contentType = mediaInfo.contentType;
            console.log(`      ⬇️ Downloaded reference ${mediaType.toUpperCase()} [MIME: ${contentType || 'n/a'}, Ext: .${ext}]: ${mediaUrl}`);
            console.log(`      ✅ Media saved to temp file: ${tmpPath}`);
        }

        // ── Step 2: Open Media Drawer via "+ Create" button ──────
        console.log(`      📂 Opening media panel via _openMediaPanel helper...`);
        const panelOpened = await this._openMediaPanel(page);
        if (!panelOpened) {
            try { if (tmpPath !== mediaUrl && existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Could not open media panel to upload file.`);
        }

        await page.waitForTimeout(1000);

        // Switch to "Images" tab before uploading
        await this._switchMediaTab(page, 'Images');
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

                // ── Real-Time UI Upload Progress Tracking (Wait 100% Upload) ─────────
                console.log(`      ⏳ Real-Time UI Tracking: Monitoring background upload until 100% complete...`);
                let uploadDoneInBackground = false;
                const uploadStartTime = Date.now();
                const targetFilename = path.basename(tmpPath);

                for (let wait = 1; wait <= 40; wait++) {
                    await page.waitForTimeout(1000);
                    const uploadState = await page.evaluate((fname) => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const popover = document.querySelector('flow-add-menu-popover-content');
                        if (!popover) return { isUploading: true, hasFinishedItem: false };
                        const items = Array.from(popover.querySelectorAll('button.asset-item, [role="option"]')).filter(isVisible);
                        const uploadingItem = items.find(it => (it.innerText || '').toLowerCase().includes('uploading'));
                        const finishedItem = items.find(it => {
                            const txt = (it.innerText || '').toLowerCase();
                            return (txt.includes(fname.toLowerCase()) || txt.includes('storyboard') || txt.includes('upload_ref')) && !txt.includes('uploading');
                        });
                        const progress = document.querySelector('[role="progressbar"], mat-progress-bar, progress');
                        return {
                            isUploading: !!uploadingItem || !!progress,
                            hasFinishedItem: !!finishedItem,
                            itemsText: items.map(it => (it.innerText || '').trim().replace(/\n/g, ' '))
                        };
                    }, targetFilename);

                    const elapsedSec = Math.round((Date.now() - uploadStartTime) / 1000);
                    if (uploadState.hasFinishedItem && !uploadState.isUploading) {
                        console.log(`      ✅ Image upload 100% completed in UI (${elapsedSec}s elapsed)!`);
                        uploadDoneInBackground = true;
                        break;
                    }
                    if (wait % 5 === 0) {
                        console.log(`      ⏳ Upload progress (${elapsedSec}s elapsed): items=[${uploadState.itemsText.join(', ')}]`);
                    }
                }

                if (!uploadDoneInBackground) {
                    console.warn(`      ⚠️ Upload did not explicitly confirm 100% within 40s, proceeding to Images tab...`);
                    uploadDoneInBackground = true;
                }

                // ── PHASE 2: Select uploaded asset in Images tab & click "Add to prompt" ──
                console.log(`      📂 Phase 2: Selecting uploaded asset in Images tab and adding to prompt bar...`);
                let phase2Success = false;
                for (let attempt = 1; attempt <= 5 && !phase2Success; attempt++) {
                    // 1. Ensure popover/drawer is open
                    await this._openMediaPanel(page);
                    await page.waitForTimeout(800);

                    // 2. Switch to Images tab
                    await this._switchMediaTab(page, 'Images');
                    await page.waitForTimeout(1000);

                    // 3. Click the uploaded image item
                    const selectedItem = await page.evaluate((fname) => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const popover = document.querySelector('flow-add-menu-popover-content') || document.body;
                        const items = Array.from(popover.querySelectorAll('button.asset-item, [role="option"]')).filter(isVisible);
                        const match = items.find(b => {
                            const txt = (b.innerText || '').toLowerCase();
                            return (txt.includes(fname.toLowerCase()) || txt.includes('storyboard') || txt.includes('upload_ref')) && !txt.includes('uploading');
                        }) || items[0];

                        if (match) {
                            match.click();
                            return (match.innerText || '').trim().replace(/\n/g, ' ');
                        }
                        return null;
                    }, targetFilename);

                    if (selectedItem) {
                        console.log(`      📌 Selected image asset in Images tab: "${selectedItem}"`);
                        await page.waitForTimeout(1000);
                    }

                    // 4. Click "Add to prompt" button
                    const addClicked = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const btn = Array.from(document.querySelectorAll('button.detail-add-to-prompt-btn, button')).find(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || '').trim().toLowerCase();
                            return txt === 'add to prompt' || txt.includes('add to prompt');
                        });
                        if (btn) {
                            btn.click();
                            return true;
                        }
                        return false;
                    });

                    if (addClicked) {
                        console.log(`      🖱️ Clicked "Add to prompt" button for uploaded image!`);
                        await page.waitForTimeout(1500);
                    }

                    // Close popover
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(1000);

                    // 5. Verify chip in prompt bar
                    const hasChip = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const chips = Array.from(document.querySelectorAll('button.chip-container, button[class*="chip-container"]')).filter(isVisible);
                        return chips.length >= 1;
                    });

                    if (hasChip) {
                        console.log(`      ✅ Uploaded storyboard chip confirmed attached in prompt bar!`);
                        phase2Success = true;
                        break;
                    }

                    await page.waitForTimeout(1000);
                }

                uploaded = true;
                break;

            } catch (fcErr) {
                console.warn(`      ⚠️ File chooser attempt ${attempt}/3 failed: ${fcErr.message}`);
                await page.waitForTimeout(1500);
            }
        }

        if (!uploaded) {
            try { if (tmpPath !== mediaUrl && existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Media upload failed: file chooser was not triggered or file set failed after 3 attempts.`);
        }

        console.log(`      ✅ Storyboard attachment step completed.`);


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
            if (tmpPath !== mediaUrl && existsSync(tmpPath)) {
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
    /**
     * Opens media panel, navigates to "Avatar" tab, selects the avatar card, clicks "Add to Prompt",
     * and strictly verifies that the avatar is attached to the prompt bar.
     */
    async _addAvatarToPrompt(page, avatarName = 'me') {
        const targetAvatar = (avatarName && String(avatarName).trim()) || 'me';
        console.log(`\n[Avatar] 👤 Adding Avatar "${targetAvatar}" to prompt (REQUIRED)...`);

        let attached = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            // Step 1: Open the Media Drawer
            await this._openMediaPanel(page);
            await page.waitForTimeout(800);

            // Step 2: Switch strictly to "Avatars" tab in the popover
            await this._switchMediaTab(page, 'Avatars');
            await page.waitForTimeout(1000);

            // Step 3: Ensure Avatar "Me" is selected and "Add to prompt" is clicked
            const addClicked = await page.evaluate((targetName) => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const popover = document.querySelector('flow-add-menu-popover-content') || document.body;

                // Check if "Add to prompt" is ALREADY visible (Me is preselected)
                let btn = Array.from(document.querySelectorAll('button.detail-add-to-prompt-btn, button')).find(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || '').trim().toLowerCase();
                    return txt === 'add to prompt' || txt.includes('add to prompt');
                });

                if (btn) {
                    btn.click();
                    return 'clicked_direct';
                }

                // If not showing, click the Me card
                const items = Array.from(popover.querySelectorAll('button.asset-item, [role="option"]')).filter(isVisible);
                const me = items.find(it => {
                    const txt = (it.innerText || '').toLowerCase();
                    return !txt.includes('rename') && (txt.includes('me') || txt.includes('avatar'));
                }) || items[0];

                if (me) {
                    me.click();
                    return 'clicked_item';
                }
                return 'not_found';
            }, targetAvatar);

            console.log(`      📌 Avatar action: "${addClicked}"`);
            await page.waitForTimeout(1000);

            if (addClicked === 'clicked_item') {
                await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const btn = Array.from(document.querySelectorAll('button.detail-add-to-prompt-btn, button')).find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || '').trim().toLowerCase();
                        return txt === 'add to prompt' || txt.includes('add to prompt');
                    });
                    if (btn) btn.click();
                });
                await page.waitForTimeout(1500);
            }

            // Close popover
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

            // Step 5: Verify prompt bar chips (Must have >= 2 chips: Storyboard + Avatar)
            attached = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const chips = Array.from(document.querySelectorAll('button.chip-container, button[class*="chip-container"]')).filter(isVisible);
                return chips.length >= 2;
            });

            if (attached) {
                console.log(`      ✨ SUCCESS: Both Storyboard and Avatar ("${targetAvatar}") confirmed attached to prompt bar (chips count >= 2)!`);
                break;
            }
            console.warn(`      ⚠️ Both chips not confirmed yet (attempt ${attempt}/5)...`);
            await page.waitForTimeout(1500);
        }

        if (!attached) {
            throw new Error(`[GoogleFX] ❌ Could not verify BOTH Storyboard and Avatar "${targetAvatar}" in prompt bar (chips count < 2).`);
        }

        await page.waitForTimeout(1000);
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

        // 1. Find and click the text editor element cleanly in the right panel prompt bar
        await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const editors = Array.from(document.querySelectorAll('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]'))
                .filter(el => isVisible(el) && el.getBoundingClientRect().left > window.innerWidth * 0.5 && el.getBoundingClientRect().top > window.innerHeight * 0.5);
            const ed = editors[editors.length - 1] || editors[0];
            if (ed) {
                ed.focus();
                ed.click();
            }
        });
        await page.waitForTimeout(400);

        // 2. Safely position cursor at the end without selecting or deleting attached chips
        try {
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
        } catch (e) {}
        await page.waitForTimeout(200);

        // 3. Type prompt using Playwright CDP trusted input (no execCommand, no innerHTML mutation)
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(500);

        // Final verification check of typed length
        const currentPromptLength = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const editors = Array.from(document.querySelectorAll('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]'))
                .filter(el => isVisible(el) && el.getBoundingClientRect().left > window.innerWidth * 0.5 && el.getBoundingClientRect().top > window.innerHeight * 0.5);
            const ed = editors[editors.length - 1] || editors[0];
            return ed ? (ed.innerText || ed.value || ed.textContent || '').trim().length : 0;
        });

        console.log(`      ✅ Prompt typed successfully into input bar (${currentPromptLength} / ${prompt.length} chars)`);

        // 4. Click Send button (Start generation / arrow_forward) in bottom prompt bar
        const sendCoords = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const allBtns = Array.from(document.querySelectorAll('button')).filter(b => {
                if (!isVisible(b)) return false;
                const r = b.getBoundingClientRect();
                return r.left > window.innerWidth * 0.5 && r.top > window.innerHeight * 0.65;
            });

            // PRIORITY 1: button[aria-label="Start generation"] in bottom prompt bar (new Google Flow UI)
            let sendBtn = allBtns.find(b => {
                const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
                return aria === 'start generation' || aria === 'send' || aria === 'generate';
            });

            // PRIORITY 2: button containing arrow_forward icon in bottom-right prompt bar (y > 65%)
            if (!sendBtn) {
                sendBtn = allBtns.find(b => {
                    const txt = (b.innerText || b.textContent || '').trim();
                    const hasIcon = Array.from(b.querySelectorAll('mat-icon, i, span')).some(el => (el.textContent || '').trim() === 'arrow_forward');
                    return txt === 'arrow_forward' || hasIcon;
                });
            }

            if (sendBtn) {
                if (window.__highlight) window.__highlight(sendBtn);
                const r = sendBtn.getBoundingClientRect();
                return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), label: sendBtn.getAttribute('aria-label') || 'arrow_forward' };
            }
            return null;
        });

        const _sendFired = async () => page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const btns = Array.from(document.querySelectorAll('button')).filter(isVisible);
            const hasStop = btns.some(b => {
                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                return txt === 'stop' || aria.includes('stop') || txt === 'cancel';
            });
            const hasSpinner = Array.from(document.querySelectorAll('mat-spinner, [class*="spinner"], mat-progress-bar')).some(isVisible);
            return hasStop || hasSpinner;
        });

        if (sendCoords && sendCoords.cx > 0 && sendCoords.cy > 0) {
            console.log(`      📤 Clicked Send/Create button at [${sendCoords.cx}, ${sendCoords.cy}] (${sendCoords.label})`);
            try { await page.mouse.click(sendCoords.cx, sendCoords.cy); } catch {}
        } else {
            console.log(`      📤 Triggering submission via Cmd+Enter / Enter key...`);
            await page.keyboard.press('Meta+Enter');
            await page.keyboard.press('Control+Enter');
        }

        await page.waitForTimeout(2000);
        for (let r = 1; r <= 3 && !(await _sendFired()); r++) {
            console.warn(`      ⚠️ Send not registered — retrying click on Start generation button (${r}/3)...`);
            const c = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const b = Array.from(document.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
                    const txt = (b.innerText || b.textContent || '').trim();
                    return aria === 'start generation' || txt === 'arrow_forward';
                });
                if (!b) return null;
                const rc = b.getBoundingClientRect();
                return { cx: Math.round(rc.left + rc.width / 2), cy: Math.round(rc.top + rc.height / 2) };
            });
            if (c) {
                try { await page.mouse.click(c.cx, c.cy); } catch {}
            } else {
                await page.keyboard.press('Meta+Enter');
            }
            await page.waitForTimeout(1500);
        }
        await page.waitForTimeout(1000);

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

        const retryAvatarName = (this._lastAvatarName && String(this._lastAvatarName).trim()) || 'me';
        const retryMediaUrl = this._lastMediaUrl || '';

        if (!avatarStillAttached) {
            console.log(`      👤 Avatar not in prompt bar — re-adding avatar "${retryAvatarName}" (REQUIRED)...`);
            await this._addAvatarToPrompt(page, retryAvatarName);
            await page.waitForTimeout(1000);
        } else {
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

    async _captureLastFrameFromGeneratedVideo(page, itemId = null) {
        console.log(`\n[Frame Capture] 📸 Resolving last frame of generated video...`);
        const frame = lastExtractedFrameUrl || lastExtractedFramePath;
        if (frame) {
            console.log(`      ✅ Last frame already extracted via FFmpeg: ${frame}`);
            return frame;
        }
        return true;
    }

    async _addLastFrameFromUploadsToPrompt(page, previousSceneLastFrameUrl = null, itemId = null) {
        console.log(`\n[Scene Media] 🖼️ Attaching last scene frame to prompt...`);
        const frameToUpload = previousSceneLastFrameUrl || lastExtractedFramePath || lastExtractedFrameUrl;
        if (frameToUpload) {
            console.log(`      ⬆️ Uploading previous scene last frame to Flow: ${frameToUpload}`);
            return await this._uploadMediaFromUrl(page, frameToUpload, itemId);
        }
        console.warn(`      ⚠️ No previous scene last frame URL/path available!`);
        return false;
    }


    async _extractResult(page, type, itemId, preExistingUrls = []) {
        const isVideoType = type === 'video' || type === 'avatar_video';
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
                                         (bodyText.includes('Thinking...') || bodyText.includes('Thinking…')) ||
                                         bodyText.includes('Analyzing');

                let statusText = '';
                const cleanBodyForStatus = bodyText.replace(/Thinking level/gi, '');
                const statusMatch = cleanBodyForStatus.match(/(Generating[^\.\n]*|Creating[^\.\n]*|Rendering[^\.\n]*|Thinking[^\.\n]*|Analyzing[^\.\n]*|Processing[^\.\n]*)/i);
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

                const isVideo = targetType === 'video' || targetType === 'avatar_video';

                // Scan image elements (only large ones — not icons/UI)
                // For video jobs: NEVER treat flow-image-tile or standalone images as target assets!
                document.querySelectorAll('img').forEach((img) => {
                    const src = img.getAttribute('src') || '';
                    if (src && !isProfileOrUi(src)) {
                        const isInsideImageTile = !!img.closest('flow-image-tile, [class*="image-tile"]');
                        if (isVideo && isInsideImageTile) {
                            return; // Strictly ignore image tiles during video generation
                        }
                        const w = img.clientWidth || img.naturalWidth || 0;
                        const h = img.clientHeight || img.naturalHeight || 0;
                        if ((w === 0 || w >= 150) && (h === 0 || h >= 150)) {
                            if (!isVideo) {
                                newMediaUrls.push(src);
                                if (!newImageUrl) newImageUrl = src;
                            }
                        }
                    }
                });

                // Detect Google's "Something went wrong" OR "The agent failed" OR "You are asking too fast" error UI
                const hasTryAgainBtn = !!Array.from(document.querySelectorAll('button')).find(b =>
                    b.offsetWidth > 0 && (b.innerText || b.textContent || '').trim().toLowerCase() === 'try again'
                );
                const isRateLimitError = bodyText.includes('asking too fast') ||
                    bodyText.includes('too fast') ||
                    bodyText.includes('Please slow down') ||
                    bodyText.includes('slow down and try again');

                const isGoogleError = hasTryAgainBtn && !isRateLimitError && (
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

                // Check if any video tile is currently actively generating (has spinner/progress inside it)
                const videoTileHasSpinner = newVideoTiles.some(t => {
                    return !!t.querySelector('[role="progressbar"], progress, [class*="spinner"], [class*="loading"], [class*="loader"], mat-progress-bar, mat-spinner');
                });

                // Collect thumbnail URLs from video tiles as the preview thumbnail
                const videoTileUrl = newVideoTiles.length > 0
                    ? (newVideoTiles[0].querySelector('img[src]')?.getAttribute('src') || null)
                    : (chatVideoContainers.length > 0
                        ? (chatVideoContainers[0].querySelector('img[src]')?.getAttribute('src') || null)
                        : null);

                // For video jobs: newMediaUrls should ONLY contain video thumbnail or real video url
                if (videoTileUrl && !newMediaUrls.includes(videoTileUrl)) newMediaUrls.push(videoTileUrl);

                return {
                    currentPct,
                    statusText,
                    hasActiveSpinner,
                    isGeneratingText,
                    videoTileHasSpinner,
                    mediaUrls: Array.from(new Set(newMediaUrls)),
                    videoUrl: newVideoUrl,      // blob: or http: URL from <video> if mounted
                    imageUrl: isVideo ? null : (newImageUrl || videoTileUrl),      // Image job: standalone <img> URL; Video job: null
                    thumbnailUrl: videoTileUrl,
                    videoTileCount: newVideoTiles.length + chatVideoContainers.length,  // flow-video-tile count
                    text: bodyText.substring(0, 3000),
                    isCancelled: bodyText.includes('Response was cancelled') || bodyText.includes('response was cancelled'),
                    isRateLimitError,
                    isGoogleError,
                    hasTryAgainBtn,
                };
            }, { targetType: type, excludedUrls: Array.from(excludedUrlSet) });

            // ── GOOGLE RATE LIMIT CHECK: "You are asking too fast. Please slow down and try again." ──
            if (liveState.isRateLimitError) {
                console.warn(`      ⏳ Google Flow Rate Limit detected: "You are asking too fast. Please slow down and try again."`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 4) {
                    throw new Error(`[GoogleFX] ❌ Google Flow Rate Limit ("You are asking too fast") persisted after 4 retries — aborting.`);
                }
                console.log(`      ⏳ Cooling down for 25 seconds before retrying (attempt ${retryCount}/4)...`);
                if (itemId) {
                    try {
                        const jobsCol = getJobsCollection();
                        await jobsCol.updateOne(
                            { itemId },
                            {
                                $set: {
                                    progressStatus: `Rate limit hit ("Asking too fast"). Cooling down 25s before retry ${retryCount}/4...`,
                                    updatedAt: new Date(),
                                }
                            }
                        );
                    } catch (e) {}
                }
                await page.waitForTimeout(25000);

                // Auto-click the "Try again" button in the chat bubble
                const clickedTryAgain = await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b =>
                        b.offsetWidth > 0 && (b.innerText || b.textContent || '').trim().toLowerCase() === 'try again'
                    );
                    if (btn) {
                        btn.click();
                        return true;
                    }
                    return false;
                });
                if (clickedTryAgain) {
                    console.log(`      🖱️ Clicked "Try again" button after 25s cooldown.`);
                } else {
                    console.log(`      🔄 "Try again" button not found — resubmitting prompt...`);
                    await this._resubmitPromptForRetry(page);
                }
                await page.waitForTimeout(4000);
                lastActivityTime = Date.now();
                stuckProgressCount = 0;
                lastProgressPct = -1;
                continue;
            }

            // ── GOOGLE ERROR CHECK: "Something went wrong" / "The agent failed" / "Rendering failure" ──
            if (liveState.isGoogleError || liveState.isRenderingFailure) {
                const errLabel = liveState.isRenderingFailure ? '"Rendering failure"' : '"Agent failed / Something went wrong"';
                console.warn(`      ⚠️ ${errLabel} detected in Google Flow UI — immediate retry in SAME project!`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 4) {
                    throw new Error(`[GoogleFX] ❌ ${errLabel} error repeated 4 times in same project — aborting.`);
                }
                console.log(`      🔄 Google error retry ${retryCount}/4 — restoring state and re-submitting in SAME project...`);

                // Auto-click the "Try again" button to reset the error state if present
                const clicked = await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b =>
                        b.offsetWidth > 0 && (b.innerText || b.textContent || '').trim().toLowerCase() === 'try again'
                    );
                    if (btn) {
                        btn.click();
                        return true;
                    }
                    return false;
                });

                if (clicked) {
                    console.log(`      🖱️ Clicked "Try again" button.`);
                } else {
                    console.log(`      🔄 "Try again" button not found — re-submitting prompt in same project...`);
                    await this._resubmitPromptForRetry(page);
                }
                await page.waitForTimeout(4000);

                stuckProgressCount = 0;
                lastProgressPct = -1;
                lastActivityTime = Date.now();
                continue;
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
                    // Only count as stuck if spinner/generating text is no longer active (DOM idle/hung),
                    // or if total generation time has exceeded 4 minutes (240s)
                    if (!liveState.hasActiveSpinner && !liveState.isGeneratingText && (effectivePct >= 95 || (effectivePct === lastProgressPct && effectivePct >= 90))) {
                        stuckProgressCount++;
                        console.log(`      ⏳ Generation holding at ${effectivePct}% [stuck check ${stuckProgressCount}/10] (${elapsedSec}s)`);
                    } else if (elapsedSec > 240) {
                        stuckProgressCount++;
                        console.log(`      ⏳ Generation exceeded 240s [stuck check ${stuckProgressCount}/10] (${elapsedSec}s)`);
                    } else {
                        stuckProgressCount = 0;
                    }

                    lastProgressPct = effectivePct;
                    lastActivityTime = Date.now();
                }
            } else {
                if (elapsedSec > 240) {
                    stuckProgressCount++;
                }
            }

            // ── STUCK PROGRESS CHECK: Retry prompt in SAME project (NO new project) ──
            if (stuckProgressCount >= 10) {
                console.warn(`      ⚠️ Generation progress stuck at ${effectivePct || 95}% ${liveState.statusText ? `(${liveState.statusText})` : ''} for 10 checks (~50s) — retrying in SAME project!`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 4) {
                    throw new Error(`[GoogleFX] ❌ Generation stuck repeatedly after ${retryCount} retries in same project.`);
                }
                console.log(`      🔄 Retrying stuck generation (attempt ${retryCount}/4) — resubmitting prompt in SAME project...`);
                stuckProgressCount = 0;
                lastProgressPct = -1;
                await this._resubmitPromptForRetry(page);
                lastActivityTime = Date.now();
                continue;
            }

            // CRITICAL GATE: COMPLETED when a new generated asset appears
            // For VIDEO type: Must ONLY be considered completed when a VIDEO asset is ready!
            // Never treat an image (or flow-image-tile) as video completion!
            const targetAsset = isVideoType
                ? (liveState.videoUrl || (liveState.videoTileCount > 0 ? (liveState.thumbnailUrl || 'flow-video-tile') : null))
                : (liveState.imageUrl || liveState.thumbnailUrl || null);

            const hasCompletedAsset = isVideoType
                ? (liveState.videoTileCount > 0 || !!liveState.videoUrl)
                : (liveState.mediaUrls.length > 0 || !!liveState.imageUrl);

            // Always update activity time when target media is found
            if (hasCompletedAsset) {
                lastActivityTime = Date.now();
                consecutiveMediaFound++;
            } else {
                consecutiveMediaFound = 0;
            }

            const spinnerGone = !liveState.hasActiveSpinner && (!isVideoType || !liveState.videoTileHasSpinner);
            const hadHighProgress = lastProgressPct >= 90;
            const videoFoundAfterProgress = targetAsset && hadHighProgress;
            // Safety net: if video found 3+ consecutive polls but spinner still detected (false positive)
            const persistentMediaFound = targetAsset && consecutiveMediaFound >= 3;

            if (targetAsset && hasCompletedAsset && (spinnerGone || videoFoundAfterProgress || persistentMediaFound)) {
                const reason = spinnerGone ? 'spinner gone' : hadHighProgress ? 'progress>=90%' : `seen ${consecutiveMediaFound} polls`;
                const bestUrl = targetAsset || (isVideoType ? `flow-video-tile detected (${liveState.videoTileCount} tile(s))` : 'image asset detected');
                console.log(`      ✨ GENERATION COMPLETED! ${isVideoType ? liveState.videoTileCount + ' video tile(s)' : liveState.mediaUrls.length + ' asset(s)'} in ${elapsedSec}s. [${reason}]`);
                console.log(`      🔗 Result URL: ${bestUrl}`);
                resultData = {
                    videoUrl: isVideoType ? (liveState.videoUrl || liveState.thumbnailUrl || null) : null,
                    imageUrl: !isVideoType ? (liveState.imageUrl || liveState.thumbnailUrl) : null,
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
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const canvasTiles = Array.from(document.querySelectorAll('flow-video-tile, flow-grid-tile-container, flow-tile-container, [class*="video-tile"]'))
                            .filter(t => {
                                if (!isVisible(t)) return false;
                                const r = t.getBoundingClientRect();
                                return r.left >= 100 && r.left < window.innerWidth * 0.7 && r.top >= 70 && r.width >= 80 && r.height >= 80;
                            });

                        let targetTile = canvasTiles.find(t => {
                            const img = t.querySelector('img[src]');
                            if (!img) return false;
                            const src = img.getAttribute('src') || '';
                            return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                        });

                        if (!targetTile && canvasTiles.length > 0) {
                            targetTile = canvasTiles[canvasTiles.length - 1];
                        }

                        if (!targetTile) {
                            const allTiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]')).filter(isVisible);
                            targetTile = allTiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            }) || allTiles[allTiles.length - 1] || null;
                        }

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
                            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                            const canvasTiles = Array.from(document.querySelectorAll('flow-video-tile, flow-grid-tile-container, flow-tile-container, [class*="video-tile"]'))
                                .filter(t => {
                                    if (!isVisible(t)) return false;
                                    const r = t.getBoundingClientRect();
                                    return r.left >= 100 && r.left < window.innerWidth * 0.7 && r.top >= 70 && r.width >= 80 && r.height >= 80;
                                });

                            let targetTile = canvasTiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            });

                            if (!targetTile && canvasTiles.length > 0) {
                                targetTile = canvasTiles[canvasTiles.length - 1];
                            }

                            if (!targetTile) {
                                const allTiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]')).filter(isVisible);
                                targetTile = allTiles.find(t => {
                                    const img = t.querySelector('img[src]');
                                    if (!img) return false;
                                    const src = img.getAttribute('src') || '';
                                    return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                                }) || allTiles[allTiles.length - 1] || null;
                            }

                            if (!targetTile) return null;
                            const r = targetTile.getBoundingClientRect();
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

                        // Find the 3-dot button strictly in the top-right area of the video tile (no loose fallback to image tiles)
                        const menuBtnClicked = await page.evaluate(({ excludedUrls }) => {
                            const excluded = new Set(excludedUrls || []);
                            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                            const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                            const canvasTiles = Array.from(document.querySelectorAll('flow-video-tile, flow-grid-tile-container, flow-tile-container, [class*="video-tile"]'))
                                .filter(t => {
                                    if (!isVisible(t)) return false;
                                    const r = t.getBoundingClientRect();
                                    return r.left >= 100 && r.left < window.innerWidth * 0.7 && r.top >= 70 && r.width >= 80 && r.height >= 80;
                                });

                            let targetTile = canvasTiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            });
                            if (!targetTile && canvasTiles.length > 0) targetTile = canvasTiles[canvasTiles.length - 1];

                            const tBox = targetTile ? targetTile.getBoundingClientRect() : null;
                            if (!tBox) return false;

                            const btn = buttons.find(b => {
                                if (!b.offsetWidth) return false;
                                const r = b.getBoundingClientRect();
                                if (r.left < tBox.left || r.right > tBox.right + 20 || r.top < tBox.top - 10 || r.bottom > tBox.bottom) {
                                    return false;
                                }
                                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                return txt === 'more_vert' || txt === 'more_horiz' || txt === '⋮' ||
                                    aria.includes('more') || aria.includes('menu');
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
                                        return (txt.includes('720p') || txt.includes('Original size')) && !txt.includes('GIF');
                                    }) || items.find(el => {
                                        if (!el.offsetWidth) return false;
                                        const txt = (el.innerText || el.textContent || '').trim();
                                        return txt.includes('1080p');
                                    }) || null;
                                });

                                if (subItem720 && subItem720.asElement()) {
                                    console.log(`      📥 Found "720p (Original size)" option! Triggering browser download event...`);
                                    const [download] = await Promise.all([
                                        page.waitForEvent('download', { timeout: 35000 }).catch(() => null),
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
                            console.warn(`      ⚠️ 3-dot menu button not found directly on video tile`);
                        }
                    } catch (menuErr) {
                        console.warn(`      ⚠️ Layer 2 3-dot menu download error: ${menuErr.message}`);
                    }
                }

                // ─────────────────────────────────────────────────────────────
                // LAYER 3: Click Play/Video Icon (▶) -> Open Editor/Player -> Toolbar Download 720p
                // ─────────────────────────────────────────────────────────────
                if (!downloaded) {
                    try {
                        console.log(`      🎬 Layer 3: Clicking play icon / video tile to open player & download...`);
                        const tileClicked = await page.evaluate(({ excludedUrls }) => {
                            const excluded = new Set(excludedUrls || []);
                            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                            const canvasTiles = Array.from(document.querySelectorAll('flow-video-tile, flow-grid-tile-container, flow-tile-container, [class*="video-tile"]'))
                                .filter(t => {
                                    if (!isVisible(t)) return false;
                                    const r = t.getBoundingClientRect();
                                    return r.left >= 100 && r.left < window.innerWidth * 0.7 && r.top >= 70 && r.width >= 80 && r.height >= 80;
                                });

                            let tile = canvasTiles.find(t => {
                                const img = t.querySelector('img[src]');
                                if (!img) return false;
                                const src = img.getAttribute('src') || '';
                                return src && !excluded.has(src) && !src.includes('googleusercontent.com') && !src.includes('gstatic');
                            });
                            if (!tile && canvasTiles.length > 0) tile = canvasTiles[canvasTiles.length - 1];
                            if (!tile) {
                                const allTiles = Array.from(document.querySelectorAll('flow-video-tile, [class*="video-tile"], [aria-label="Open video in editor"]')).filter(isVisible);
                                tile = allTiles[allTiles.length - 1] || null;
                            }

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
                            const innerImg = tile.querySelector('img');
                            if (innerImg) {
                                innerImg.click();
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
                                // Try toolbar download button in editor -> click it to open quality menu
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
                                    console.log(`      📥 Clicking toolbar download/export button in editor to open options...`);
                                    await editorDlBtn.asElement().click();
                                    await page.waitForTimeout(800);

                                    // Find "720p (Original size)" or "Original size" dropdown option
                                    const subItem720 = await page.evaluateHandle(() => {
                                        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, div, span'));
                                        return items.find(el => {
                                            if (!el.offsetWidth) return false;
                                            const txt = (el.innerText || el.textContent || '').trim();
                                            return (txt.includes('720p') || txt.includes('Original size')) && !txt.includes('GIF');
                                        }) || items.find(el => {
                                            if (!el.offsetWidth) return false;
                                            const txt = (el.innerText || el.textContent || '').trim();
                                            return txt.includes('1080p');
                                        }) || null;
                                    });

                                    if (subItem720 && subItem720.asElement()) {
                                        console.log(`      📥 Found "720p (Original size)" dropdown option! Triggering browser download...`);
                                        const [download] = await Promise.all([
                                            page.waitForEvent('download', { timeout: 35000 }).catch(() => null),
                                            subItem720.asElement().click(),
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
                                                    console.log(`      💾 ✅ Video verified and saved from editor toolbar 720p: ${localPath} (${Math.round(fileBuf.length / 1024)}KB)`);
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
                                        } else {
                                            console.warn(`      ⚠️ Download event not fired after clicking 720p in editor`);
                                        }
                                    } else {
                                        console.warn(`      ⚠️ "720p (Original size)" option not found in editor menu dropdown`);
                                    }
                                }
                            }

                            // Return back to project canvas cleanly
                            try {
                                await page.evaluate(() => {
                                    const backBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                        return aria.includes('back') || txt.includes('arrow_back') || txt.includes('back');
                                    });
                                    if (backBtn) backBtn.click();
                                });
                                await page.waitForTimeout(1000);
                            } catch (e) {}
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

            // Step 4: For video generation, extract the exact last frame via FFmpeg and preserve local video copy for multi-scene concat
            if (downloaded && resultData && resultData.downloadPath && isVideoType && existsSync(resultData.downloadPath)) {
                try {
                    // 1. Preserve local copy of MP4 on disk for concatenation/merging
                    const localVideoFilename = `${itemId || 'flow_video'}_local.mp4`;
                    const persistentVideoPath = path.join(downloadDir, localVideoFilename);
                    try {
                        copyFileSync(resultData.downloadPath, persistentVideoPath);
                        resultData.localVideoPath = persistentVideoPath;
                        console.log(`      💾 [Local MP4] Preserved local video copy: ${persistentVideoPath}`);
                    } catch (copyErr) {
                        resultData.localVideoPath = resultData.downloadPath;
                    }

                    // 2. Extract last frame from video using FFmpeg
                    const lastFrameFilename = `${itemId || 'flow'}_last_frame_${Date.now()}.png`;
                    const lastFrameLocalPath = path.join(downloadDir, lastFrameFilename);
                    execSync(`ffmpeg -y -sseof -0.5 -i "${resultData.downloadPath}" -frames:v 1 -q:v 2 "${lastFrameLocalPath}"`, { stdio: 'pipe' });
                    console.log(`      📸 [FFmpeg] Extracted last frame: ${lastFrameLocalPath}`);
                    resultData.lastFramePath = lastFrameLocalPath;

                    // 3. Upload last frame to R2
                    const frameKey = `ai-content/${itemId || 'gen_unknown'}/${lastFrameFilename}`;
                    const r2FrameResult = await uploadToR2(lastFrameLocalPath, frameKey, 'image/png');
                    if (r2FrameResult && r2FrameResult.r2Url) {
                        resultData.lastFrameUrl = r2FrameResult.r2Url;
                        console.log(`      ☁️ ✅ Last frame uploaded to R2: ${resultData.lastFrameUrl}`);
                    } else {
                        resultData.lastFrameUrl = lastFrameLocalPath;
                    }
                    lastExtractedFramePath = lastFrameLocalPath;
                    lastExtractedFrameUrl = resultData.lastFrameUrl;
                } catch (ffmpegErr) {
                    console.warn(`      ⚠️ FFmpeg last frame extraction / local video save warning: ${ffmpegErr.message}`);
                }
            }

            // Step 5: Upload downloaded asset to Cloudflare R2 under ai-content/${itemId}/${filename} & cleanup local file
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

