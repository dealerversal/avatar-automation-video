import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const p = b.contexts()[0].pages().find(x => x.url().includes('flow.google'));
// list candidate buttons in bottom-right prompt bar
const btns = await p.evaluate(() => [...document.querySelectorAll('button')].filter(e=>e.offsetWidth>0).map(e=>{const r=e.getBoundingClientRect();return {t:(e.innerText||'').trim().slice(0,30),aria:e.getAttribute('aria-label'),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width)}}).filter(o=>o.x>900&&o.y>600));
console.log('BTNS', JSON.stringify(btns));
await p.mouse.click(1199, 755);
await p.waitForTimeout(1500);
await p.screenshot({ path: '/tmp/panel.png' });
const dom = await p.evaluate(() => {
  const els=[...document.querySelectorAll('[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[data-state=open]')].filter(e=>e.offsetWidth>0);
  return els.map(e=>e.outerHTML.slice(0,3500));
});
console.log('DOM', JSON.stringify(dom, null, 1));
process.exit(0);
