import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileDir = path.resolve(__dirname, '../browser-profile');

console.log('\n🧪 Testing Google FX Flow Session with browser profile...');

async function runTest() {
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        channel: 'chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const cookiesPath = path.join(profileDir, 'cookies.json');
    if (fs.existsSync(cookiesPath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await context.addCookies(cookies);
        console.log(`🍪 Injected ${cookies.length} cookies from cookies.json`);
    }

    const page = await context.newPage();
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const url = page.url();
    const cookies = await context.cookies(['https://labs.google', 'https://google.com']);
    await context.close();

    console.log(`🔗 Final Page URL: ${url}`);
    console.log(`🍪 Cookies Count: ${cookies.length}`);

    if (url.includes('/flow') && !url.includes('/about')) {
        console.log('✅ Local Google FX Flow Session is Active!\n');
    } else {
        console.log(`⚠️ URL is ${url}.\n`);
    }
}

runTest().catch((err) => {
    console.error('❌ Test error:', err.message);
});
