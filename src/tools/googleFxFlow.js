// src/tools/googleFxFlow.js
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, createWriteStream } from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseTool } from '../mcp/baseTool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { uploadToR2 } from '../services/r2Service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_FX_URL = 'https://labs.google/fx/tools/flow';

let sharedContext = null;
let isInitializing = false;

export async function closeSharedContext() {
    if (sharedContext) {
        try {
            await sharedContext.close();
        } catch (e) {}
        sharedContext = null;
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

            console.log(`\n[GoogleFX] 🚀 Launching persistent browser context from: ${profileDir}`);
            
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
        console.log(`🆔  Job ID : ${itemId || 'N/A'}`);
        console.log(`🎬  Type   : ${type.toUpperCase()}`);
        console.log(`💬  Prompt : "${cleanPrompt.substring(0, 100)}${cleanPrompt.length > 100 ? '...' : ''}"`);
        console.log(`⚙️   Settings: ${JSON.stringify(settings)}`);
        if (effectiveMediaUrl) console.log(`🖼️   Media URL: ${effectiveMediaUrl}`);
        if (effectiveAvatarName) console.log(`👤  Avatar Name: ${effectiveAvatarName}`);
        logger.info(`[GoogleFxFlowTool] Executing (${type}) [${itemId}]: "${cleanPrompt.substring(0, 80)}..."`);

        console.log(`\n[1/5] 🚀 Getting shared browser context...`);
        let context = await this._getSharedContext();
        let page;

        try {
            page = await context.newPage();
        } catch (err) {
            console.warn(`[GoogleFX] ⚠️ Context error, retrying...`);
            sharedContext = null;
            context = await this._getSharedContext();
            page = await context.newPage();
        }

        try {
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

            // 4. Add account Avatar to prompt
            if (effectiveAvatarName) {
                console.log(`\n[4/7] 👤 [STEP 1/2] Selecting Avatar "${effectiveAvatarName}" and adding to prompt...`);
                await this._addAvatarToPrompt(page, effectiveAvatarName);
            }

            // 5. Upload reference image/media to prompt
            let uploadedMediaUrls = [];
            if (effectiveMediaUrl) {
                console.log(`\n[5/7] 🖼️ [STEP 2/2] Uploading reference media from URL, waiting for upload to finish...`);
                uploadedMediaUrls = await this._uploadMediaFromUrl(page, effectiveMediaUrl, itemId);
                console.log(`      🔒 Uploaded media URLs captured for exclusion: ${uploadedMediaUrls.length}`);
            }

            // 6. Open Agent Settings → configure (aspect ratio, model, duration, Never) → Save
            console.log(`\n[6/7] ⚙️ Opening Agent Settings and applying configuration...`);
            await this._applyAgentSettings(page, actualGenType, settings);

            // NOTE: _applyResultFilter() is intentionally NOT called here.
            // Calling it right after upload would fire an Escape keypress that closes
            // the upload panel while it is still transitioning → breaks the upload flow.
            // The filter is applied inside _extractResult() before polling begins.

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
            console.log(`\n[7/7] ⌨️ Submitting prompt into generation bar...`);
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
            sharedContext = null;
            throw err;
        } finally {
            if (page && !page.isClosed()) {
                try {
                    await page.close();
                    console.log(`      🔒 Browser tab closed cleanly after job completion.`);
                } catch (closeErr) {
                    console.warn(`      ⚠️ Warning closing browser tab: ${closeErr.message}`);
                }
            }
            try {
                await closeSharedContext();
                console.log(`      🚪 Browser instance closed completely after request completion.`);
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
        await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const containers = Array.from(document.querySelectorAll(
                '.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'
            )).filter(c => isVisible(c) && !c.closest('.sc-e4f4e472-3'));
            const promptBar = containers.length > 0 ? containers[containers.length - 1] : document.body;

            const agentBtn = promptBar.querySelector('button.sc-59223abb-3, button[class*="59223abb"]')
                || Array.from(promptBar.querySelectorAll('button')).find(b =>
                    (b.innerText || b.textContent || '').trim() === 'Agent'
                );

            if (agentBtn) {
                const cls = agentBtn.className || '';
                const isOn = cls.includes('bdRbOx')
                    || agentBtn.getAttribute('aria-pressed') === 'true'
                    || agentBtn.getAttribute('aria-checked') === 'true'
                    || agentBtn.getAttribute('data-state') === 'on';
                if (!isOn) {
                    console.log('[AgentMode] Clicking Agent pill to enable agent mode...');
                    if (window.__highlight) window.__highlight(agentBtn);
                    agentBtn.click();
                    agentBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                } else {
                    console.log('[AgentMode] Agent mode already enabled.');
                }
            } else {
                console.warn('[AgentMode] Agent pill button not found in prompt bar.');
            }
        });
        await page.waitForTimeout(1200);

        // Verify agent mode is on
        const isAgentOn = await page.evaluate(() => {
            const containers = Array.from(document.querySelectorAll(
                '.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'
            )).filter(c => c.offsetWidth > 0 && !c.closest('.sc-e4f4e472-3'));
            const promptBar = containers.length > 0 ? containers[containers.length - 1] : document.body;
            const agentBtn = promptBar.querySelector('button.sc-59223abb-3, button[class*="59223abb"]')
                || Array.from(promptBar.querySelectorAll('button')).find(b =>
                    (b.innerText || b.textContent || '').trim() === 'Agent'
                );
            if (!agentBtn) return false;
            const cls = agentBtn.className || '';
            return cls.includes('bdRbOx')
                || agentBtn.getAttribute('aria-pressed') === 'true'
                || agentBtn.getAttribute('aria-checked') === 'true'
                || agentBtn.getAttribute('data-state') === 'on';
        });

        if (isAgentOn) {
            console.log(`      ✅ Agent mode confirmed ON`);
        } else {
            console.warn(`      ⚠️ Agent mode may not be active — attempting fallback click`);
            const coords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const containers = Array.from(document.querySelectorAll(
                    '.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'
                )).filter(c => isVisible(c) && !c.closest('.sc-e4f4e472-3'));
                const promptBar = containers.length > 0 ? containers[containers.length - 1] : document.body;
                const agentBtn = promptBar.querySelector('button.sc-59223abb-3, button[class*="59223abb"]')
                    || Array.from(promptBar.querySelectorAll('button')).find(b =>
                        (b.innerText || b.textContent || '').trim() === 'Agent'
                    );
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
     * Class: sc-c4e423a0-3, Icon text: "expand_content"
     */
    async _clickExpandButton(page) {
        console.log(`      🔲 Checking Expand button to open Agent panel...`);

        // Check if panel is already expanded
        const alreadyExpanded = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const panelHeader = Array.from(document.querySelectorAll('[class*="sc-"]'))
                .find(el => isVisible(el) && (el.innerText || '').toLowerCase().includes('session') && el.getBoundingClientRect().right > window.innerWidth * 0.7);
            return !!panelHeader;
        });

        if (alreadyExpanded) {
            console.log(`      ✅ Agent panel is already expanded`);
            return;
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            const coords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                // Strategy 1: Find by class sc-c4e423a0-3 / ewxUEp and expand_content icon
                let btn = Array.from(document.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const cls = b.className || '';
                    const hasClassMatch = cls.includes('sc-c4e423a0-3') || cls.includes('ewxUEp');
                    const hasExpandIcon = Array.from(b.querySelectorAll('*'))
                        .some(el => (el.textContent || '').trim() === 'expand_content' || (el.textContent || '').trim() === 'Expand');
                    return hasClassMatch && hasExpandIcon;
                });

                // Strategy 2: Any button with expand_content icon
                if (!btn) {
                    btn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        return Array.from(b.querySelectorAll('*'))
                            .some(el => (el.textContent || '').trim() === 'expand_content');
                    });
                }

                // Strategy 3: Find by span text "Expand"
                if (!btn) {
                    btn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        const spans = Array.from(b.querySelectorAll('span'));
                        return spans.some(s => (s.textContent || '').trim() === 'Expand');
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
                console.log(`      🖱️ Clicking Expand button at [${coords.cx}, ${coords.cy}] (attempt ${attempt}/3)...`);
                try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                await page.waitForTimeout(1500);

                // Verify the panel opened
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
            } else {
                console.warn(`      ⚠️ Expand button not found/visible (attempt ${attempt}/3)`);
                await page.waitForTimeout(800);
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
    async _applyAgentSettings(page, type, settings = {}) {
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

            // ── STEP 2: Find & Click Settings (tune) Icon ───────────────────────
            if (panelOpened) {
                console.log(`      ✅ Agent Settings drawer is already open`);
            } else {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const coords = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const isSettingsTarget = b => {
                            if (!b) return false;
                            const txt = (b.innerText || b.textContent || '').toLowerCase().trim();
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            if (txt.includes('expand') || aria.includes('expand')) return false;
                            if (txt.includes('instruction') || aria.includes('instruction')) return false;
                            if (txt === 'arrow_forward' || aria === 'create' || aria === 'send') return false;
                            return true;
                        };

                        const containers = Array.from(document.querySelectorAll(
                            '.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'
                        )).filter(c => isVisible(c) && !c.closest('.sc-e4f4e472-3'));
                        const promptContainer = containers.length > 0 ? containers[containers.length - 1] : null;

                        let btn = null;
                        if (promptContainer) {
                            btn = Array.from(promptContainer.querySelectorAll('button'))
                                .filter(isSettingsTarget)
                                .find(b => isVisible(b) && Array.from(b.querySelectorAll('*')).some(el => (el.textContent || '').trim() === 'tune'));
                        }
                        if (!btn) {
                            btn = Array.from(document.querySelectorAll('button'))
                                .filter(isSettingsTarget)
                                .find(b => isVisible(b) && (b.className || '').includes('sc-c4e423a0-1'));
                        }

                        if (btn) {
                            if (window.__highlight) window.__highlight(btn);
                            btn.scrollIntoView({ block: 'center', inline: 'nearest' });
                            const r = btn.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }
                        return null;
                    });

                    if (coords && coords.cx > 0 && coords.cy > 0) {
                        console.log(`      ⚙️ Settings tune button clicked at [${coords.cx}, ${coords.cy}] (attempt ${attempt})`);
                        try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                    }
                    await page.waitForTimeout(1000);

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

            // ── STEP 3: Set "Confirm before generating" → Never ──────────────────
            let neverConfirmed = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const coords = await page.evaluate(() => {
                    const radios = Array.from(document.querySelectorAll('button[role="radio"], [role="radio"]'));
                    const neverRadio = radios.find(r => r.getAttribute('value') === 'AUTO_APPROVE' || (r.innerText || r.textContent || '').includes('Never'));
                    if (neverRadio) {
                        if (window.__highlight) window.__highlight(neverRadio);
                        neverRadio.click();
                        const r = neverRadio.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                });

                if (coords && coords.cx > 0 && coords.cy > 0) {
                    try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                }
                await page.waitForTimeout(500);

                neverConfirmed = await page.evaluate(() => {
                    const radios = Array.from(document.querySelectorAll('button[role="radio"], [role="radio"]'));
                    const neverRadio = radios.find(r => r.getAttribute('value') === 'AUTO_APPROVE' || (r.innerText || r.textContent || '').includes('Never'));
                    return neverRadio && (neverRadio.getAttribute('data-state') === 'checked' || neverRadio.getAttribute('aria-checked') === 'true');
                });

                if (neverConfirmed) {
                    console.log(`      ✅ Set confirmation → Never (verified)`);
                    break;
                }
            }

            // ── STEP 4: Target Section ("Video generation default") & Apply Settings ───────
            const isVideoJob = type === 'video' || type === 'avatar_video';
            const arVal = settings.aspectRatio || settings.aspect_ratio || settings.ratio || '9:16';
            const targetAr = String(arVal).trim();

            // HARDCODED: count/multiplier is ALWAYS x1 as requested by user
            const targetCountText = 'x1';

            const rawModelStr = String(settings.model || 'Omni Flash').trim();

            const normalizeModel = (m, isVid) => {
                const l = m.toLowerCase();
                if (!isVid) {
                    if (l.includes('banana 2') || l.includes('nano 2')) return 'Nano Banana 2';
                    if (l.includes('imagen')) return 'Imagen 3';
                } else {
                    if (l.includes('omni') || l.includes('flash')) return 'Omni Flash';
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
            const dropdownCoords = await page.evaluate(({ isVid }) => {
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
                    if (window.__highlight) window.__highlight(dropdownBtn);
                    const r = dropdownBtn.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            }, { isVid: isVideoJob });

            if (dropdownCoords && dropdownCoords.cx > 0 && dropdownCoords.cy > 0) {
                console.log(`      🖱️ Mouse clicking Model dropdown at [${dropdownCoords.cx}, ${dropdownCoords.cy}]...`);
                try { await page.mouse.click(dropdownCoords.cx, dropdownCoords.cy); } catch {}
                await page.waitForTimeout(1200);

                const optionCoords = await page.evaluate((modelName) => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const searchLower = modelName.toLowerCase();
                    const options = Array.from(document.querySelectorAll('button[role="menuitem"], [role="option"], [role="menuitemradio"], button, div'))
                        .filter(el => isVisible(el) && (el.innerText || el.textContent || '').trim().length > 0);
                    const match = options.find(el => {
                        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                        return txt === searchLower || txt.includes(searchLower);
                    });
                    if (match) {
                        if (window.__highlight) window.__highlight(match);
                        const r = match.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                }, targetModelName);

                if (optionCoords && optionCoords.cx > 0 && optionCoords.cy > 0) {
                    console.log(`      🖱️ Mouse clicking Model option "${targetModelName}" at [${optionCoords.cx}, ${optionCoords.cy}]...`);
                    try { await page.mouse.click(optionCoords.cx, optionCoords.cy); } catch {}
                    console.log(`      ✅ Selected Model "${targetModelName}" for ${isVideoJob ? 'Video' : 'Image'} generation default`);
                } else {
                    console.warn(`      ⚠️ Model option "${targetModelName}" not found in dropdown menu`);
                }
            } else {
                console.warn(`      ⚠️ Could not open Model dropdown in ${isVideoJob ? 'Video' : 'Image'} generation default`);
            }
            await page.waitForTimeout(1000);

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
            const coords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));

                // Primary: find '+'/add_2/Create button in the right-side Agent panel
                let addBtn = allBtns.find(b => {
                    if (!isVisible(b)) return false;
                    const r = b.getBoundingClientRect();
                    // Must be in RIGHT portion of screen (Agent panel) AND bottom area (panel bottom bar)
                    if (r.left < window.innerWidth * 0.6) return false;
                    if (r.top < window.innerHeight * 0.8) return false;
                    const txt = (b.innerText || b.textContent || '').trim();
                    return txt.includes('add_2') || txt === '+' || txt.includes('Create');
                });

                // Fallback 1: any '+' button in the right-side panel (relaxed y position)
                if (!addBtn) {
                    addBtn = allBtns.find(b => {
                        if (!isVisible(b)) return false;
                        const r = b.getBoundingClientRect();
                        if (r.left < window.innerWidth * 0.6) return false;
                        if (r.top < window.innerHeight * 0.7) return false;
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

                const panelOpen = await page.evaluate(() => {
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
                        const hasLoader = Array.from(document.querySelectorAll(
                            '[role="progressbar"], progress, [class*="progress"], [class*="spinner"], svg[class*="loading"], [class*="loader"], [class*="overlay"], svg circle'
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
                        lastActivityTime = Date.now();
                    }

                    // ── STRICT UPLOADING COMPLETION RULES ──
                    // 1. CANNOT BE DONE if percentage is currently active (0% - 99%)
                    // 2. CANNOT BE DONE if loaders or processing text are active
                    // 3. DONE if currentPct === 100
                    // 4. DONE if percentage reached 100% or disappeared after sawProgress AND elapsedSec >= 8
                    // 5. For long videos where no % text was rendered, MUST wait at least 35s before completing!
                    let isUploadDone = false;

                    if (uiState.currentPct === 100) {
                        isUploadDone = true;
                    } else if (uiState.currentPct === null && !uiState.hasLoader && !uiState.isProcessing) {
                        if (sawProgress && elapsedSec >= 8) {
                            isUploadDone = true;
                        } else if (!sawProgress && elapsedSec >= 35) {
                            isUploadDone = true;
                        }
                    }

                    if (isUploadDone) {
                        console.log(`      ✅ Background upload 100% completed in UI (${elapsedSec}s elapsed) — now attaching media to prompt...`);
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

        for (let round = 1; round <= 3 && !attachmentVerified; round++) {
            if (round > 1) {
                console.log(`      🔄 Round ${round}: Re-trying "Add to Prompt" click...`);
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
                }
            }

            for (let i = 0; i < 16 && !attachmentVerified; i++) {
                attachmentVerified = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                    const videos = Array.from(document.querySelectorAll('video'));
                    for (const v of videos) {
                        if (!isVisible(v)) continue;
                        const src = v.getAttribute('src') || (v.querySelector('source') && v.querySelector('source').getAttribute('src')) || '';
                        if (src.startsWith('blob:') || src.startsWith('http')) return true;
                    }

                    const promptBarSelectors = [
                        '[class*="sc-5c3af813"]', '[class*="sc-c9e4708a"]',
                        '[class*="prompt-bar"]', '[class*="input-bar"]',
                        '[class*="prompt-input"]', '[class*="bottom-bar"]',
                    ];
                    for (const sel of promptBarSelectors) {
                        const containers = Array.from(document.querySelectorAll(sel)).filter(c => isVisible(c));
                        for (const c of containers) {
                            const imgs = Array.from(c.querySelectorAll('img[src]'));
                            for (const img of imgs) {
                                if (!isVisible(img)) continue;
                                const src = img.getAttribute('src') || '';
                                if (!src.includes('googleusercontent') && !src.includes('lh3.google') && !src.includes('gstatic')) {
                                    return true;
                                }
                            }
                            const chips = c.querySelectorAll(
                                '[class*="chip"], [class*="pill"], [class*="badge"], [class*="attachment"], [class*="media-tag"], [class*="seed"]'
                            );
                            if (chips.length > 0) return true;
                        }
                    }

                    const submitBtn = Array.from(document.querySelectorAll('button')).find(b => {
                        if (!isVisible(b)) return false;
                        const txt = (b.innerText || b.textContent || '').trim();
                        return txt.includes('Create') || txt.includes('arrow_forward');
                    });
                    if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true') {
                        const addToPromptVisible = Array.from(document.querySelectorAll('button')).some(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return txt.includes('add to prompt');
                        });
                        if (!addToPromptVisible) return true;
                    }

                    return false;
                });

                if (!attachmentVerified) await page.waitForTimeout(500);
            }

            if (attachmentVerified) {
                console.log(`      ✅ Media attachment confirmed in prompt bar (round ${round})!`);
                break;
            }
        }

        if (!attachmentVerified) {
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Failed to verify media attachment in prompt bar after 3 attempts. Aborting prompt submission.`);
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
     * Opens media panel, navigates to Avatar section, selects the avatar card, clicks "Add to Prompt".
     *
     * UI Flow (verified via browser DOM inspection on 2026-08-03):
     * 1. Click the small "+" (add_2 Create) button at bottom-right of prompt bar → floating panel opens
     * 2. Left sidebar of panel: All | Images | Videos | Voices | Characters | Avatar | Uploads
     * 3. Click "Avatar" in sidebar → center shows [role="option"] cards e.g. "me / Avatar"
     * 4. Click the avatar card → right panel shows preview + "Add to Prompt" button
     * 5. Click "Add to Prompt" → avatar thumbnail appears in prompt bar (bottom-right)
     */
    async _addAvatarToPrompt(page, avatarName = 'me') {
        console.log(`\n[Avatar] 👤 Adding Avatar "${avatarName}" to prompt...`);

        // Step 1: Open the Media Drawer (the floating panel from the "+" prompt button)
        const panelOpened = await this._openMediaPanel(page);
        if (!panelOpened) {
            throw new Error('[GoogleFX] ❌ Could not open media drawer for Avatar selection.');
        }
        await page.waitForTimeout(1500);

        // Step 2: The "me / Avatar" card is ALREADY visible in the "All" tab (default)
        // when the drawer opens. From DOM inspection: [role="option"] with text "me\nAvatar"
        // at approximately x:960, y:143 in the center panel (panel starts at x:700).
        // We click it directly WITHOUT switching to "Avatar" tab.
        console.log(`      🎯 Looking for avatar card "${avatarName}" in media panel...`);

        let cardFound = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            const cardCoords = await page.evaluate((targetName) => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                // Strategy 1: [role="option"] with text matching targetName
                let card = Array.from(document.querySelectorAll('[role="option"]')).find(el => {
                    if (!isVisible(el)) return false;
                    const r = el.getBoundingClientRect();
                    if (r.left < 700) return false; // Only inside the floating panel (not app left sidebar)
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    return txt.includes(targetName.toLowerCase());
                });

                // Strategy 2: any [role="option"] inside the floating panel area (x > 700)
                if (!card) {
                    card = Array.from(document.querySelectorAll('[role="option"]')).find(el => {
                        if (!isVisible(el)) return false;
                        const r = el.getBoundingClientRect();
                        return r.left > 700 && r.top > 50;
                    });
                }

                // Strategy 3: sc-b0e5 class (avatar card class from browser DOM inspection)
                if (!card) {
                    card = Array.from(document.querySelectorAll('[class*="sc-b0e5"]')).find(el => {
                        if (!isVisible(el)) return false;
                        const r = el.getBoundingClientRect();
                        return r.left > 700 && r.top > 50;
                    });
                }

                // Strategy 4: any img or figure in the floating panel center area
                if (!card) {
                    card = Array.from(document.querySelectorAll('img, figure')).find(el => {
                        if (!isVisible(el)) return false;
                        const r = el.getBoundingClientRect();
                        return r.left > 700 && r.top > 50 && r.width > 30;
                    });
                }

                if (card) {
                    const r = card.getBoundingClientRect();
                    return {
                        cx: Math.round(r.left + r.width / 2),
                        cy: Math.round(r.top + r.height / 2),
                        text: (card.innerText || card.textContent || '').trim().substring(0, 40),
                        tag: card.tagName,
                        role: card.getAttribute('role') || '',
                    };
                }
                return null;
            }, avatarName);

            if (cardCoords) {
                console.log(`      🖱️ Clicking avatar card [${cardCoords.tag}/${cardCoords.role}] "${cardCoords.text}" at [${cardCoords.cx}, ${cardCoords.cy}]`);
                try { await page.mouse.click(cardCoords.cx, cardCoords.cy); } catch {}
                cardFound = true;
                break;
            }

            console.warn(`      ⚠️ Avatar card not found in media panel (attempt ${attempt}/5)...`);
            await page.waitForTimeout(800);
        }

        if (!cardFound) {
            throw new Error(`[GoogleFX] ❌ Avatar card "${avatarName}" not found in media panel.`);
        }
        await page.waitForTimeout(1500);

        // Step 3: Click "Add to Prompt" button
        // From DOM: BUTTON text="Add to Prompt" at x~1284, y~625 in the right preview panel
        console.log(`      ➕ Clicking "Add to Prompt" button...`);
        let addToPromptClicked = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            const addBtnCoords = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                    if (!isVisible(b)) return false;
                    const txt = (b.innerText || b.textContent || '').trim();
                    return txt === 'Add to Prompt' || txt.toLowerCase() === 'add to prompt';
                });
                if (btn) {
                    const r = btn.getBoundingClientRect();
                    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                }
                return null;
            });

            if (addBtnCoords) {
                console.log(`      🖱️ Clicking "Add to Prompt" at [${addBtnCoords.cx}, ${addBtnCoords.cy}]`);
                try { await page.mouse.click(addBtnCoords.cx, addBtnCoords.cy); } catch {}
                addToPromptClicked = true;
                break;
            }
            console.warn(`      ⚠️ "Add to Prompt" button not visible yet (attempt ${attempt}/5)...`);
            await page.waitForTimeout(800);
        }

        if (!addToPromptClicked) {
            throw new Error(`[GoogleFX] ❌ Could not click "Add to Prompt" for Avatar "${avatarName}".`);
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
        console.log(`      ⌨️ Submitting prompt into RIGHT-SIDE expanded Agent panel...`);

        // 1. Focus the textbox in the RIGHT-SIDE expanded Agent panel (x > 60% of screen)
        const focused = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

            // Right-side panel textbox
            const rightEditor = Array.from(document.querySelectorAll(
                '[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]'
            )).find(el => {
                if (!isVisible(el)) return false;
                const r = el.getBoundingClientRect();
                return r.left > window.innerWidth * 0.6;
            });

            // Fallback to any editor
            const editor = rightEditor
                || document.querySelector('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]');

            if (editor) {
                editor.scrollIntoView({ block: 'center' });
                editor.focus();
                if (window.__highlight) window.__highlight(editor);
                return true;
            }
            return false;
        });

        if (!focused) {
            console.warn(`      ⚠️ Could not focus editor via container, searching page-wide...`);
            const fallbackInput = await page.waitForSelector('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]', { timeout: 4000 });
            if (fallbackInput) {
                await fallbackInput.click();
            }
        }

        await page.waitForTimeout(300);

        // 2. Type prompt natively using keyboard API (avoids 'Element not attached to DOM' errors on React re-renders)
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(500);

        // Backup DOM text insertion if editor appears empty
        await page.evaluate((textToType) => {
            const editors = Array.from(document.querySelectorAll('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]'));
            const mainEditor = editors.find(e => e.offsetWidth > 0 && !e.closest('.sc-e4f4e472-3'));
            if (mainEditor && (mainEditor.innerText || '').trim() === '') {
                const p = mainEditor.querySelector('p') || mainEditor;
                p.textContent = textToType;
                mainEditor.dispatchEvent(new Event('input', { bubbles: true }));
                mainEditor.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, prompt);

        console.log(`      ✅ Prompt typed successfully into input bar`);

        // 3. Click the Send (arrow_forward) button in the RIGHT-SIDE panel.
        // NOTE: After typing, a '×' (close icon = "close") button appears in the textbox.
        // That × button can be the rightmost element — we MUST match by icon text ONLY.
        const sendCoords = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const allBtns = Array.from(document.querySelectorAll('button'));

            // All text tokens inside a button (checks every descendant)
            const allTexts = b => Array.from(b.querySelectorAll('*'))
                .map(c => (c.textContent || '').trim())
                .concat([(b.textContent || '').trim()]);

            // Is this the × clear button that appears after typing?
            const isClearBtn = b => allTexts(b).some(t => t === 'close' || t === 'cancel' || t === 'clear');

            // Strategy 1: arrow_forward icon in right panel, strictly exclude clear/close buttons
            let sendBtn = allBtns.find(b => {
                if (!isVisible(b)) return false;
                if (isClearBtn(b)) return false;
                const r = b.getBoundingClientRect();
                if (r.left < window.innerWidth * 0.5) return false;
                if (r.top < window.innerHeight * 0.7) return false;
                return allTexts(b).some(t => t === 'arrow_forward');
            });

            // Strategy 2: page-wide arrow_forward button (relaxed position, still exclude clear)
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

        // Capture post-submit snapshot of all media URLs (including uploaded reference video in prompt history card)
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
        console.log(`      🔍 Applying UI Filter: "Generated" ON, "Uploaded" OFF...`);
        try {
            // ── Step 1: Open the Filters panel ────────────────────────────────
            // The filter button is the funnel icon button in the top header area.
            // New UI: no text label, just an icon. Multiple selectors tried.
            const filterPanelOpened = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                // Check if filter panel is already open (has "Filters" heading visible)
                const filtersHeading = Array.from(document.querySelectorAll('h2, h3, [class*="heading"], span, div'))
                    .find(el => isVisible(el) && (el.innerText || el.textContent || '').trim() === 'Filters');
                if (filtersHeading) return 'already_open';

                // Try to find and click the filter button (funnel icon)
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));

                // Strategy 1: button with 'filter_list' or 'tune' or 'filter_alt' google icon
                const iconBtn = allBtns.find(b => {
                    if (!isVisible(b)) return false;
                    const icons = Array.from(b.querySelectorAll('i, [class*="google-symbols"], [class*="material-icons"], svg'));
                    return icons.some(i => {
                        const t = (i.textContent || i.getAttribute('aria-label') || '').trim();
                        return t === 'filter_list' || t === 'tune' || t === 'filter_alt' || t === 'filter';
                    });
                });
                if (iconBtn) { iconBtn.click(); return 'clicked_icon'; }

                // Strategy 2: button with aria-label containing filter/sort
                const ariaBtn = allBtns.find(b => {
                    if (!isVisible(b)) return false;
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    return aria.includes('filter') || aria.includes('sort');
                });
                if (ariaBtn) { ariaBtn.click(); return 'clicked_aria'; }

                // Strategy 3: button in header area (top 80px) that is not search/settings/add
                const headerBtns = allBtns.filter(b => {
                    if (!isVisible(b)) return false;
                    const rect = b.getBoundingClientRect();
                    if (rect.top > 80) return false; // must be in header
                    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                    // exclude known non-filter buttons
                    return !txt.includes('new') && !txt.includes('add') && !txt.includes('agent') &&
                           !txt.includes('help') && !txt.includes('settings') &&
                           rect.width < 100; // filter btn is compact (icon only)
                });
                // Pick the rightmost header button (filter is usually on the right side)
                if (headerBtns.length > 0) {
                    const rightmost = headerBtns.reduce((a, b) => {
                        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                        return ar.left > br.left ? a : b;
                    });
                    rightmost.click();
                    return 'clicked_header';
                }

                return false;
            });

            if (!filterPanelOpened) {
                console.warn(`      ⚠️ Could not find filter button — skipping filter apply`);
                return;
            }

            console.log(`      ✅ Filter panel: ${filterPanelOpened}`);
            await page.waitForTimeout(800); // wait for panel animation

            // ── Step 2: Verify panel is open, then set Generated=ON, Uploaded=OFF ───
            const filterResult = await page.evaluate(() => {
                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                // Find all clickable items in the Filters panel
                // New UI uses label+checkbox combos or div-based items
                const findCheckboxItem = (labelText) => {
                    // Strategy A: <label> containing text
                    const labels = Array.from(document.querySelectorAll('label'));
                    const matchedLabel = labels.find(l => {
                        if (!isVisible(l)) return false;
                        const txt = (l.innerText || l.textContent || '').trim();
                        return txt === labelText || txt.startsWith(labelText);
                    });
                    if (matchedLabel) return { el: matchedLabel, type: 'label' };

                    // Strategy B: Any visible element whose TEXT exactly matches
                    const allEls = Array.from(document.querySelectorAll(
                        'button, [role="checkbox"], [role="menuitem"], [role="option"], div, span'
                    ));
                    const textMatch = allEls.find(el => {
                        if (!isVisible(el)) return false;
                        const ownText = (el.childNodes && Array.from(el.childNodes)
                            .filter(n => n.nodeType === 3)
                            .map(n => n.textContent.trim())
                            .join('')) || (el.innerText || '').trim();
                        return ownText === labelText;
                    });
                    if (textMatch) return { el: textMatch, type: 'text' };

                    // Strategy C: Broader text search
                    const broadMatch = allEls.find(el => {
                        if (!isVisible(el)) return false;
                        const txt = (el.innerText || el.textContent || '').trim();
                        return txt === labelText || (txt.startsWith(labelText) && txt.length < labelText.length + 10);
                    });
                    if (broadMatch) return { el: broadMatch, type: 'broad' };

                    return null;
                };

                const isItemChecked = (item) => {
                    if (!item) return false;
                    const el = item.el;

                    // Check associated input[type=checkbox]
                    const inputId = el.getAttribute('for');
                    if (inputId) {
                        const input = document.getElementById(inputId);
                        if (input) return input.checked;
                    }
                    const siblingInput = el.querySelector('input[type="checkbox"]');
                    if (siblingInput) return siblingInput.checked;

                    // Check aria-checked
                    const ariaChecked = el.getAttribute('aria-checked');
                    if (ariaChecked !== null) return ariaChecked === 'true';

                    // Check data-state
                    const dataState = el.getAttribute('data-state');
                    if (dataState) return dataState === 'checked' || dataState === 'on';

                    // Check for check_box vs check_box_outline_blank icon text
                    const icons = Array.from(el.querySelectorAll('i, [class*="google-symbols"], [class*="material-icons"]'));
                    const iconText = icons.map(i => (i.textContent || '').trim()).join(' ');
                    if (iconText.includes('check_box') && !iconText.includes('outline_blank')) return true;
                    if (iconText.includes('check_box_outline_blank')) return false;

                    // Check background/fill color of checkbox svg or shape
                    const svgs = Array.from(el.querySelectorAll('svg rect, svg path'));
                    // No reliable way without computed styles in evaluate context

                    // Fallback: check class names for selected/active/checked state
                    const cls = (el.className || '').toLowerCase();
                    return cls.includes('selected') || cls.includes('active') || cls.includes('checked');
                };

                const genItem = findCheckboxItem('Generated');
                const upItem = findCheckboxItem('Uploaded');

                const result = {
                    genFound: !!genItem,
                    upFound: !!upItem,
                    genWasChecked: isItemChecked(genItem),
                    upWasChecked: isItemChecked(upItem),
                    genClicked: false,
                    upClicked: false,
                };

                // Ensure Generated is CHECKED
                if (genItem && !result.genWasChecked) {
                    if (window.__highlight) window.__highlight(genItem.el);
                    genItem.el.click();
                    result.genClicked = true;
                }

                // Ensure Uploaded is UNCHECKED
                if (upItem && result.upWasChecked) {
                    if (window.__highlight) window.__highlight(upItem.el);
                    upItem.el.click();
                    result.upClicked = true;
                }

                return result;
            });

            console.log(`      📊 Filter state: Generated [found=${filterResult.genFound}, wasChecked=${filterResult.genWasChecked}, clicked=${filterResult.genClicked}] | Uploaded [found=${filterResult.upFound}, wasChecked=${filterResult.upWasChecked}, clicked=${filterResult.upClicked}]`);

            await page.waitForTimeout(500);

            // ── Step 3: If items not found via JS, try Playwright locators ────────────
            if (!filterResult.genFound || !filterResult.upFound) {
                console.log(`      ⚠️ JS strategy missed items — trying Playwright locators...`);

                // Try to find "Generated" label/button using Playwright text matching
                try {
                    const genLocator = page.locator('text=Generated').first();
                    if (await genLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
                        // Check if it's unchecked by looking for associated checkbox
                        const genParent = genLocator.locator('..');
                        const checkbox = genParent.locator('input[type="checkbox"]').first();
                        const isChecked = await checkbox.isChecked({ timeout: 1000 }).catch(() => false);
                        if (!isChecked) {
                            await genLocator.click({ timeout: 2000 }).catch(() => {});
                            console.log(`      ✅ Clicked "Generated" via Playwright locator`);
                        }
                    }
                } catch (e) {
                    console.warn(`      ⚠️ Playwright "Generated" locator failed: ${e.message}`);
                }

                try {
                    const upLocator = page.locator('text=Uploaded').first();
                    if (await upLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
                        const upParent = upLocator.locator('..');
                        const checkbox = upParent.locator('input[type="checkbox"]').first();
                        const isChecked = await checkbox.isChecked({ timeout: 1000 }).catch(() => false);
                        if (isChecked) {
                            await upLocator.click({ timeout: 2000 }).catch(() => {});
                            console.log(`      ✅ Clicked "Uploaded" via Playwright locator (to uncheck)`);
                        }
                    }
                } catch (e) {
                    console.warn(`      ⚠️ Playwright "Uploaded" locator failed: ${e.message}`);
                }
                await page.waitForTimeout(500);
            }

            // ── Step 4: Close the Filters panel ───────────────────────────────
            // Click outside the panel or press Escape
            await page.keyboard.press('Escape');
            await page.waitForTimeout(600);

            // Verify panel closed; if not, click elsewhere
            const panelStillOpen = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('h2, h3, span, div'))
                    .some(el => el.offsetWidth > 0 && (el.innerText || el.textContent || '').trim() === 'Filters');
            });
            if (panelStillOpen) {
                console.log(`      ⚠️ Panel still open after Escape — clicking elsewhere to close...`);
                await page.mouse.click(200, 400).catch(() => {});
                await page.waitForTimeout(400);
            }

            console.log(`      ✅ Filter applied: Generated ON, Uploaded OFF`);
        } catch (err) {
            console.warn(`      ⚠️ Error in _applyResultFilter: ${err.message}`);
        }
    }


    async _extractResult(page, type, itemId, preExistingUrls = []) {
        const excludedUrlSet = new Set(preExistingUrls);
        const startTime = Date.now();
        let lastActivityTime = Date.now();
        let lastProgressPct = -1;
        const maxStaleMs = 600000; // Allow up to 10 minutes of active generation progress

        console.log(`      ⏳ Real-Time Generation Tracking: Monitoring live DOM percentage, spinners, & new ${type.toUpperCase()} assets...`);

        let resultData = null;
        let pollCount = 0;
        let retryCount = 0;

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
                const pctMatches = bodyText.match(/(\d{1,3})\s*%/g);
                let currentPct = null;
                if (pctMatches && pctMatches.length > 0) {
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
                    const progressEls = Array.from(document.querySelectorAll('[role="progressbar"], progress, [aria-valuenow]'));
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
                const hasActiveSpinner = Array.from(document.querySelectorAll('[role="progressbar"], progress, [class*="spinner"], svg[class*="loading"], [class*="loader"]')).some(
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
                    if (src.startsWith('blob:')) return true;

                    const lowerSrc = src.toLowerCase();
                    if (
                        lowerSrc.includes('googleusercontent.com') ||
                        lowerSrc.includes('lh3.google') ||
                        lowerSrc.includes('ggpht.com') ||
                        lowerSrc.includes('profile') ||
                        lowerSrc.includes('avatar') ||
                        lowerSrc.includes('favicon') ||
                        lowerSrc.includes('gstatic') ||
                        lowerSrc.includes('google.png') ||
                        lowerSrc.includes('logo') ||
                        lowerSrc.includes('user') ||
                        lowerSrc.includes('account')
                    ) return true;

                    return false;
                };

                const newMediaUrls = [];
                let newVideoUrl = null;
                let newImageUrl = null;

                // Scan video elements
                document.querySelectorAll('video').forEach((vid) => {
                    const src = vid.getAttribute('src') || (vid.querySelector('source') && vid.querySelector('source').getAttribute('src'));
                    if (src && !isProfileOrUi(src)) {
                        newMediaUrls.push(src);
                        if (!newVideoUrl) newVideoUrl = src;
                    }
                });

                // Scan image elements
                document.querySelectorAll('img').forEach((img) => {
                    const src = img.getAttribute('src') || '';
                    if (src && !isProfileOrUi(src)) {
                        const w = img.clientWidth || img.naturalWidth || 0;
                        const h = img.clientHeight || img.naturalHeight || 0;
                        if ((w === 0 || w >= 250) && (h === 0 || h >= 250)) {
                            newMediaUrls.push(src);
                            if (!newImageUrl) newImageUrl = src;
                        }
                    }
                });

                return {
                    currentPct,
                    statusText,
                    hasActiveSpinner,
                    isGeneratingText,
                    mediaUrls: Array.from(new Set(newMediaUrls)),
                    videoUrl: newVideoUrl,
                    imageUrl: newImageUrl,
                    text: bodyText.substring(0, 3000),
                    isCancelled: bodyText.includes('Response was cancelled') || bodyText.includes('response was cancelled'),
                };
            }, { targetType: type, excludedUrls: Array.from(excludedUrlSet) });
            // ── CANCELLATION CHECK: if Google cancelled the response, retry the prompt ──
            if (liveState.isCancelled) {
                console.warn(`      ⚠️ "Response was cancelled." detected — retrying prompt submission...`);
                retryCount = (retryCount || 0) + 1;
                if (retryCount > 3) {
                    throw new Error('[GoogleFX] ❌ Prompt was cancelled 3 times — aborting.');
                }
                console.log(`      🔄 Retry attempt ${retryCount}/3 — re-submitting prompt...`);
                await page.waitForTimeout(2000);
                // Re-submit the prompt (prompt variable is captured in closure via _extractResult args)
                // We use the stored _lastPrompt set before calling _extractResult
                const retryPrompt = this._lastPrompt || '';
                if (retryPrompt) {
                    await this._submitPrompt(page, retryPrompt);
                    await page.waitForTimeout(3000);
                    lastActivityTime = Date.now(); // reset stale timer
                    continue;
                }
            }

            // Log live percentage & status updates if present in DOM & reset activity timer
            if (liveState.currentPct !== null && liveState.currentPct !== lastProgressPct) {
                console.log(`      🎬 Live UI Generation Progress: ${liveState.currentPct}% ${liveState.statusText ? `(${liveState.statusText})` : ''} (${elapsedSec}s)`);
                lastProgressPct = liveState.currentPct;
                lastActivityTime = Date.now();

                if (itemId) {
                    try {
                        const jobsCol = getJobsCollection();
                        await jobsCol.updateOne(
                            { itemId },
                            {
                                $set: {
                                    progressPct: liveState.currentPct,
                                    progressStatus: liveState.statusText ? `Generating: ${liveState.statusText} (${liveState.currentPct}%)` : `Generating video (${liveState.currentPct}%)...`,
                                    updatedAt: new Date(),
                                }
                            }
                        );
                    } catch (e) {}
                }
            } else if (liveState.hasActiveSpinner || liveState.isGeneratingText) {
                lastActivityTime = Date.now();
                if (pollCount % 3 === 0) {
                    console.log(`      🎬 Live UI Generation Progress: ${liveState.statusText || 'Generating video in progress...'} (${elapsedSec}s)`);
                    await this._logChatReplies(page, `Polling #${pollCount}`);
                    if (itemId) {
                        try {
                            const jobsCol = getJobsCollection();
                            await jobsCol.updateOne(
                                { itemId },
                                {
                                    $set: {
                                        progressStatus: liveState.statusText ? `Generating: ${liveState.statusText}` : 'Generating video in Google Flow...',
                                        updatedAt: new Date(),
                                    }
                                }
                            );
                        } catch (e) {}
                    }
                }
            }

            // CRITICAL GATE: ONLY MARK COMPLETED WHEN A NEW GENERATED ASSET IS FOUND (TOTAL ASSETS > 0)!
            const isVideoType = type === 'video' || type === 'avatar_video';
            const targetAsset = isVideoType ? liveState.videoUrl : (liveState.imageUrl || liveState.videoUrl);

            if (targetAsset && liveState.mediaUrls.length > 0 && !liveState.hasActiveSpinner) {
                console.log(`      ✨ GENERATION COMPLETED! Found ${liveState.mediaUrls.length} new asset(s) in ${elapsedSec}s.`);
                console.log(`      🔗 New Generated Asset URL: ${targetAsset}`);
                resultData = {
                    videoUrl: isVideoType ? liveState.videoUrl : null,
                    imageUrl: type === 'image' ? liveState.imageUrl : null,
                    mediaUrls: liveState.mediaUrls,
                    text: liveState.text,
                };
                break;
            }

            if (page.isClosed()) break;
            await page.waitForTimeout(5000);
        }

        if (!resultData || (!resultData.videoUrl && !resultData.imageUrl && (!resultData.mediaUrls || resultData.mediaUrls.length === 0))) {
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

        // ─── Find Download Button by hovering over generated media ───────────
        try {
            const downloadDir = path.join(process.cwd(), 'downloads');
            if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

            let downloaded = false;

            // Step 1: Find generated media cards
            const mediaCards = await page.evaluate(() => {
                const results = [];
                const isUiOrProfile = (src) => {
                    if (!src || src.startsWith('data:')) return true;
                    const s = src.toLowerCase();
                    return s.includes('googleusercontent.com') || s.includes('lh3.google') ||
                           s.includes('gstatic') || s.includes('favicon') || s.includes('avatar') ||
                           s.includes('logo');
                };
                document.querySelectorAll('video, img').forEach((el, idx) => {
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

            console.log(`      📦 Found ${mediaCards.length} generated media card(s) to attempt download`);

            // Step 2: Hover over media cards & click download button if present
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
                                console.log(`      📥 Found download btn: text="${txt.substring(0,30)}" aria="${aria.substring(0,30)}"`);
                                break;
                            }
                        } catch {}
                    }

                    if (!dlBtn) {
                        const menuBtns = await page.$$('button');
                        for (const btn of menuBtns) {
                            try {
                                if (!(await btn.isVisible())) continue;
                                const txt = (await btn.innerText()).trim().toLowerCase();
                                const rect = await btn.boundingBox();
                                if (!rect) continue;
                                if ((txt === 'more_vert' || txt.includes('more')) && Math.abs(rect.top - card.top) < 200) {
                                    await btn.click();
                                    await page.waitForTimeout(500);
                                    const menuItems = await page.$$('[role="menuitem"], [role="option"], li');
                                    for (const item of menuItems) {
                                        try {
                                            const itxt = (await item.innerText()).trim().toLowerCase();
                                            if (itxt.includes('download') || itxt.includes('save')) {
                                                dlBtn = item;
                                                break;
                                            }
                                        } catch {}
                                    }
                                    if (dlBtn) break;
                                    await page.keyboard.press('Escape');
                                    await page.waitForTimeout(300);
                                }
                            } catch {}
                        }
                    }

                    if (dlBtn && (await dlBtn.isVisible())) {
                        console.log(`      📥 Clicking download button...`);
                        const ext = type === 'video' ? 'mp4' : 'png';
                        const filename = `flow_${type}_${Date.now()}.${ext}`;
                        const localPath = path.join(downloadDir, filename);

                        const [download] = await Promise.all([
                            page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
                            dlBtn.click(),
                        ]);

                        if (download) {
                            await download.saveAs(localPath);
                            const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                            console.log(`      💾 File saved: ${localPath}`);
                            resultData.downloadPath = localPath;
                            resultData.downloadUrl = localUrl;
                            resultData.filename = filename;
                            downloaded = true;
                        } else {
                            console.warn(`      ⚠️ Download event not fired — trying fetch fallback`);
                        }
                    }
                } catch (cardErr) {
                    console.warn(`      ⚠️ Media card download attempt failed: ${cardErr.message}`);
                }
            }

            // Step 3: Playwright page.request download (uses authenticated browser session context & follows redirects)
            if (!downloaded && resultData) {
                const isVideoType = type === 'video' || type === 'avatar_video';
                const targetUrl = (isVideoType ? resultData.videoUrl : resultData.imageUrl)
                    || resultData.videoUrl
                    || resultData.imageUrl
                    || (resultData.mediaUrls || [])[0];

                if (targetUrl) {
                    console.log(`      🌐 Playwright request downloading (${type}): ${targetUrl.substring(0, 80)}...`);
                    try {
                        // page.request uses Chromium's network engine with active session cookies!
                        const response = await page.request.get(targetUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Referer': 'https://labs.google/',
                            }
                        });

                        if (response.ok()) {
                            const buffer = await response.body();

                            // Detect extension from actual Content-Type header (most reliable)
                            const contentType = response.headers()['content-type'] || '';
                            let ext;
                            if (contentType.includes('video/mp4') || contentType.includes('video/')) {
                                ext = 'mp4';
                            } else if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
                                ext = 'jpg';
                            } else if (contentType.includes('image/webp')) {
                                ext = 'webp';
                            } else if (contentType.includes('image/gif')) {
                                ext = 'gif';
                            } else if (contentType.includes('image/png')) {
                                ext = 'png';
                            } else {
                                // Fallback: guess from type parameter
                                ext = isVideoType ? 'mp4' : 'png';
                            }

                            const filename = `flow_${type}_${Date.now()}.${ext}`;
                            const localPath = path.join(downloadDir, filename);
                            console.log(`      📋 Content-Type: "${contentType}" → saving as .${ext}`);

                            if (buffer && buffer.length > 500) {
                                writeFileSync(localPath, buffer);
                                const localUrl = `http://localhost:${config.port || 5001}/downloads/${filename}`;
                                console.log(`      💾 File saved via Playwright request: ${localPath} (${Math.round(buffer.length / 1024)}KB)`);
                                resultData.downloadPath = localPath;
                                resultData.downloadUrl = localUrl;
                                resultData.filename = filename;
                                downloaded = true;
                            } else {
                                console.warn(`      ⚠️ Downloaded buffer too small (${buffer ? buffer.length : 0} bytes)`);
                            }
                        } else {
                            console.warn(`      ⚠️ Playwright page.request HTTP ${response.status()}`);
                        }
                    } catch (dlErr) {
                        console.warn(`      ⚠️ Playwright request download error: ${dlErr.message}`);
                    }
                }
            }

            // Step 4: Upload downloaded asset to Cloudflare R2 under ai-content/${itemId}/${filename} & cleanup local file
            if (downloaded && resultData && resultData.downloadPath) {
                try {
                    const filename = resultData.filename || `flow_${type}_${Date.now()}.${(type === 'video' || type === 'avatar_video') ? 'mp4' : 'png'}`;
                    const destinationKey = `ai-content/${itemId || 'gen_unknown'}/${filename}`;

                    // Detect contentType from actual saved file extension (most reliable)
                    const fileExt = filename.split('.').pop().toLowerCase();
                    const extToMime = {
                        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
                        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                        webp: 'image/webp', gif: 'image/gif',
                    };
                    const contentType = extToMime[fileExt] || ((type === 'video' || type === 'avatar_video') ? 'video/mp4' : 'image/png');
                    console.log(`      ☁️ R2 contentType: ${contentType} (from .${fileExt})`);

                    console.log(`      ☁️ Uploading asset to Cloudflare R2 key: ${destinationKey}...`);
                    const r2Result = await uploadToR2(resultData.downloadPath, destinationKey, contentType);

                    if (r2Result && r2Result.r2Url) {
                        resultData.r2Url = r2Result.r2Url;
                        resultData.r2Key = r2Result.r2Key;
                        console.log(`      ☁️ ✅ Cloudflare R2 Public URL: ${r2Result.r2Url}`);

                        // Delete local temporary file after successful upload to R2
                        if (existsSync(resultData.downloadPath)) {
                            try {
                                unlinkSync(resultData.downloadPath);
                                console.log(`      🗑️ Successfully deleted local temp file: ${resultData.downloadPath}`);
                                resultData.downloadPath = null; // Cleared since local file is removed
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
            }
        } catch (errDl) {
            console.warn(`      ⚠️ Download section error: ${errDl.message}`);
        }

        return resultData;
    }
}

