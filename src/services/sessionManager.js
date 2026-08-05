// src/services/sessionManager.js
import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { closeSharedContext } from '../tools/googleFxFlow.js';

const GOOGLE_FX_URL = 'https://labs.google/fx/tools/flow';

/**
 * Normalizes input cookies/storageState into Playwright cookie format.
 */
function parseCookiesInput(input) {
    if (!input) return [];

    // If input is an object or array (parsed JSON)
    if (typeof input === 'object') {
        if (Array.isArray(input)) {
            return input.map(normalizeCookie);
        }
        if (input.cookies && Array.isArray(input.cookies)) {
            return input.cookies.map(normalizeCookie);
        }
    }

    // If input is a raw Cookie Header string e.g. "COOKIE1=val1; COOKIE2=val2"
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                return parseCookiesInput(parsed);
            } catch (err) {
                // Not valid JSON, proceed as header string
            }
        }

        const pairs = trimmed.split(';');
        const cookies = [];
        for (const pair of pairs) {
            const idx = pair.indexOf('=');
            if (idx > -1) {
                const name = pair.substring(0, idx).trim();
                const value = pair.substring(idx + 1).trim();
                if (name && value) {
                    cookies.push({
                        name,
                        value,
                        domain: '.google.com',
                        path: '/',
                        secure: true,
                        httpOnly: false,
                        sameSite: 'Lax',
                    });
                    cookies.push({
                        name,
                        value,
                        domain: 'labs.google',
                        path: '/',
                        secure: true,
                        httpOnly: false,
                        sameSite: 'Lax',
                    });
                }
            }
        }
        return cookies;
    }

    return [];
}

function normalizeCookie(cookie) {
    const clean = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.google.com',
        path: cookie.path || '/',
        expires: cookie.expires && cookie.expires > 0 ? cookie.expires : Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
    };
    if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
        clean.sameSite = cookie.sameSite;
    }
    return clean;
}

export class SessionManager {
    /**
     * Checks if current browser-profile is logged into Google FX Flow.
     */
    static async checkStatus() {
        const profileDir = config.browser.profileDir;
        logger.info(`[SessionManager] Checking auth status for profile at: ${profileDir}`);

        if (!existsSync(profileDir)) {
            return {
                authenticated: false,
                message: 'No browser profile directory found on server.',
            };
        }

        await closeSharedContext();

        let context = null;
        const checkOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-gpu',
                '--disable-dev-shm-usage',
            ],
            viewport: { width: 1280, height: 720 },
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        };

        try {
            try {
                context = await chromium.launchPersistentContext(profileDir, {
                    ...checkOptions,
                    channel: 'chrome',
                    ignoreDefaultArgs: ['--enable-automation'],
                });
            } catch (cErr) {
                context = await chromium.launchPersistentContext(profileDir, checkOptions);
            }

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.navigator.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            const page = await context.newPage();
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

            await page.waitForTimeout(4000);
            const currentUrl = page.url();
            const pageTitle = await page.title();

            const isSignInVisible = await page
                .locator('text=/Sign in|Log in/i')
                .isVisible()
                .catch(() => false);

            const hasPromptInput = await page
                .locator('textarea, [contenteditable="true"], button:has-text("Generate")')
                .count()
                .then((cnt) => cnt > 0)
                .catch(() => false);

            // Attempt to extract user info from Google Account avatar / DOM
            let user = null;
            try {
                const accountElem = await page
                    .locator('a[aria-label*="Google Account"], button[aria-label*="Google Account"], img[src*="googleusercontent.com"], [aria-label*="@gmail.com"]')
                    .first();
                if (await accountElem.count() > 0) {
                    const ariaLabel = (await accountElem.getAttribute('aria-label')) || '';
                    const avatarSrc = await page
                        .locator('img[src*="googleusercontent.com"]')
                        .first()
                        .getAttribute('src')
                        .catch(() => null);

                    let email = null;
                    let name = null;

                    const emailMatch = ariaLabel.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                    if (emailMatch) {
                        email = emailMatch[1];
                    }

                    const nameMatch = ariaLabel.match(/Google Account:\s*([^(]+)/i);
                    if (nameMatch) {
                        name = nameMatch[1].trim();
                    }

                    if (email || name || avatarSrc) {
                        user = {
                            name: name || (email ? email.split('@')[0] : 'Google User'),
                            email: email || null,
                            avatar: avatarSrc || null,
                        };
                    }
                }
            } catch (e) {
                logger.warn('[SessionManager] Could not extract detailed user info: ' + e.message);
            }

            const cookies = await context.cookies();
            const hasGoogleCookies = cookies.some((c) => c.name.includes('SID') || c.name.includes('HSID') || c.name.includes('SSID'));

            await context.close();

            const authenticated = (hasPromptInput || hasGoogleCookies) && !currentUrl.includes('accounts.google.com');

            return {
                authenticated,
                url: currentUrl,
                title: pageTitle,
                user,
                cookieCount: cookies.length,
                hasGoogleCookies,
                message: authenticated
                    ? 'Successfully authenticated with Google FX Flow!'
                    : 'Not authenticated with Google. Please upload your browser-profile.zip.',
            };
        } catch (error) {
            if (context) await context.close().catch(() => {});
            logger.error('[SessionManager] Error checking status:', error);
            return {
                authenticated: false,
                error: error.message,
                message: 'Failed to verify session status.',
            };
        }
    }

    /**
     * Imports cookies/storageState OR performs automated Google credentials login into persistent profile.
     */
    static async importSession(payload) {
        const profileDir = config.browser.profileDir;
        logger.info(`[SessionManager] Importing session into profile: ${profileDir}`);

        if (!existsSync(profileDir)) {
            mkdirSync(profileDir, { recursive: true });
        }

        const { cookies, storageState, email, password } = payload || {};
        const inputData = storageState || cookies;

        if (!inputData && (!email || !password)) {
            throw new Error('Please provide either cookies/storageState OR Google Email & Password.');
        }

        let context = null;
        try {
            context = await chromium.launchPersistentContext(profileDir, {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                ],
                viewport: { width: 1280, height: 720 },
            });

            const page = await context.newPage();

            // Perform Automated Google Credential Login if email & password are provided
            if (email && password) {
                logger.info(`[SessionManager] Performing Google Sign-In for email: ${email}`);
                await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(1500);

                const emailInput = page.locator('input[type="email"]');
                if (await emailInput.count() > 0) {
                    await emailInput.fill(email);
                    await page.click('#identifierNext, button:has-text("Next")');
                    await page.waitForTimeout(2500);
                }

                const passwordInput = page.locator('input[type="password"]');
                if (await passwordInput.count() > 0) {
                    await passwordInput.fill(password);
                    await page.click('#passwordNext, button:has-text("Next")');
                    await page.waitForTimeout(4000);
                }
            }

            // Inject cookies / storageState if provided
            if (inputData) {
                const cookiesToSet = parseCookiesInput(inputData);
                if (cookiesToSet && cookiesToSet.length > 0) {
                    await context.addCookies(cookiesToSet);
                }
            }

            // Verify Google FX Flow navigation
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            const finalUrl = page.url();
            const cookiesStored = await context.cookies(['https://labs.google', 'https://google.com']);

            await context.close();

            logger.info(`[SessionManager] Successfully saved profile with ${cookiesStored.length} cookies.`);

            return {
                success: true,
                cookiesStored: cookiesStored.length,
                finalUrl,
                message: 'Google session successfully authenticated and saved into VPS profile!',
            };
        } catch (error) {
            if (context) await context.close().catch(() => {});
            logger.error('[SessionManager] Failed to import session:', error);
            throw new Error(`Failed to save session profile: ${error.message}`);
        }
    }

    /**
     * Uploads and extracts a browser-profile.zip archive into the VPS profile directory.
     */
    static async uploadProfileZip(zipBuffer) {
        const profileDir = config.browser.profileDir;
        logger.info(`[SessionManager] Uploading browser profile zip into: ${profileDir}`);

        if (!zipBuffer || zipBuffer.length === 0) {
            throw new Error('No zip file data received.');
        }

        const tempZipPath = path.join('/tmp', `browser-profile-${Date.now()}.zip`);
        const { writeFileSync, unlinkSync, readdirSync, cpSync } = await import('fs');
        const { execSync } = await import('child_process');

        try {
            writeFileSync(tempZipPath, zipBuffer);

            await closeSharedContext();

            if (existsSync(profileDir)) {
                rmSync(profileDir, { recursive: true, force: true });
            }
            mkdirSync(profileDir, { recursive: true });

            execSync(`unzip -o ${tempZipPath} -d ${profileDir}`);

            const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
            for (const file of lockFiles) {
                const lockPath = path.join(profileDir, file);
                if (existsSync(lockPath)) {
                    rmSync(lockPath, { force: true });
                }
            }

            const nestedProfile = path.join(profileDir, 'browser-profile');
            if (existsSync(nestedProfile)) {
                cpSync(nestedProfile, profileDir, { recursive: true });
                rmSync(nestedProfile, { recursive: true, force: true });
            }

            if (existsSync(tempZipPath)) {
                unlinkSync(tempZipPath);
            }

            logger.info(`[SessionManager] Successfully extracted browser profile zip. Verifying auth status...`);

            const statusResult = await this.checkStatus();

            // Trigger PM2 reload asynchronously after 500ms
            setTimeout(async () => {
                try {
                    const { exec } = await import('child_process');
                    logger.info('[SessionManager] Reloading PM2 process after browser profile upload...');
                    exec('/usr/bin/pm2 restart gen.socialversal.online || pm2 restart gen.socialversal.online', (err) => {
                        if (err) logger.warn(`[SessionManager] PM2 reload note: ${err.message}`);
                    });
                } catch (e) {}
            }, 500);

            return {
                success: true,
                ...statusResult,
                message: statusResult.authenticated
                    ? 'Browser profile uploaded, extracted, and server reloaded successfully!'
                    : 'Browser profile uploaded and extracted successfully!',
            };
        } catch (error) {
            if (existsSync(tempZipPath)) {
                try { unlinkSync(tempZipPath); } catch (e) {}
            }
            logger.error('[SessionManager] Failed to extract uploaded profile zip:', error);
            throw new Error(`Failed to extract uploaded profile zip: ${error.message}`);
        }
    }

    /**
     * Clears the current persistent profile directory on VPS.
     */
    static async clearSession() {
        const profileDir = config.browser.profileDir;
        if (existsSync(profileDir)) {
            rmSync(profileDir, { recursive: true, force: true });
            mkdirSync(profileDir, { recursive: true });
        }
        return { success: true, message: 'Browser profile directory cleared successfully.' };
    }
}
