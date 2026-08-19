import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Screenshots go BESIDE THIS SCRIPT, the way every sibling here resolves its own files. `shots/…`
// was relative to the CWD, so a run started from the repo root left a second, byte-identical copy
// at the top level — outside `scripts/webapp-measure/*shots*/`, which is where the root .gitignore
// already covers this harness's output, so it sat in `git status` for a week (2026-08-12).
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOT = n => join(HERE, "shots", n);
// Every case measures TWICE: immediately, and again after idling through two 3s repaint cycles.
// A timer-driven regression is invisible to a check that measures straight after acting.
const IDLE = 7000;
const b = await chromium.launch();
const open = async (w=390,h=760) => {
  const p = await b.newPage({ viewport:{width:w,height:h}, deviceScaleFactor:2 });
  p.on("pageerror",()=>{});
  await p.goto("file:///home/ubuntu/projects/cc-bridge/webapp/index.html",{waitUntil:"domcontentloaded"});
  await p.waitForTimeout(300);
  await p.evaluate(()=>{ window.api = async path => path.includes("feed")
      ? { working:false, items:Array.from({length:12},(_,i)=>({text:"message "+(i+1),at:Date.now()-i*1000,role:i%2?"user":"assistant"})) } : {};
    openDrill("fake-sid","fake"); });
  await p.waitForTimeout(400);
  await p.locator("#dtext").focus();
  return p;
};
const read = p => p.evaluate(()=>{ const ta=document.getElementById("dtext");
  const lh=parseFloat(getComputedStyle(ta).lineHeight); const max=ta.scrollHeight-ta.clientHeight;
  return { scrollTop:Math.round(ta.scrollTop), maxScroll:max,
           atBottom: max===0 || Math.abs(ta.scrollTop-max)<12, atTop: ta.scrollTop<1,
           caretLine: ta.value.slice(0,ta.selectionStart).split("\n").length,
           h:+ta.getBoundingClientRect().height.toFixed(1) }; });
const fill = async p => { for (const n of [1,2,3,4])
  await p.keyboard.type("This is sentence number "+n+" and it keeps going with plenty of extra words to force wrapping onto further lines. "); };
const row = async (label, p, want) => {
  const now = await read(p);
  await p.waitForTimeout(IDLE);
  const rest = await read(p);
  const ok = want==="bottom" ? rest.atBottom : (want==="notBottom" ? !rest.atBottom : rest.atTop);
  console.log(`${label.padEnd(34)} now=${String(now.scrollTop).padStart(4)}/${String(now.maxScroll).padStart(4)}  rest=${String(rest.scrollTop).padStart(4)}/${String(rest.maxScroll).padStart(4)}  ${ok?"PASS":"FAIL"}`);
  return {p, rest};
};

let p = await open(); await fill(p);
await row("1 type past cap -> bottom", p, "bottom");
let r = await p.locator(".composer").evaluate(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}});
for(let i=0;i<6;i++){try{await p.screenshot({path:SHOT("fix-typed-rest.png"),clip:r});break;}catch{await p.waitForTimeout(300);}}
await p.close();

p = await open(); await fill(p);
await p.evaluate(()=>{ const ta=document.getElementById("dtext"); ta.selectionStart=ta.selectionEnd=30; });
await p.keyboard.type("XX");
await row("2 edit mid-field -> stays put", p, "notBottom");
r = await p.locator(".composer").evaluate(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}});
for(let i=0;i<6;i++){try{await p.screenshot({path:SHOT("fix-midfield.png"),clip:r});break;}catch{await p.waitForTimeout(300);}}
await p.close();

p = await open(); await fill(p);
await p.evaluate(()=>{ const ta=document.getElementById("dtext"); ta.selectionStart=ta.selectionEnd=0; ta.scrollTop=0; });
await p.keyboard.type("Z");
await row("3 caret to line 1 -> top", p, "top");
await p.close();

p = await open(); await fill(p);
await p.evaluate(()=>{ const ta=document.getElementById("dtext"); ta.value=ta.value.slice(0,120);
  ta.selectionStart=ta.selectionEnd=ta.value.length; ta.dispatchEvent(new Event("input")); });
await row("4 delete below cap -> shrinks", p, "bottom");
await p.close();

p = await open();
await p.evaluate(()=>{ const ta=document.getElementById("dtext"); ta.value="word ".repeat(200);
  ta.selectionStart=ta.selectionEnd=ta.value.length; ta.dispatchEvent(new Event("input")); });
await row("5 huge paste -> bottom", p, "bottom");
await p.close();

p = await open(390,500); await fill(p);
await p.setViewportSize({width:360,height:760});
await p.waitForTimeout(400);
await row("6 viewport re-wrap -> bottom", p, "bottom");
await p.close();
await b.close();
