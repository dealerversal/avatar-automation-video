import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileDir = path.resolve(__dirname, '../browser-profile');

console.log('\n🧪 Testing Google FX Flow Session with browser profile...');

async function runTest() {
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await context.newPage();
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    const cookies = await context.cookies(['https://labs.google', 'https://google.com']);
    await context.close();

    console.log(`🔗 Final Page URL: ${url}`);
    console.log(`🍪 Cookies Count: ${cookies.length}`);

    if (cookies.length > 5) {
        console.log('✅ Local Google FX Flow Session is Active!\n');
    } else {
        console.log('⚠️ Session seems inactive. Please run `npm run setup` again.\n');
    }
}

runTest().catch((err) => {
    console.error('❌ Test error:', err.message);
});
