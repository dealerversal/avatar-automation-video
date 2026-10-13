import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const p = b.contexts()[0].pages().find(x => x.url().includes('flow.google'));
await p.mouse.click(1235, 755);
await p.waitForTimeout(4000);
await p.screenshot({ path: '/tmp/after_click.png' });
const info = await p.evaluate(() => ({ txt: document.body.innerText.slice(-600), toasts: [...document.querySelectorAll('[role=alert],[role=status],snack-bar,[class*=toast],[class*=snack]')].map(e=>e.innerText) }));
console.log(JSON.stringify(info));
process.exit(0);
