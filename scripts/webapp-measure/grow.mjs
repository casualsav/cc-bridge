import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:390,height:760}, deviceScaleFactor:2 });
p.on("pageerror",()=>{});
await p.goto("file:///home/ubuntu/projects/cc-bridge/webapp/index.html",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(300);
await p.evaluate(()=>{ try{openDrill("fake","fake");}catch{ document.getElementById("drill").classList.add("show"); } });
await p.evaluate(()=>{ const f=document.getElementById("dfeed");
  f.innerHTML=Array.from({length:30},(_,i)=>`<div class="msg ${i%2?"user":"assistant"}">message number ${i+1}</div>`).join("");
  f.scrollTop=f.scrollHeight; });

const snap = () => p.evaluate(()=>{
  const ta=document.getElementById("dtext"), cs=getComputedStyle(ta);
  const wrap=document.querySelector(".inputwrap").getBoundingClientRect();
  const mic=document.getElementById("dsend").style.display!=="none"
    ? document.getElementById("dsend").getBoundingClientRect()
    : document.getElementById("dmic").getBoundingClientRect();
  const comp=document.querySelector(".composer").getBoundingClientRect();
  const feed=document.getElementById("dfeed"); const fr=feed.getBoundingClientRect();
  const last=feed.lastElementChild ? feed.lastElementChild.getBoundingClientRect() : null;
  const lh=parseFloat(cs.lineHeight), padY=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);
  return { pill:+wrap.height.toFixed(2), radius:getComputedStyle(document.querySelector(".inputwrap")).borderBottomRightRadius,
    ta:+ta.getBoundingClientRect().height.toFixed(2), scrollH:ta.scrollHeight, clientH:ta.clientHeight,
    visibleLines:+((ta.clientHeight-padY)/lh).toFixed(3), contentLines:+((ta.scrollHeight-padY)/lh).toFixed(3),
    scrollable: ta.scrollHeight>ta.clientHeight+1,
    ringBottom:+(wrap.bottom-mic.bottom).toFixed(2), ringRight:+(wrap.right-mic.right).toFixed(2),
    micCentreFromRight:+(wrap.right-(mic.right+mic.left)/2).toFixed(2),
    taWidth:+ta.getBoundingClientRect().width.toFixed(2),
    taLeft:+(ta.getBoundingClientRect().left-wrap.left).toFixed(2),
    taRightGap:+(wrap.right-ta.getBoundingClientRect().right).toFixed(2),
    composerH:+comp.height.toFixed(2), feedH:+fr.height.toFixed(2),
    sum:+(comp.height+fr.height).toFixed(2),
    lastMsgVisible: last ? last.bottom<=fr.bottom+0.5 : null,
    stuck: Math.abs(feed.scrollHeight-feed.scrollTop-feed.clientHeight)<1 };
});
const set = t => p.evaluate(v=>{ const ta=document.getElementById("dtext"); ta.value=v; ta.dispatchEvent(new Event("input"));
  const f=document.getElementById("dfeed"); f.scrollTop=f.scrollHeight; }, t);

const L = n => Array.from({length:n},(_,i)=>"line "+(i+1)).join("\n");
const out={};
out["empty"]=await snap();
for (const n of [2,3,6,7,12]) { await set(L(n)); out[n+" lines"]=await snap(); }
await set("x ".repeat(4000)); out["huge paste"]=await snap();
await set(""); out["cleared"]=await snap();
console.log(JSON.stringify(out,null,1));
await b.close();
