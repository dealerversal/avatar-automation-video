import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileDir = path.resolve(__dirname, '../browser-profile');

console.log('\n======================================================');
console.log('🚀 GOOGLE FX FLOW — LOCAL SESSION SETUP');
console.log('======================================================\n');
console.log(`📁 Profile directory: ${profileDir}`);

// Clean lock files if present
if (fs.existsSync(profileDir)) {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort'];
    for (const f of lockFiles) {
        const lockPath = path.join(profileDir, f);
        if (fs.existsSync(lockPath)) {
            try {
                fs.rmSync(lockPath, { force: true });
            } catch (e) {}
        }
    }
} else {
    fs.mkdirSync(profileDir, { recursive: true });
}

console.log('🌐 Opening browser in interactive mode...\n');

async function runSetup() {
    let context;
    
    // Attempt 1: Try launching local Google Chrome (most stable on macOS)
    try {
        console.log('💡 Launching Google Chrome...');
        context = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless: false,
            viewport: { width: 1280, height: 800 },
        });
    } catch (e1) {
        console.warn('⚠️ Google Chrome channel not available, trying bundled Playwright Chromium...');
        // Attempt 2: Bundled Playwright Chromium without extra args
        try {
            context = await chromium.launchPersistentContext(profileDir, {
                headless: false,
                viewport: { width: 1280, height: 800 },
            });
        } catch (e2) {
            console.error('❌ Could not launch browser:', e2.message);
            process.exit(1);
        }
    }

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    console.log('🔗 Navigating to https://labs.google/fx/tools/flow...');
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded' }).catch(() => {});

    console.log('\n------------------------------------------------------');
    console.log('🔑 PLEASE LOG IN TO YOUR GOOGLE ACCOUNT IN THE BROWSER.');
    console.log('------------------------------------------------------');
    console.log('👉 Once logged in and on the Google FX Flow tool page,');
    console.log('👉 return to this terminal and press [ENTER] to save.');
    console.log('------------------------------------------------------\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    await new Promise((resolve) => {
        rl.question('Press [ENTER] after completing Google login in browser...', () => {
            rl.close();
            resolve();
        });
    });

    console.log('\n💾 Saving session profile...');
    await context.close();

    // Clean heavy non-essential caches to shrink zip file size (60MB -> 2MB)
    try {
        const cacheDirs = [
            'Default/Cache',
            'Default/Code Cache',
            'Default/GPUCache',
            'Default/Service Worker/CacheStorage',
            'Default/Service Worker/ScriptCache',
            'Default/DawnCache',
            'GraphiteDawnCache',
            'Crashpad',
        ];
        for (const dir of cacheDirs) {
            const fullPath = path.join(profileDir, dir);
            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            }
        }
        console.log('🧹 Purged temporary browser caches (Profile optimized & lightweight).');
    } catch (e) {}

    console.log('\n======================================================');
    console.log('✅ GOOGLE FX FLOW SESSION SAVED SUCCESSFULLY!');
    console.log('======================================================');
    console.log('1. Zip your local "browser-profile" folder into "browser-profile.zip".');
    console.log('2. Go to https://gen.socialversal.online/login');
    console.log('3. Upload "browser-profile.zip" to sync with VPS!');
    console.log('======================================================\n');

    process.exit(0);
}

runSetup().catch((err) => {
    console.error('❌ Setup error:', err.message || err);
    process.exit(1);
});
