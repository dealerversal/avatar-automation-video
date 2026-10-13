// src/utils/cookieUtils.js
// Shared cookie normalization utilities — used by both sessionManager.js and googleFxFlow.js
// Kept in utils/ to avoid circular imports between services and tools.

import fs from 'fs';
import path from 'path';

/**
 * Normalizes a single raw cookie object into Playwright-compatible cookie format.
 * Preserves the authentic domain without corrupting or duplicating it.
 */
export function normalizeCookie(cookie) {
    let domain = cookie.domain || '.google.com';

    // Normalize domain string if full URL was provided
    if (domain.startsWith('http://') || domain.startsWith('https://')) {
        try {
            domain = new URL(domain).hostname;
        } catch (_) {}
    }

    // Clean up domain
    if (domain === 'google.com') domain = '.google.com';
    if (domain === 'labs.google') domain = '.labs.google';

    // Handle expires vs expirationDate (Cookie-Editor / EditThisCookie support)
    let expires = cookie.expires;
    if (expires === undefined || expires === null) {
        expires = cookie.expirationDate;
    }
    if (expires && Number(expires) > 0) {
        expires = Number(expires);
    } else {
        expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    }

    // Handle sameSite cleanly for Playwright ('Strict' | 'Lax' | 'None')
    let sameSite = 'Lax';
    if (typeof cookie.sameSite === 'string') {
        const s = cookie.sameSite.toLowerCase().trim();
        if (s === 'no_restriction' || s === 'none') {
            sameSite = 'None';
        } else if (s === 'strict') {
            sameSite = 'Strict';
        } else if (s === 'lax' || s === 'unspecified') {
            sameSite = 'Lax';
        }
    }

    let secure = cookie.secure !== undefined ? Boolean(cookie.secure) : true;
    if (sameSite === 'None') {
        // Chromium strictly requires secure: true for SameSite=None
        secure = true;
    }

    const clean = {
        name: String(cookie.name).trim(),
        value: String(cookie.value ?? '').trim(),
        domain: domain,
        path: cookie.path || '/',
        expires: expires,
        httpOnly: Boolean(cookie.httpOnly),
        secure: secure,
        sameSite: sameSite,
    };
    return clean;
}

/**
 * Normalizes input cookies/storageState into Playwright cookie format.
 *
 * CRITICAL RULE FOR GOOGLE COOKIES:
 * NEVER duplicate parent cookies across subdomains (e.g. duplicating .google.com to flow.google.com).
 * Doing so causes Google's security filter to reject with HTTP 302 to:
 * https://accounts.google.com/CookieMismatch
 *
 * NOTE: OSID & __Secure-OSID are Origin-Specific cookies and MUST remain bound to their origin host (e.g. flow.google.com).
 *
 * Accepts:
 *   - Array of raw cookie objects
 *   - A storageState object { cookies: [...] }
 *   - A raw Cookie header string like "NAME=value; NAME2=value2"
 */
export function parseCookiesInput(input) {
    if (!input) return [];

    let rawList = [];

    if (typeof input === 'object') {
        if (Array.isArray(input)) {
            rawList = input;
        } else if (input.cookies) {
            if (Array.isArray(input.cookies)) {
                rawList = input.cookies;
            } else if (typeof input.cookies === 'string') {
                return parseCookiesInput(input.cookies);
            }
        }
    } else if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                return parseCookiesInput(parsed);
            } catch (_) {}
        }

        const pairs = trimmed.split(';');
        for (const pair of pairs) {
            const idx = pair.indexOf('=');
            if (idx > -1) {
                const name = pair.substring(0, idx).trim();
                const value = pair.substring(idx + 1).trim();
                if (name && value) {
                    rawList.push({
                        name,
                        value,
                        domain: '.google.com',
                        path: '/',
                        secure: true,
                        httpOnly: false,
                        sameSite: 'Lax',
                    });
                }
            }
        }
    }

    // Deduplicate by name + domain + path
    // Core Google auth cookies belong to .google.com so that subdomains inherit them cleanly
    const cookieMap = new Map();
    const coreGoogleAuthCookies = new Set([
        'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
        '__Secure-1PSID', '__Secure-3PSID',
        '__Secure-1PAPISID', '__Secure-3PAPISID',
        'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
        '__Secure-1PSIDTS', '__Secure-3PSIDTS',
    ]);

    for (const item of rawList) {
        if (!item || !item.name) continue;
        const normalized = normalizeCookie(item);

        // Re-scope parent auth cookies to .google.com if scoped inappropriately
        if (coreGoogleAuthCookies.has(normalized.name) &&
            normalized.domain !== '.google.com' &&
            !normalized.domain.endsWith('.google.com') &&
            !normalized.domain.includes('google.co.')) {
            normalized.domain = '.google.com';
        }

        const key = `${normalized.name}__${normalized.domain}__${normalized.path}`;
        cookieMap.set(key, normalized);
    }

    return Array.from(cookieMap.values());
}

/**
 * Safely injects an array of cookies into a Playwright browser context.
 * Uses batch addCookies first, then automatically falls back to cookie-by-cookie
 * injection so a single rejected cookie never breaks the entire session.
 */
export async function injectCookiesSafely(context, cookies, logger = console) {
    if (!context || !Array.isArray(cookies) || cookies.length === 0) return 0;

    try {
        await context.addCookies(cookies);
        return cookies.length;
    } catch (batchErr) {
        if (logger?.warn) logger.warn(`[CookieUtils] Batch addCookies failed: ${batchErr.message}. Falling back to single cookie injection...`);
        let successCount = 0;
        for (const c of cookies) {
            try {
                await context.addCookies([c]);
                successCount++;
            } catch (singleErr) {
                if (logger?.debug) logger.debug(`[CookieUtils] Skipping rejected cookie "${c.name}": ${singleErr.message}`);
            }
        }
        return successCount;
    }
}

/**
 * Recursively inspects a profile directory to locate and load ALL cookies from
 * cookies.json or storageState.json without truncation.
 *
 * @param {string} dir Directory path to scan
 * @returns {Array<Object>} Full array of cookie objects found
 */
export function findCookiesInDir(dir) {
    if (!dir || !fs.existsSync(dir)) return [];

    const candidates = ['cookies.json', 'storageState.json'];

    // 1. Check directly in dir
    for (const name of candidates) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
                if (parsed.cookies && Array.isArray(parsed.cookies) && parsed.cookies.length > 0) return parsed.cookies;
            } catch (_) {}
        }
    }

    // 2. Check direct subdirectories (e.g. browser-profile/)
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const subDir = path.join(dir, entry.name);
                for (const name of candidates) {
                    const file = path.join(subDir, name);
                    if (fs.existsSync(file)) {
                        try {
                            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
                            if (parsed.cookies && Array.isArray(parsed.cookies) && parsed.cookies.length > 0) return parsed.cookies;
                        } catch (_) {}
                    }
                }
            }
        }
    } catch (_) {}

    return [];
}
