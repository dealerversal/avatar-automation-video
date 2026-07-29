// src/services/sessionManager.js
import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

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
    let domain = cookie.domain || '.google.com';
    if (!domain.startsWith('.')) {
        domain = '.' + domain;
    }
    return {
        name: cookie.name,
        value: cookie.value,
        domain: domain,
        path: cookie.path || '/',
        expires: cookie.expires || Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : false,
        secure: cookie.secure !== undefined ? cookie.secure : true,
        sameSite: cookie.sameSite || 'Lax',
    };
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
                    : 'Not authenticated with Google. Please import valid session cookies.',
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
     * Imports cookies/storageState into the persistent browser profile.
     */
    static async importSession(inputData) {
        const profileDir = config.browser.profileDir;
        logger.info(`[SessionManager] Importing session into profile: ${profileDir}`);

        if (!existsSync(profileDir)) {
            mkdirSync(profileDir, { recursive: true });
        }

        const cookiesToSet = parseCookiesInput(inputData);

        if (!cookiesToSet || cookiesToSet.length === 0) {
            throw new Error('No valid cookies or storage state could be parsed from input.');
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

            // If storageState object with origins/localStorage was provided
            if (typeof inputData === 'object' && inputData.origins && Array.isArray(inputData.origins)) {
                for (const originState of inputData.origins) {
                    if (originState.origin && Array.isArray(originState.localStorage)) {
                        const page = await context.newPage();
                        try {
                            await page.goto(originState.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
                            for (const item of originState.localStorage) {
                                await page.evaluate(
                                    ({ k, v }) => localStorage.setItem(k, v),
                                    { k: item.name, v: item.value }
                                );
                            }
                        } catch (e) {
                            logger.warn(`[SessionManager] Could not set localStorage for ${originState.origin}: ${e.message}`);
                        } finally {
                            await page.close().catch(() => {});
                        }
                    }
                }
            }

            // Set all cookies across google domains
            await context.addCookies(cookiesToSet);

            // Test navigation to FX Flow
            const page = await context.newPage();
            await page.goto(GOOGLE_FX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            const finalUrl = page.url();
            const cookiesStored = await context.cookies(['https://labs.google', 'https://google.com']);

            await context.close();

            logger.info(`[SessionManager] Successfully imported ${cookiesStored.length} cookies into persistent profile.`);

            return {
                success: true,
                cookiesStored: cookiesStored.length,
                finalUrl,
                message: 'Session successfully imported and saved into VPS browser profile!',
            };
        } catch (error) {
            if (context) await context.close().catch(() => {});
            logger.error('[SessionManager] Failed to import session:', error);
            throw new Error(`Failed to save session profile: ${error.message}`);
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
