// Same measurement harness as v0.4.68, but driving the composer through its REAL states
// (via the app's own syncComposerMode) now that the buttons live inside the pill.
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
const OUT = process.argv[2];
const FILE = process.argv[3] || "file:///home/ubuntu/projects/cc-bridge/webapp/index.html";
const SCALE = 10, PAD = 3;
const b = await chromium.launch();
for (const scheme of ["dark","light"]) {
  const page = await b.newPage({ viewport:{width:420,height:760}, deviceScaleFactor:SCALE, colorScheme:scheme });
  page.on("pageerror",()=>{});
  await page.goto(FILE,{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(300);
  await page.evaluate(()=>document.getElementById("drill").classList.add("show"));
  const shot = async (id,name) => {
    const r = await page.locator("#"+id).evaluate(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}});
    for (let i=0;i<5;i++){ try { await page.screenshot({path:`${OUT}/${scheme}-${name}.png`,
      clip:{x:r.x-PAD,y:r.y-PAD,width:r.width+2*PAD,height:r.height+2*PAD}}); break; } catch { await page.waitForTimeout(400); } }
  };
  await shot("dmic","mic-idle");
  await page.evaluate(()=>document.getElementById("dmic").disabled=true);
  await shot("dmic","mic-disabled");
  await page.evaluate(()=>{ const m=document.getElementById("dmic"); m.disabled=false; m.classList.add("recing");
    m.querySelector("svg").outerHTML='<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor"/></svg>'; });
  await shot("dmic","mic-recording");
  // Real send state: type text and let the app swap the button itself.
  await page.reload({waitUntil:"domcontentloaded"}); await page.waitForTimeout(250);
  await page.evaluate(()=>{ document.getElementById("drill").classList.add("show");
    const t=document.getElementById("dtext"); t.value="hello"; t.dispatchEvent(new Event("input")); });
  await shot("dsend","send");
  console.log(scheme, JSON.stringify(await page.evaluate(()=>({
    micVisible: getComputedStyle(document.getElementById("dmic")).display,
    sendVisible: getComputedStyle(document.getElementById("dsend")).display,
    sendTransform: getComputedStyle(document.querySelector("#dsend svg")).transform,
    micTransform: getComputedStyle(document.querySelector("#dmic svg")).transform }))));
  await page.close();
}
await b.close();
