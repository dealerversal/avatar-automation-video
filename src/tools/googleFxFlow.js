// src/tools/googleFxFlow.js
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
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
            sharedContext = await chromium.launchPersistentContext(profileDir, {
                headless: config.browser.headless,
                slowMo: config.browser.slowMo,
                args: [
                    '--start-maximized',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-popup-blocking',
                    '--disable-infobars',
                    '--suppress-message-center-popups',
                ],
                viewport: null,
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            });

            await sharedContext.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                let currentHighlight = null;
                let highlightTimer = null;

                // Visual highlight effect for exact element being clicked
                const highlight = (el) => {
                    if (!el || !(el instanceof HTMLElement)) return;
                    try {
                        // Clear highlight from previous element immediately so only ONE element is highlighted
                        if (currentHighlight && currentHighlight !== el) {
                            try {
                                currentHighlight.style.outline = currentHighlight._origOutline || '';
                                currentHighlight.style.boxShadow = currentHighlight._origBoxShadow || '';
                                currentHighlight.style.transition = currentHighlight._origTransition || '';
                            } catch {}
                        }

                        if (highlightTimer) clearTimeout(highlightTimer);

                        // Save original style properties
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
        } finally {
            isInitializing = false;
        }

        return sharedContext;
    }

    async execute({ itemId, prompt, type = 'video', settings = {} }) {
        const execStart = Date.now();
        console.log('\n' + '─'.repeat(60));
        console.log('🌐  [GoogleFxFlowTool] BROWSER AUTOMATION STARTED');
        console.log('─'.repeat(60));
        console.log(`🆔  Job ID : ${itemId || 'N/A'}`);
        console.log(`🎬  Type   : ${type.toUpperCase()}`);
        console.log(`💬  Prompt : "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
        console.log(`⚙️   Settings: ${JSON.stringify(settings)}`);
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
            await this._dismissOverlays(page);
            const projectUrl = page.url();
            console.log(`      ✅ New project opened: ${projectUrl}`);

            // Session check after project creation too
            if (projectUrl.includes('accounts.google.com') || projectUrl.includes('signin')) {
                throw new Error('Google session expired after project creation. Please re-login in the browser profile.');
            }

            // 3. Configure Mode (Video/Image) and Settings
            console.log(`\n[4/6] ⚙️ Configuring generator mode (${type}) and settings...`);
            await this._applySettings(page, type, settings);


            // 4. Enter Prompt & Submit
            console.log(`\n[5/6] ⌨️ Submitting prompt into generation bar...`);
            await this._submitPrompt(page, prompt);
            console.log(`      ✅ Prompt submitted!`);

            // 5. Poll and Extract Results & Download Local Asset
            console.log(`\n[6/6] ⏳ Polling for ${type} generation completion, downloading asset & saving locally...`);
            const result = await this._extractResult(page, type, itemId);

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
    }

    async _extractResult(page, type, itemId) {
        const timeoutMs = config.browser.timeoutMs || 240000;
        const startTime = Date.now();
        const pollInterval = 3000;

        console.log(`      ⏳ Initial 5s delay for ${type} generation to initialize on Google Flow...`);
        await page.waitForTimeout(5000);

        let resultData = null;

        while (Date.now() - startTime < timeoutMs) {
            const extracted = await page.evaluate((targetType) => {
                const mediaUrls = [];
                let videoUrl = null;
                let imageUrl = null;

                // Helper to check if URL/img is profile photo, avatar, or UI icon
                const isProfileOrUi = (src, imgEl) => {
                    if (!src || src.startsWith('data:')) return true;
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

                    if (imgEl && ((imgEl.clientWidth > 0 && imgEl.clientWidth < 150) || (imgEl.clientHeight > 0 && imgEl.clientHeight < 150))) {
                        return true;
                    }
                    return false;
                };

                // Scan videos
                document.querySelectorAll('video').forEach((vid) => {
                    const src = vid.getAttribute('src') || (vid.querySelector('source') && vid.querySelector('source').getAttribute('src'));
                    if (src && !src.startsWith('data:')) {
                        mediaUrls.push(src);
                        if (!videoUrl) videoUrl = src;
                    }
                });

                // Scan generated images ONLY
                document.querySelectorAll('img').forEach((img) => {
                    const src = img.getAttribute('src') || '';
                    if (!isProfileOrUi(src, img)) {
                        mediaUrls.push(src);
                        if (!imageUrl) imageUrl = src;
                    }
                });

                // Check for active progress spinners or generating indicators
                const isGenerating =
                    document.querySelector('[class*="spinner"]') !== null ||
                    document.querySelector('[class*="loading"]') !== null ||
                    document.querySelector('[class*="progress"]') !== null ||
                    document.querySelector('[class*="generating"]') !== null ||
                    (document.body && document.body.innerText.includes('Generating'));

                const textContent = (document.body && document.body.innerText) ? document.body.innerText.substring(0, 3000) : '';

                return {
                    mediaUrls: Array.from(new Set(mediaUrls)),
                    videoUrl: targetType === 'video' ? (videoUrl || mediaUrls[0] || null) : null,
                    imageUrl: targetType === 'image' ? (imageUrl || mediaUrls[0] || null) : null,
                    isGenerating,
                    text: textContent,
                };
            }, type);

            const elapsedSec = Math.round((Date.now() - startTime) / 1000);

            // If target asset type is found and generation spinners have stopped
            const hasTargetAsset = type === 'video' ? extracted.videoUrl : extracted.imageUrl;

            if (hasTargetAsset && !extracted.isGenerating) {
                console.log(`      ✅ ${type.toUpperCase()} asset generated after ${elapsedSec}s!`);
                resultData = {
                    videoUrl: type === 'video' ? extracted.videoUrl : null,
                    imageUrl: type === 'image' ? extracted.imageUrl : null,
                    mediaUrls: extracted.mediaUrls,
                    text: extracted.text,
                };
                break;
            }

            console.log(`      ⏳ Generation in progress (${elapsedSec}s)... found ${extracted.mediaUrls.length} AI assets`);
            await page.waitForTimeout(pollInterval);
        }

        if (!resultData) {
            // Timeout fallback: extract whatever is present (STRICTLY EXCLUDING PROFILES)
            resultData = await page.evaluate((targetType) => {
                const mediaUrls = [];
                document.querySelectorAll('video[src], video source[src], img[src]').forEach((el) => {
                    const src = el.getAttribute('src') || '';
                    const lowerSrc = src.toLowerCase();
                    const isProfile =
                        lowerSrc.includes('googleusercontent.com') ||
                        lowerSrc.includes('lh3.google') ||
                        lowerSrc.includes('ggpht.com') ||
                        lowerSrc.includes('profile') ||
                        lowerSrc.includes('avatar') ||
                        lowerSrc.includes('favicon') ||
                        lowerSrc.includes('gstatic');
                    if (src && !isProfile) mediaUrls.push(src);
                });
                return {
                    videoUrl: targetType === 'video' ? (mediaUrls.find((u) => u.includes('.mp4') || u.includes('video')) || mediaUrls[0] || null) : null,
                    imageUrl: targetType === 'image' ? (mediaUrls.find((u) => !u.includes('googleusercontent') && (!u.includes('.mp4'))) || mediaUrls[0] || null) : null,
                    mediaUrls: Array.from(new Set(mediaUrls)),
                    text: document.body.innerText.substring(0, 3000),
                };
            }, type);
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

