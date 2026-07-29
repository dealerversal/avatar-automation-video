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

// Clean stale lock files if present
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

    console.log('\n------------------------------------------------------------------');
    console.log('🔑 STEP 1: LOG IN TO YOUR GOOGLE ACCOUNT IN THE OPENED BROWSER.');
    console.log('➕ STEP 2: CLICK "CREATE" OR "+ NEW PROJECT" IN THE BROWSER.');
    console.log('   (This approves Google OAuth consent & unlocks project creation!)');
    console.log('------------------------------------------------------------------');
    console.log('👉 Once a project opens and you see the prompt input bar,');
    console.log('👉 return to this terminal and press [ENTER] to save.');
    console.log('------------------------------------------------------------------\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    await new Promise((resolve) => {
        rl.question('Press [ENTER] after completing Google login & project creation...', () => {
            rl.close();
            resolve();
        });
    });

    console.log('\n💾 Saving session profile...');
    await context.close();

    // Clean ONLY heavy temporary media/script caches (preserve ServiceWorker & LocalStorage & IndexedDB)
    try {
        const cacheDirs = [
            'Default/Cache',
            'Default/Code Cache',
            'Default/GPUCache',
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
        console.log('🧹 Optimized browser profile (purged media caches while preserving auth tokens).');
    } catch (e) {}

    // Automatically create browser-profile.zip
    const projectRoot = path.resolve(__dirname, '..');
    const zipPath = path.join(projectRoot, 'browser-profile.zip');
    
    if (fs.existsSync(zipPath)) {
        try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
    }

    console.log('\n📦 Automatically creating "browser-profile.zip"...');
    try {
        const { execSync } = await import('child_process');
        execSync(`zip -q -r "${zipPath}" browser-profile`, { cwd: projectRoot });
        const stats = fs.statSync(zipPath);
        const mb = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`✅ "browser-profile.zip" created successfully (${mb} MB)!`);
    } catch (zipErr) {
        console.warn(`⚠️ Could not auto-create zip file: ${zipErr.message}`);
    }

    console.log('\n======================================================');
    console.log('✅ GOOGLE FX FLOW SESSION SAVED & ZIPPED AUTOMATICALLY!');
    console.log('======================================================');
    console.log(`1. "browser-profile.zip" is created in project root.`);
    console.log('2. Open https://gen.socialversal.online/login');
    console.log('3. Select "browser-profile.zip" to upload & sync with VPS!');
    console.log('======================================================\n');

    process.exit(0);
}

runSetup().catch((err) => {
    console.error('❌ Setup error:', err.message || err);
    process.exit(1);
});
