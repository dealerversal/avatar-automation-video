import { chromium } from 'playwright';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileDir = path.resolve(__dirname, '../browser-profile');

console.log('\n======================================================');
console.log('🚀 GOOGLE FX FLOW — LOCAL SESSION SETUP');
console.log('======================================================\n');
console.log(`📁 Profile directory: ${profileDir}`);
console.log('🌐 Opening Chromium in interactive mode...\n');

async function runSetup() {
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
    });

    const page = await context.newPage();
    console.log('🔗 Navigating to https://labs.google/fx/tools/flow...');
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded' });

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
    console.error('❌ Setup error:', err);
    process.exit(1);
});
