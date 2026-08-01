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

    async execute({ itemId, prompt, type = 'video', settings = {}, mediaUrl = null, imageUrl = null }) {
        const effectiveMediaUrl = mediaUrl || imageUrl || null;
        const execStart = Date.now();
        console.log('\n' + '─'.repeat(60));
        console.log('🌐  [GoogleFxFlowTool] BROWSER AUTOMATION STARTED');
        console.log('─'.repeat(60));
        console.log(`🆔  Job ID : ${itemId || 'N/A'}`);
        console.log(`🎬  Type   : ${type.toUpperCase()}`);
        console.log(`💬  Prompt : "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
        console.log(`⚙️   Settings: ${JSON.stringify(settings)}`);
        if (effectiveMediaUrl) console.log(`🖼️   Media URL: ${effectiveMediaUrl}`);
        logger.info(`[GoogleFxFlowTool] Executing (${type}) [${itemId}]: "${prompt.substring(0, 80)}..."`);

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

            // 3. Configure Mode (Video/Image) and Settings
            console.log(`\n[4/6] ⚙️ Configuring generator mode (${type}) and settings...`);
            await this._applySettings(page, type, settings);

            // 3b. Upload reference media if mediaUrl provided
            let uploadedMediaUrls = [];
            if (effectiveMediaUrl) {
                console.log(`\n[4b/6] 🖼️ Uploading reference media from URL...`);
                uploadedMediaUrls = await this._uploadMediaFromUrl(page, effectiveMediaUrl, itemId);
                console.log(`      🔒 Uploaded media URLs captured for exclusion: ${uploadedMediaUrls.length}`);
            }

            // NOTE: _applyResultFilter() is intentionally NOT called here.
            // Calling it right after upload would fire an Escape keypress that closes
            // the upload panel while it is still transitioning → breaks the upload flow.
            // The filter is applied inside _extractResult() before polling begins.

            // 4. Wait for prompt bar to fully settle after upload, then snapshot ALL
            // pre-existing media URLs. This must happen AFTER the media panel closes
            // and the thumbnail is stable in the prompt bar.
            // Any URL in this snapshot will be EXCLUDED from result polling.
            // IMPORTANT: Increased wait to 5000ms — uploaded video URL may appear in DOM
            // AFTER panel closes (Google streams/renders the uploaded thumbnail asynchronously).
            await page.waitForTimeout(5000); // let prompt bar thumbnail + any lazy-loaded uploaded URLs settle
            const preExistingUrls = await page.evaluate(() => {
                const urls = new Set();
                document.querySelectorAll('img[src], video[src], video source[src]').forEach(el => {
                    const src = el.getAttribute('src') || '';
                    if (src && !src.startsWith('data:')) urls.add(src);
                });
                // Also capture blob URLs and any src from prompt bar attachments
                document.querySelectorAll('[src]').forEach(el => {
                    const src = el.getAttribute('src') || '';
                    if (src && (src.startsWith('blob:') || src.startsWith('http'))) urls.add(src);
                });
                return Array.from(urls);
            });
            console.log(`      📸 Pre-submit snapshot: ${preExistingUrls.length} existing media URLs captured (will be excluded from result)`);

            // 5. Enter Prompt & Submit
            console.log(`\n[5/6] ⌨️ Submitting prompt into generation bar...`);
            const postSubmitUrls = await this._submitPrompt(page, prompt);
            console.log(`      ✅ Prompt submitted!`);

            // Merge: preExisting + post-submit snapshot + explicitly captured uploaded URLs
            const allExcludedUrls = Array.from(new Set([...preExistingUrls, ...(postSubmitUrls || []), ...uploadedMediaUrls]));
            console.log(`      🔒 Total excluded reference media URLs: ${allExcludedUrls.length} (preExisting=${preExistingUrls.length}, postSubmit=${(postSubmitUrls||[]).length}, uploadedCapture=${uploadedMediaUrls.length})`);

            // 6. Poll and Extract Results & Download Local Asset
            console.log(`\n[6/6] ⏳ Polling for ${type} generation completion, downloading asset & saving locally...`);
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
                prompt,
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

    async _applySettings(page, type, settings = {}) {
        try {
            console.log(`      ⚙️ Applying UI Settings for type="${type}": ${JSON.stringify(settings)}`);

            // ── STEP 1: Enable Agent mode if not already enabled ──────────────────────
            await page.evaluate(() => {
                // Find main prompt bar container (sc-c9e4708a-0 or sc-5c3af813-0)
                const containers = Array.from(document.querySelectorAll('.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'))
                    .filter(c => c.offsetWidth > 0 && c.offsetHeight > 0 && !c.closest('.sc-e4f4e472-3'));
                const promptBar = containers.length > 0 ? containers[containers.length - 1] : document.body;

                const agentBtn = promptBar.querySelector('button.sc-59223abb-3, button[class*="59223abb"]')
                    || Array.from(promptBar.querySelectorAll('button')).find(b => (b.innerText || b.textContent || '').trim() === 'Agent');

                if (agentBtn && agentBtn.getAttribute('aria-pressed') !== 'true') {
                    console.log('[AgentBtn] Clicking Agent pill to enable agent mode...');
                    if (window.__highlight) window.__highlight(agentBtn);
                    agentBtn.click();
                }
            });
            await page.waitForTimeout(600);

            // ── STEP 2: Find & Click Settings (tune) Button in Bottom Prompt Bar ───
            let panelOpened = await page.evaluate(() => {
                const textPresent = (document.body.innerText || '').includes('Agent settings');
                const saveBtn = Array.from(document.querySelectorAll('button'))
                    .some(b => b.offsetWidth > 0 && (b.innerText || '').trim() === 'Save');
                return textPresent || saveBtn;
            });

            if (panelOpened) {
                console.log(`      ✅ Agent Settings drawer is already open`);
            } else {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    // Clear pointer-events on backdrop overlays before click attempt
                    await page.evaluate(() => {
                        document.querySelectorAll('[class*="sc-e4f4e472-1"], [class*="jIKcWn"], [class*="backdrop"], [class*="overlay-backdrop"]').forEach(el => {
                            if (!el.closest('[class*="sc-b9afcbbb"], [class*="sc-e4f4e472-3"]')) {
                                el.style.pointerEvents = 'none';
                            }
                        });
                    });

                    const coords = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                        const isValidSettingsTarget = b => {
                            if (!b) return false;
                            const txt = (b.innerText || b.textContent || '').toLowerCase();
                            const cls = (b.className || '').toLowerCase();
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            
                            if (txt.includes('expand') || cls.includes('c4e423a0-3') || aria.includes('expand')) return false;
                            if (txt.includes('instruction') || cls.includes('c4e423a0-2') || aria.includes('instruction')) return false;
                            return true;
                        };

                        const containers = Array.from(document.querySelectorAll('.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'))
                            .filter(c => isVisible(c) && !c.closest('.sc-e4f4e472-3'));
                        const promptContainer = containers.length > 0 ? containers[containers.length - 1] : null;

                        let btn = null;

                        if (promptContainer) {
                            const btns = Array.from(promptContainer.querySelectorAll('button')).filter(isValidSettingsTarget);
                            btn = btns.find(b => {
                                if (!isVisible(b)) return false;
                                const hasTuneIcon = Array.from(b.querySelectorAll('i, [class*="google-symbols"]'))
                                    .some(i => (i.textContent || '').trim() === 'tune');
                                const hasSettingsSpan = Array.from(b.querySelectorAll('span'))
                                    .some(s => (s.textContent || '').trim() === 'Settings');
                                return hasTuneIcon || hasSettingsSpan;
                            });
                        }

                        if (!btn) {
                            const allBtns = Array.from(document.querySelectorAll('button')).filter(isValidSettingsTarget);
                            btn = allBtns.find(b => {
                                if (!isVisible(b)) return false;
                                const cls = b.className || '';
                                return cls.includes('sc-c4e423a0-1') && !cls.includes('sc-c4e423a0-2') && !cls.includes('sc-c4e423a0-3');
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

                    if (coords && coords.cx > 0 && coords.cy > 0) {
                        console.log(`      ⚙️ Settings tune button found at [${coords.cx}, ${coords.cy}] (attempt ${attempt}) — firing SINGLE hardware click...`);
                        try {
                            await page.mouse.click(coords.cx, coords.cy);
                        } catch {}
                    } else {
                        console.warn(`      ⚠️ Could not find Settings tune button, attempting DOM click...`);
                        await page.evaluate(() => {
                            const tuneBtn = document.querySelector('button.sc-c4e423a0-1:not(.sc-c4e423a0-2):not(.sc-c4e423a0-3)');
                            if (tuneBtn) tuneBtn.click();
                        });
                    }

                    await page.waitForTimeout(1000);

                    panelOpened = await page.evaluate(() => {
                        const textPresent = (document.body.innerText || '').includes('Agent settings');
                        const saveBtn = Array.from(document.querySelectorAll('button'))
                            .some(b => b.offsetWidth > 0 && (b.innerText || '').trim() === 'Save');
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

            // Disable backdrop pointer interception if present
            await page.evaluate(() => {
                document.querySelectorAll('[class*="sc-e4f4e472-1"], [class*="backdrop"], [class*="overlay"]').forEach(el => {
                    const s = window.getComputedStyle(el);
                    if ((s.position === 'fixed' || s.position === 'absolute') && parseInt(s.width) > 300)
                        el.style.pointerEvents = 'none';
                });
            });

            // ── STEP 3: Set "Confirm before generating" → Never (with verification & retry) ─
            let neverConfirmed = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const coords = await page.evaluate(() => {
                    const radios = Array.from(document.querySelectorAll('button[role="radio"]'));
                    const neverRadio = radios.find(r => r.getAttribute('value') === 'AUTO_APPROVE' || (r.innerText || '').includes('Never'));
                    if (neverRadio) {
                        if (window.__highlight) window.__highlight(neverRadio);
                        neverRadio.scrollIntoView({ block: 'center' });
                        neverRadio.focus();
                        neverRadio.click();
                        neverRadio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        const r = neverRadio.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                });

                if (coords && coords.cx > 0 && coords.cy > 0) {
                    try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                }

                await page.waitForTimeout(600);

                neverConfirmed = await page.evaluate(() => {
                    const radios = Array.from(document.querySelectorAll('button[role="radio"]'));
                    const neverRadio = radios.find(r => r.getAttribute('value') === 'AUTO_APPROVE' || (r.innerText || '').includes('Never'));
                    return neverRadio && (neverRadio.getAttribute('data-state') === 'checked' || neverRadio.getAttribute('aria-checked') === 'true');
                });

                if (neverConfirmed) {
                    console.log(`      ✅ Set confirmation → Never (verified on attempt ${attempt})`);
                    break;
                } else {
                    console.warn(`      ⚠️ Confirmation "Never" verification failed (attempt ${attempt}/3) — retrying...`);
                    await page.waitForTimeout(500);
                }
            }
            await page.waitForTimeout(1000);

            // ── STEP 4: Scope and Apply Settings (Image vs Video) with Verification & Retry ──
            // 4a. Select Aspect Ratio inside target section
            const arVal = settings.aspectRatio || settings.aspect_ratio || settings.ratio;
            if (arVal) {
                const targetAr = String(arVal).trim();
                let arConfirmed = false;

                for (let attempt = 1; attempt <= 3; attempt++) {
                    const arCoords = await page.evaluate(({ type, targetAr }) => {
                        const isVideo = type === 'video';
                        const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                        const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                        
                        let sectionContainer = null;
                        const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                        const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                        if (matchedSpan) {
                            sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                        }
                        if (!sectionContainer && sections.length > 0) {
                            sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                        }
                        if (!sectionContainer) return null;

                        const tabs = Array.from(sectionContainer.querySelectorAll('button[role="tab"], button'));
                        const arTab = tabs.find(t => {
                            const txt = (t.innerText || t.textContent || '').trim();
                            return txt === targetAr || txt.endsWith(targetAr) || txt.includes(targetAr);
                        });

                        if (arTab) {
                            if (window.__highlight) window.__highlight(arTab);
                            arTab.scrollIntoView({ block: 'center', inline: 'nearest' });
                            arTab.focus();
                            arTab.click();
                            arTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            const r = arTab.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }
                        return null;
                    }, { type, targetAr });

                    if (arCoords && arCoords.cx > 0 && arCoords.cy > 0) {
                        try { await page.mouse.click(arCoords.cx, arCoords.cy); } catch {}
                    }

                    await page.waitForTimeout(600);

                    arConfirmed = await page.evaluate(({ type, targetAr }) => {
                        const isVideo = type === 'video';
                        const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                        const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                        let sectionContainer = null;
                        const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                        const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                        if (matchedSpan) sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                        if (!sectionContainer && sections.length > 0) sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                        if (!sectionContainer) return false;

                        const tabs = Array.from(sectionContainer.querySelectorAll('button[role="tab"], button'));
                        const arTab = tabs.find(t => {
                            const txt = (t.innerText || t.textContent || '').trim();
                            return txt === targetAr || txt.endsWith(targetAr) || txt.includes(targetAr);
                        });
                        return arTab && (arTab.getAttribute('data-state') === 'active' || arTab.getAttribute('aria-selected') === 'true');
                    }, { type, targetAr });

                    if (arConfirmed) {
                        console.log(`      ✅ Aspect Ratio (${type}): verified "${targetAr}" is active (attempt ${attempt})`);
                        break;
                    } else {
                        console.warn(`      ⚠️ Aspect Ratio (${type}) "${targetAr}" not active (attempt ${attempt}/3) — retrying...`);
                        await page.waitForTimeout(500);
                    }
                }
                await page.waitForTimeout(1000);
            }

            // 4b. Select Count (x1, x2, x3, x4) with Verification & Retry
            const countVal = settings.count ?? settings.quantity;
            if (countVal !== undefined && countVal !== null && countVal !== '') {
                const num = String(countVal).replace(/[^0-9]/g, '').trim() || '1';
                const targetCountText = `x${num}`;
                let countConfirmed = false;

                for (let attempt = 1; attempt <= 3; attempt++) {
                    const countCoords = await page.evaluate(({ type, num, targetCountText }) => {
                        const isVideo = type === 'video';
                        const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                        const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));

                        let sectionContainer = null;
                        const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                        const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                        if (matchedSpan) {
                            sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                        }
                        if (!sectionContainer && sections.length > 0) {
                            sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                        }
                        if (!sectionContainer) return null;

                        const countTablist = sectionContainer.querySelector('.gmOsyE, [class*="gmOsyE"]') || sectionContainer;
                        const tabs = Array.from(countTablist.querySelectorAll('button[role="tab"], button'));

                        const countTab = tabs.find(t => {
                            const txt = (t.innerText || t.textContent || '').trim().toLowerCase();
                            const id = (t.id || '').toLowerCase();
                            const ctrl = (t.getAttribute('aria-controls') || '').toLowerCase();
                            return txt === targetCountText || txt === num || id.endsWith(`trigger-${num}`) || ctrl.endsWith(`content-${num}`);
                        });

                        if (countTab) {
                            if (window.__highlight) window.__highlight(countTab);
                            countTab.scrollIntoView({ block: 'center', inline: 'nearest' });
                            countTab.focus();
                            countTab.click();
                            countTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            const r = countTab.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }
                        return null;
                    }, { type, num, targetCountText });

                    if (countCoords && countCoords.cx > 0 && countCoords.cy > 0) {
                        try { await page.mouse.click(countCoords.cx, countCoords.cy); } catch {}
                    }

                    await page.waitForTimeout(600);

                    countConfirmed = await page.evaluate(({ type, num, targetCountText }) => {
                        const isVideo = type === 'video';
                        const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                        const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                        let sectionContainer = null;
                        const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                        const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                        if (matchedSpan) sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                        if (!sectionContainer && sections.length > 0) sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                        if (!sectionContainer) return false;

                        const countTablist = sectionContainer.querySelector('.gmOsyE, [class*="gmOsyE"]') || sectionContainer;
                        const tabs = Array.from(countTablist.querySelectorAll('button[role="tab"], button'));
                        const countTab = tabs.find(t => {
                            const txt = (t.innerText || t.textContent || '').trim().toLowerCase();
                            const id = (t.id || '').toLowerCase();
                            const ctrl = (t.getAttribute('aria-controls') || '').toLowerCase();
                            return txt === targetCountText || txt === num || id.endsWith(`trigger-${num}`) || ctrl.endsWith(`content-${num}`);
                        });

                        return countTab && (countTab.getAttribute('data-state') === 'active' || countTab.getAttribute('aria-selected') === 'true');
                    }, { type, num, targetCountText });

                    if (countConfirmed) {
                        console.log(`      ✅ Count (${type}): verified "${targetCountText}" is active (attempt ${attempt})`);
                        break;
                    } else {
                        console.warn(`      ⚠️ Count (${type}) "${targetCountText}" not active (attempt ${attempt}/3) — retrying...`);
                        await page.waitForTimeout(500);
                    }
                }
                await page.waitForTimeout(1000);
            }

            // 4c. Select Duration (Video only) with Verification & Retry
            if (type === 'video' && settings.duration) {
                const durStr = String(settings.duration).replace(/s$/i, '').trim();
                let durConfirmed = false;

                for (let attempt = 1; attempt <= 3; attempt++) {
                    const durCoords = await page.evaluate(({ durStr }) => {
                        const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                        const sectionContainer = sections.length >= 3 ? sections[2] : (sections[sections.length - 1] || document.body);

                        const tabs = Array.from(sectionContainer.querySelectorAll('button[role="tab"], button'));
                        const durTab = tabs.find(t => {
                            const txt = (t.innerText || t.textContent || '').trim();
                            return txt === `${durStr}s` || txt === durStr;
                        });

                        if (durTab) {
                            if (window.__highlight) window.__highlight(durTab);
                            durTab.scrollIntoView({ block: 'center', inline: 'nearest' });
                            durTab.focus();
                            durTab.click();
                            durTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            const r = durTab.getBoundingClientRect();
                            return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }
                        return null;
                    }, { durStr });

                    if (durCoords && durCoords.cx > 0 && durCoords.cy > 0) {
                        try { await page.mouse.click(durCoords.cx, durCoords.cy); } catch {}
                    }

                    await page.waitForTimeout(600);

                    durConfirmed = await page.evaluate(({ durStr }) => {
                        const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                        const sectionContainer = sections.length >= 3 ? sections[2] : (sections[sections.length - 1] || document.body);
                        const tabs = Array.from(sectionContainer.querySelectorAll('button[role="tab"], button'));
                        const durTab = tabs.find(t => {
                            const txt = (t.innerText || t.textContent || '').trim();
                            return txt === `${durStr}s` || txt === durStr;
                        });
                        return durTab && (durTab.getAttribute('data-state') === 'active' || durTab.getAttribute('aria-selected') === 'true');
                    }, { durStr });

                    if (durConfirmed) {
                        console.log(`      ✅ Duration (video): verified "${durStr}s" is active (attempt ${attempt})`);
                        break;
                    } else {
                        console.warn(`      ⚠️ Duration (video) "${durStr}s" not active (attempt ${attempt}/3) — retrying...`);
                        await page.waitForTimeout(500);
                    }
                }
                await page.waitForTimeout(1000);
            }

            // 4d. Model Dropdown Selection inside target section with Verification & Retry
            if (settings.model) {
                const rawModelStr = String(settings.model).trim();
                
                // Normalizer helper: map any user variations to exact UI model names
                const normalizeModel = (m, sectionType) => {
                    const l = m.toLowerCase();
                    if (sectionType === 'image') {
                        if (l.includes('lite') || l.includes('banana 2 lite')) return 'Nano Banana 2 Lite';
                        if (l.includes('pro') && !l.includes('2')) return 'Nano Banana Pro';
                        if (l.includes('banana 2') || l.includes('nano 2')) return 'Nano Banana 2';
                        if (l.includes('banana') || l.includes('nano')) return 'Nano Banana 2';
                        if (l.includes('imagen')) return 'Imagen 3';
                    } else if (sectionType === 'video') {
                        if (l.includes('omni') || l.includes('flash')) return 'Omni Flash';
                        if (l.includes('veo')) return 'Veo 2';
                    }
                    return m;
                };

                const modelStr = normalizeModel(rawModelStr, type);

                // Pre-check: Verify if desired model is ALREADY selected (ALL words must match, e.g. "lite", "flash")
                const alreadySelected = await page.evaluate(({ type, modelName }) => {
                    const isVideo = type === 'video';
                    const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                    const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                    let sectionContainer = null;
                    const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                    const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                    if (matchedSpan) sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                    if (!sectionContainer && sections.length > 0) sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                    if (!sectionContainer) return false;

                    const allBtns = Array.from(sectionContainer.querySelectorAll('button'));
                    const filtered = allBtns.filter(b => !b.closest('.cbQAua, [class*="cbQAua"]') && !b.closest('.gmOsyE, [class*="gmOsyE"]'));
                    const modelBtn = filtered.length > 0 ? filtered[0] : (allBtns[allBtns.length - 1] || null);
                    if (!modelBtn) return false;

                    const currentText = (modelBtn.innerText || modelBtn.textContent || '').toLowerCase();
                    const reqWords = modelName.toLowerCase().split(/\s+/).filter(w => w.length > 0);
                    return reqWords.every(w => currentText.includes(w));
                }, { type, modelName: modelStr });

                if (alreadySelected) {
                    console.log(`      ✅ Model (${type}): "${modelStr}" is ALREADY selected`);
                } else {
                    let modelConfirmed = false;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        const modelBtnInfo = await page.evaluate(({ type }) => {
                            const isVideo = type === 'video';
                            const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                            const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));

                            let sectionContainer = null;
                            const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                            const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                            if (matchedSpan) sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                            if (!sectionContainer && sections.length > 0) sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                            if (!sectionContainer) return null;

                            const allBtns = Array.from(sectionContainer.querySelectorAll('button'));
                            const filtered = allBtns.filter(b => !b.closest('.cbQAua, [class*="cbQAua"]') && !b.closest('.gmOsyE, [class*="gmOsyE"]'));
                            const modelBtn = filtered.length > 0 ? filtered[0] : (allBtns.find(b => Array.from(b.querySelectorAll('i, [class*="google-symbols"]')).some(i => (i.textContent || '').trim() === 'arrow_drop_down')) || allBtns[allBtns.length - 1]);

                            if (modelBtn) {
                                if (window.__highlight) window.__highlight(modelBtn);
                                modelBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
                                const isOpen = modelBtn.getAttribute('aria-expanded') === 'true' || modelBtn.getAttribute('data-state') === 'open';
                                const r = modelBtn.getBoundingClientRect();
                                return { isOpen, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                            }
                            return null;
                        }, { type });

                        if (modelBtnInfo && modelBtnInfo.cx > 0 && modelBtnInfo.cy > 0) {
                            if (!modelBtnInfo.isOpen) {
                                console.log(`      ⚙️ Opening Model dropdown (${type}) via hardware click at [${modelBtnInfo.cx}, ${modelBtnInfo.cy}] (attempt ${attempt})...`);
                                try { await page.mouse.click(modelBtnInfo.cx, modelBtnInfo.cy); } catch {}
                            }
                            await page.waitForTimeout(1000);

                            const optionClicked = await page.evaluate((modelName) => {
                                const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                                const searchLower = modelName.toLowerCase().trim();
                                const reqWords = searchLower.split(/\s+/).filter(w => w.length > 0);

                                const candidates = Array.from(document.querySelectorAll('button[role="menuitem"], .sc-3f41cc92-2, .sc-3f41cc92-13, [role="option"], [data-radix-collection-item]'))
                                    .filter(el => {
                                        if (!isVisible(el)) return false;
                                        if (el.classList && el.classList.contains('sc-3f41cc92-1') && !el.classList.contains('sc-3f41cc92-2')) return false;
                                        if (el.closest('.sc-c04de9ef-0')) return false;
                                        return true;
                                    });

                                let match = candidates.find(el => {
                                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                    return txt === searchLower || txt === `🍌 ${searchLower}`;
                                });

                                if (!match) {
                                    match = candidates.find(el => {
                                        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                        return reqWords.length > 0 && reqWords.every(w => txt.includes(w));
                                    });
                                }

                                if (!match) {
                                    match = candidates.find(el => {
                                        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                        return txt.includes(searchLower) || searchLower.includes(txt);
                                    });
                                }

                                if (!match) {
                                    const keyWord = reqWords.find(w => w !== 'nano' && w !== '2' && w.length >= 3) || reqWords[reqWords.length - 1];
                                    if (keyWord) {
                                        match = candidates.find(el => {
                                            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                            return txt.includes(keyWord);
                                        });
                                    }
                                }

                                if (match) {
                                    const targetBtn = match.closest('button, [role="menuitem"], [role="option"], [data-radix-collection-item]') || match;
                                    if (window.__highlight) window.__highlight(targetBtn);
                                    targetBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
                                    targetBtn.click();
                                    return true;
                                }

                                return false;
                            }, modelStr);

                            if (optionClicked) {
                                console.log(`      🎯 Selected option "${modelStr}" in dropdown`);
                            } else {
                                console.warn(`      ⚠️ Could not locate option for "${modelStr}" in open dropdown menu`);
                            }

                            await page.waitForTimeout(1000);

                            modelConfirmed = await page.evaluate(({ type, modelName }) => {
                                const isVideo = type === 'video';
                                const expectedTitle = isVideo ? 'video generation default' : 'image generation default';
                                const sections = Array.from(document.querySelectorAll('.sc-b9afcbbb-5, [class*="ebIqUq"]'));
                                let sectionContainer = null;
                                const headingSpans = Array.from(document.querySelectorAll('.sc-b9afcbbb-6, [class*="kxgCJU"], h3, span'));
                                const matchedSpan = headingSpans.find(s => s.offsetWidth > 0 && (s.innerText || s.textContent || '').trim().toLowerCase() === expectedTitle);
                                if (matchedSpan) sectionContainer = matchedSpan.closest('.sc-b9afcbbb-5, [class*="ebIqUq"]');
                                if (!sectionContainer && sections.length > 0) sectionContainer = isVideo ? (sections[2] || sections[sections.length - 1]) : (sections[1] || sections[0]);
                                if (!sectionContainer) return true;

                                const allBtns = Array.from(sectionContainer.querySelectorAll('button'));
                                const filtered = allBtns.filter(b => !b.closest('.cbQAua, [class*="cbQAua"]') && !b.closest('.gmOsyE, [class*="gmOsyE"]'));
                                const modelBtn = filtered.length > 0 ? filtered[0] : (allBtns[allBtns.length - 1] || null);
                                if (!modelBtn) return true;

                                const currentText = (modelBtn.innerText || modelBtn.textContent || '').toLowerCase();
                                const reqWords = modelName.toLowerCase().split(/\s+/).filter(w => w.length > 0);
                                return reqWords.every(w => currentText.includes(w));
                            }, { type, modelName: modelStr });

                            if (modelConfirmed) {
                                console.log(`      ✅ Model (${type}): verified "${modelStr}" is selected (attempt ${attempt})`);
                                break;
                            }
                        }
                        console.warn(`      ⚠️ Model (${type}) "${modelStr}" verification failed (attempt ${attempt}/3) — retrying...`);
                        await page.waitForTimeout(500);
                    }
                }
                await page.waitForTimeout(1000);
            }

            // ── STEP 5: Scroll Drawer & Click Save Button with Verification & Retry ─
            let saveConfirmed = false;
            for (let saveAttempt = 1; saveAttempt <= 3; saveAttempt++) {
                await page.evaluate(() => {
                    const containers = Array.from(document.querySelectorAll('.sc-b9afcbbb-3, [class*="cRumFH"], [class*="sc-b9afcbbb"], [class*="sc-e4f4e472"]'));
                    containers.forEach(c => {
                        if (c.scrollHeight > c.clientHeight) {
                            c.scrollTop = c.scrollHeight;
                        }
                    });
                });
                await page.waitForTimeout(500);

                const saveCoords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                    const allBtns = Array.from(document.querySelectorAll('button'));

                    let saveBtn = allBtns.find(b => isVisible(b) && (b.className || '').includes('sc-b9afcbbb-16'));
                    if (!saveBtn) {
                        const container = document.querySelector('.sc-b9afcbbb-15, [class*="sc-b9afcbbb-15"]');
                        if (container) saveBtn = container.querySelector('button');
                    }
                    if (!saveBtn) {
                        saveBtn = allBtns.find(b => isVisible(b) && (b.innerText || b.textContent || '').trim().toLowerCase() === 'save');
                    }

                    if (saveBtn) {
                        if (window.__highlight) window.__highlight(saveBtn);
                        saveBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
                        saveBtn.click();
                        saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
                    const drawerPresent = document.querySelector('.sc-b9afcbbb-3, [class*="cRumFH"]');
                    const textPresent = (document.body.innerText || '').includes('Agent settings');
                    return !drawerPresent && !textPresent;
                });

                if (saveConfirmed) {
                    console.log(`      ✅ Save verified — settings panel closed cleanly (attempt ${saveAttempt})`);
                    break;
                } else {
                    console.warn(`      ⚠️ Save click verification attempt ${saveAttempt}/3 — retrying click...`);
                    await page.waitForTimeout(600);
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

        // ── Step 2: Click "+ Create" button to open the All Media panel ──────
        console.log(`      📂 Opening media panel via "+Create" button...`);
        let createBtnClicked = false;

        // Check if media panel is ALREADY open first
        const isPanelAlreadyOpen = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            return Array.from(document.querySelectorAll('button, [role="button"]')).some(b => {
                if (!isVisible(b)) return false;
                const txt = (b.innerText || b.textContent || '').toLowerCase();
                return txt.includes('upload media') || txt.includes('upload');
            });
        });

        if (isPanelAlreadyOpen) {
            console.log(`      ✅ Media panel was already open!`);
            createBtnClicked = true;
        } else {
            for (let attempt = 1; attempt <= 5; attempt++) {
                const coords = await page.evaluate(() => {
                    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

                    // Strategy 1: Find prompt input element, get prompt bar container, pick the + button next to input
                    const inputEl = Array.from(document.querySelectorAll('textarea, input, [contenteditable]')).find(el => {
                        if (!isVisible(el)) return false;
                        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                        return ph.includes('create') || ph.includes('want') || ph.includes('prompt') || el.tagName.toLowerCase() === 'textarea';
                    });

                    let btn = null;
                    if (inputEl) {
                        let parent = inputEl.parentElement;
                        for (let i = 0; i < 6 && parent; i++) {
                            const btns = Array.from(parent.querySelectorAll('button, [role="button"]')).filter(b => {
                                if (!isVisible(b)) return false;
                                const txt = (b.innerText || b.textContent || '').toLowerCase();
                                return !txt.includes('agent instructions') && !txt.includes('settings') && !txt.includes('expand');
                            });
                            if (btns.length >= 1) {
                                btn = btns[0]; // Leftmost button in prompt bar is the + button!
                                break;
                            }
                            parent = parent.parentElement;
                        }
                    }

                    // Strategy 2: Search for button containing add / add_2 icon
                    if (!btn) {
                        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
                        btn = allBtns.find(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').trim();
                            const icons = Array.from(b.querySelectorAll('i, span, [class*="google-symbols"], [class*="material-icons"]'));
                            const hasAddIcon = icons.some(i => (i.textContent || '').trim().includes('add'));
                            return hasAddIcon || txt.includes('add_2') || txt === '+ Create' || txt.includes('+');
                        });
                    }

                    // Strategy 3: Find button at bottom area near prompt input (left < 450)
                    if (!btn) {
                        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
                        btn = allBtns.find(b => {
                            if (!isVisible(b)) return false;
                            const r = b.getBoundingClientRect();
                            return r.top > window.innerHeight - 200 && r.left < 450 && r.width < 100;
                        });
                    }

                    if (btn) {
                        if (window.__highlight) window.__highlight(btn);
                        const r = btn.getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                    }
                    return null;
                });

                if (coords) {
                    console.log(`      🖱️ Clicked "+Create" button at [${coords.cx}, ${coords.cy}] (attempt ${attempt}/5)...`);
                    try { await page.mouse.click(coords.cx, coords.cy); } catch {}
                    await page.waitForTimeout(1500);

                    // Verify if media panel opened by checking for "Upload media" button
                    const panelOpen = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        return Array.from(document.querySelectorAll('button, [role="button"]')).some(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').toLowerCase();
                            return txt.includes('upload media') || txt.includes('upload');
                        });
                    });

                    if (panelOpen) {
                        createBtnClicked = true;
                        console.log(`      ✅ Media panel opened successfully!`);
                        break;
                    }
                } else {
                    console.warn(`      ⚠️ "+Create" button not found (attempt ${attempt}/5)...`);
                    await page.waitForTimeout(1000);
                }
            }
        }

        if (!createBtnClicked) {
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            throw new Error(`[GoogleFX] ❌ Could not find or click "+Create" button to open media panel. Media upload failed.`);
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
                console.log(`      ⏳ Real-Time UI Tracking: Monitoring file upload & cloud processing...`);
                let uploadCompletedInUI = false;
                const uploadStartTime = Date.now();
                let lastActivityTime = Date.now();
                let lastProgressPct = -1;
                const maxStaleMs = 300000; // Allow up to 5 minutes of active progress

                while (Date.now() - lastActivityTime < maxStaleMs) {
                    const elapsedSec = Math.round((Date.now() - uploadStartTime) / 1000);

                    // Read live UI progress indicators (Percentages, Progress bars, Status text, Add to Prompt)
                    const uiProgress = await page.evaluate(() => {
                        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                        const bodyText = document.body ? document.body.innerText || '' : '';

                        // 1. Percentage tracking (e.g. 15%, 65%, 99%)
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

                        // 2. Active progressbar / spinner / loading elements
                        const hasActiveLoader = Array.from(document.querySelectorAll('[role="progressbar"], progress, [class*="progress"], [class*="spinner"], svg[class*="loading"], [class*="loader"]')).some(isVisible);

                        // 3. Active processing status text
                        const isProcessingText = bodyText.includes('Uploading') || bodyText.includes('uploading') ||
                                                 bodyText.includes('Processing') || bodyText.includes('processing') ||
                                                 bodyText.includes('Transcoding') || bodyText.includes('Saving');

                        // 4. Prompt bar attachment verification
                        const clearBtn = Array.from(document.querySelectorAll('button')).find(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').toLowerCase();
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            return txt.includes('clear prompt') || aria.includes('clear prompt') || aria.includes('remove asset');
                        });

                        // 5. Check "Add to Prompt" button
                        const addToPromptBtn = Array.from(document.querySelectorAll('button')).find(b => {
                            if (!isVisible(b)) return false;
                            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return txt === 'add to prompt' || txt.includes('add to prompt');
                        });

                        let addBtnCoords = null;
                        if (addToPromptBtn && isVisible(addToPromptBtn)) {
                            const isNativeDisabled = addToPromptBtn.disabled || addToPromptBtn.getAttribute('aria-disabled') === 'true';
                            if (!isNativeDisabled) {
                                addToPromptBtn.scrollIntoView({ block: 'center' });
                                const r = addToPromptBtn.getBoundingClientRect();
                                addBtnCoords = { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                            }
                        }

                        const candidateAsset = Array.from(document.querySelectorAll('img[src], video[src], [class*="asset"], [class*="card"], [class*="thumbnail"]')).find(el => {
                            if (!isVisible(el)) return false;
                            const r = el.getBoundingClientRect();
                            if (r.width < 25 || r.height < 25) return false;
                            const src = el.getAttribute('src') || '';
                            return !src.includes('googleusercontent') && !src.includes('gstatic') && !src.includes('avatar') && !src.includes('logo');
                        });

                        let assetCoords = null;
                        if (candidateAsset) {
                            const r = candidateAsset.getBoundingClientRect();
                            assetCoords = { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                        }

                        return {
                            currentPct,
                            hasActiveLoader,
                            isProcessingText,
                            isAttached: !!clearBtn,
                            hasAddBtn: !!addToPromptBtn,
                            addBtnCoords,
                            assetCoords,
                        };
                    });

                    // Update activity timer if UI progress is actively changing/uploading
                    if (uiProgress.currentPct !== null && uiProgress.currentPct !== lastProgressPct) {
                        console.log(`      📊 Live UI Upload Progress: ${uiProgress.currentPct}% (${elapsedSec}s)`);
                        lastProgressPct = uiProgress.currentPct;
                        lastActivityTime = Date.now();

                        if (itemId) {
                            try {
                                const jobsCol = getJobsCollection();
                                await jobsCol.updateOne(
                                    { itemId },
                                    {
                                        $set: {
                                            progressPct: uiProgress.currentPct,
                                            progressStatus: `Uploading reference media (${uiProgress.currentPct}%)...`,
                                            updatedAt: new Date(),
                                        }
                                    }
                                );
                            } catch (e) {}
                        }
                    } else if (uiProgress.hasActiveLoader || uiProgress.isProcessingText) {
                        lastActivityTime = Date.now();
                    }

                    if (uiProgress.isAttached) {
                        console.log(`      ✅ Upload & attachment complete in UI! (${elapsedSec}s)`);
                        uploadCompletedInUI = true;
                        break;
                    }

                    // If uploaded video/image asset card is detected in UI, upload is DONE!
                    if (uiProgress.assetCoords) {
                        console.log(`      ✅ Uploaded video asset detected in UI! (${elapsedSec}s) — selecting asset & attaching to prompt...`);
                        try { await page.mouse.click(uiProgress.assetCoords.cx, uiProgress.assetCoords.cy); } catch {}
                        await page.waitForTimeout(800);

                        if (uiProgress.addBtnCoords) {
                            try { await page.mouse.click(uiProgress.addBtnCoords.cx, uiProgress.addBtnCoords.cy); } catch {}
                            await page.waitForTimeout(1500);
                        }

                        uploadCompletedInUI = true;
                        break;
                    }

                    if (uiProgress.addBtnCoords) {
                        console.log(`      🖱️ Clicking enabled "Add to Prompt" button at [${uiProgress.addBtnCoords.cx}, ${uiProgress.addBtnCoords.cy}] (${elapsedSec}s)...`);
                        try { await page.mouse.click(uiProgress.addBtnCoords.cx, uiProgress.addBtnCoords.cy); } catch {}
                        await page.waitForTimeout(2000);
                    } else if (!uiProgress.hasAddBtn) {
                        const openCoords = await page.evaluate(() => {
                            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
                            const input = Array.from(document.querySelectorAll('textarea, input')).find(el => (el.getAttribute('placeholder') || '').toLowerCase().includes('create'));
                            if (input) {
                                let parent = input.parentElement;
                                for (let i = 0; i < 6 && parent; i++) {
                                    const btns = Array.from(parent.querySelectorAll('button')).filter(isVisible);
                                    if (btns.length >= 1) {
                                        const r = btns[0].getBoundingClientRect();
                                        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
                                    }
                                    parent = parent.parentElement;
                                }
                            }
                            return null;
                        });
                        if (openCoords) {
                            console.log(`      📂 Opening media panel via + button (${elapsedSec}s)...`);
                            try { await page.mouse.click(openCoords.cx, openCoords.cy); } catch {}
                            await page.waitForTimeout(1500);
                        }
                    }

                    await page.waitForTimeout(2000);
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

    async _submitPrompt(page, prompt) {
        console.log(`      ⌨️ Submitting prompt into main bottom prompt bar...`);

        // 1. Focus the main bottom prompt editor in DOM
        const focused = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const containers = Array.from(document.querySelectorAll('.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'))
                .filter(c => isVisible(c) && !c.closest('.sc-e4f4e472-3'));
            const bar = containers.length > 0 ? containers[containers.length - 1] : document.body;

            const editor = bar.querySelector('[role="textbox"], [data-slate-editor="true"], textarea, div[contenteditable="true"]')
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

        // 3. Click the Send/Create arrow button inside the prompt bar container
        const sendCoords = await page.evaluate(() => {
            const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
            const containers = Array.from(document.querySelectorAll('.sc-c9e4708a-0, .sc-5c3af813-0, [class*="sc-c9e4708a"], [class*="sc-5c3af813"]'))
                .filter(c => isVisible(c) && !c.closest('.sc-e4f4e472-3'));
            const bar = containers.length > 0 ? containers[containers.length - 1] : document;

            const controlGroup = bar.querySelector('.sc-5c3af813-10, [class*="djtHPL"]') || bar;
            const btns = Array.from(controlGroup.querySelectorAll('button'));

            const sendBtn = btns.find(b => {
                if (!isVisible(b)) return false;
                const txt = (b.innerText || b.textContent || '').trim();
                const hasArrow = Array.from(b.querySelectorAll('i, [class*="google-symbols"]'))
                    .some(i => (i.textContent || '').trim() === 'arrow_forward');
                return hasArrow || (txt.includes('Create') && !txt.includes('Agent'));
            });

            if (sendBtn) {
                if (window.__highlight) window.__highlight(sendBtn);
                sendBtn.click();
                sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
                };
            }, { targetType: type, excludedUrls: Array.from(excludedUrlSet) });

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
            const targetAsset = type === 'video' ? liveState.videoUrl : (liveState.imageUrl || liveState.videoUrl);

            if (targetAsset && liveState.mediaUrls.length > 0 && !liveState.hasActiveSpinner) {
                console.log(`      ✨ GENERATION COMPLETED! Found ${liveState.mediaUrls.length} new asset(s) in ${elapsedSec}s.`);
                console.log(`      🔗 New Generated Asset URL: ${targetAsset}`);
                resultData = {
                    videoUrl: type === 'video' ? liveState.videoUrl : null,
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
            } else if (type === 'video') {
                resultData.imageUrl = null; // Strict isolation: Video job has imageUrl = null
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
                const targetUrl = (type === 'video' ? resultData.videoUrl : resultData.imageUrl)
                    || resultData.videoUrl
                    || resultData.imageUrl
                    || (resultData.mediaUrls || [])[0];

                if (targetUrl) {
                    console.log(`      🌐 Playwright request downloading (${type}): ${targetUrl.substring(0, 80)}...`);
                    try {
                        const ext = type === 'video' ? 'mp4' : 'png';
                        const filename = `flow_${type}_${Date.now()}.${ext}`;
                        const localPath = path.join(downloadDir, filename);

                        // page.request uses Chromium's network engine with active session cookies!
                        const response = await page.request.get(targetUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Referer': 'https://labs.google/',
                            }
                        });

                        if (response.ok()) {
                            const buffer = await response.body();
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
                    const filename = resultData.filename || `flow_${type}_${Date.now()}.${type === 'video' ? 'mp4' : 'png'}`;
                    const destinationKey = `ai-content/${itemId || 'gen_unknown'}/${filename}`;
                    const contentType = type === 'video' ? 'video/mp4' : 'image/png';

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

