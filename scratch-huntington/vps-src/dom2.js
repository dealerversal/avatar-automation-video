import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const p = b.contexts()[0].pages().find(x => x.url().includes('flow.google'));
const out = await p.evaluate(() => {
  const radios=[...document.querySelectorAll('input[type=radio],[role=radio]')].map(r=>({tag:r.tagName,cls:r.className,checked:r.checked,aria:r.getAttribute('aria-checked'),w:r.offsetWidth,lbl:(r.closest('label')||r.parentElement)?.innerText?.slice(0,40)}));
  const heading=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='Agent settings');
  let c=heading; for(let i=0;i<4&&c;i++)c=c.parentElement;
  const sel=[...document.querySelectorAll('[role=combobox],mat-select,[aria-haspopup]')].filter(e=>e.offsetWidth>0).map(e=>e.outerHTML.slice(0,300));
  return {radios, sel, panel:c?c.outerHTML.slice(0,2500):null};
});
console.log(JSON.stringify(out,null,1));
process.exit(0);
