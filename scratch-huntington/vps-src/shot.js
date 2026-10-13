import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
let i = 0;
for (const ctx of b.contexts()) for (const p of ctx.pages()) {
  const f = `/tmp/shot_${Date.now()}_${i++}.png`;
  await p.screenshot({ path: f }).catch(e => console.log('err', e.message));
  console.log(p.url(), f);
}
process.exit(0);
