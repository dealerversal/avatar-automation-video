// test-local-avatar.js
import { connectDB, getActiveProxyFromDB } from './src/db.js';
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileDir = path.resolve(__dirname, 'browser-profile');

async function testLocalWithProxy() {
    console.log('\n' + '═'.repeat(60));
    console.log('🚀 [Local Avatar Test] Initializing DB and Proxy Verification...');
    console.log('═'.repeat(60));

    // 1. Connect to DB
    await connectDB();

    // 2. Fetch Proxy Credentials from DB
    console.log('\n📥 Fetching active proxy credentials from MongoDB (system_proxies)...');
    const proxyConfig = await getActiveProxyFromDB();

    if (!proxyConfig) {
        console.error('❌ No active proxy found in database! Please ensure system_proxies has enabled proxies.');
        process.exit(1);
    }

    console.log('✅ Proxy credentials loaded successfully from DB:');
    console.log(`   🌐 Server       : ${proxyConfig.server}`);
    console.log(`   🖥️ Display Host : ${proxyConfig.displayHost}`);
    console.log(`   👤 Username     : ${proxyConfig.username}`);
    console.log(`   🔑 Password     : ${proxyConfig.password ? '******' : 'None'}`);
    console.log(`   🌍 Country      : ${proxyConfig.countryCode || 'N/A'}`);

    // Remove stale locks
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
    for (const f of lockFiles) {
        const p = path.join(profileDir, f);
        if (existsSync(p)) {
            try { await import('fs/promises').then(fsP => fsP.unlink(p)); } catch {}
        }
    }

    // 3. Launch Playwright with headless: false
    console.log('\n🖥️ Launching Chromium in HEADLESS: FALSE mode with proxy...');
    const isMac = process.platform === 'darwin';
    const launchOptions = {
        headless: false,
        args: [
            ...(isMac ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800',
            '--disable-http2',
            '--disable-quic',
        ],
        proxy: {
            server: proxyConfig.server,
            username: proxyConfig.username || undefined,
            password: proxyConfig.password || undefined,
        },
    };

    const context = await chromium.launchPersistentContext(profileDir, launchOptions);

    // Auto-inject cookies
    const cookiesJsonPath = path.join(profileDir, 'cookies.json');
    if (existsSync(cookiesJsonPath)) {
        try {
            const cData = JSON.parse(readFileSync(cookiesJsonPath, 'utf8'));
            if (Array.isArray(cData) && cData.length > 0) {
                await context.addCookies(cData);
                console.log(`🍪 Injected ${cData.length} cookies from cookies.json`);
            }
        } catch (e) {
            console.warn('⚠️ Could not inject cookies:', e.message);
        }
    }

    const page = await context.newPage();

    // 4. Verify Proxy IP
    console.log('\n🔎 Step 1: Checking browser public IP through proxy...');
    try {
        await page.goto('https://ipv4.icanhazip.com', { timeout: 15000 });
        const detectedIp = (await page.textContent('body')).trim();
        console.log(`   ✅ Browser Public IP via Proxy: ${detectedIp}`);
    } catch (e) {
        console.warn(`   ⚠️ IP check failed: ${e.message}`);
    }

    // 5. Navigate to Google Flow
    console.log('\n🌍 Step 2: Navigating to Google Flow (https://flow.google.com/) ...');
    const t0 = Date.now();
    await page.goto('https://flow.google.com/', { waitUntil: 'commit', timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const loadTime = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`   ✅ Google Flow loaded in ${loadTime}s! URL: ${page.url()}`);

    console.log('\n✨ Browser will stay open for 20 seconds so you can see it on your screen...');
    await page.waitForTimeout(20000);

    await context.close();
    console.log('🔒 Browser closed. Local test completed successfully!\n');
    process.exit(0);
}

testLocalWithProxy().catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
