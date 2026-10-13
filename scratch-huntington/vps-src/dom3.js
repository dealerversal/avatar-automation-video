import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const p = b.contexts()[0].pages().find(x => x.url().includes('flow.google'));
const out = await p.evaluate(() => {
  const tune=[...document.querySelectorAll('button')].filter(e=>e.offsetWidth>0&&(e.innerText||'').trim()==='tune').map(e=>e.outerHTML.slice(0,400));
  return {tune, panelOpen:document.body.innerText.includes('Agent settings')};
});
console.log(JSON.stringify(out,null,1));
process.exit(0);
