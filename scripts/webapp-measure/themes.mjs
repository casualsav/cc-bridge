import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The app themes off Telegram's injected --tg-theme-* vars, not prefers-color-scheme, so a light
// theme has to be simulated by setting them the way a light Telegram client would.
const LIGHT = { "bg-color":"#ffffff","secondary-bg-color":"#f1f1f1","text-color":"#000000",
                "hint-color":"#707579","link-color":"#2481cc","button-color":"#2481cc","button-text-color":"#ffffff" };
const ITEMS = [
  { role:"user", text:"can you wire the recovery emails through the new mailer?", at:Date.now()-60000 },
  { role:"assistant", text:"Confirmed on the Telegram messages — the tripwire path is fully proven. Now let me wire the mailer so recovery emails actually send. First, storing the key securely (gitignored env, never committed) and finding the back-office inbox:", at:Date.now()-50000 },
  { role:"activity", text:"Ran List inboxes to find the back-office address", at:Date.now()-45000 },
  { role:"assistant", text:"Found `back-office@example.test`. Now checking the send endpoint shape:", at:Date.now()-40000 },
  { role:"assistant", text:"Send works. Adding it as a mailer backend:\n\n```\nconst mailer = createMailer({ from: NOTICES_FROM })\nawait mailer.send({ to, subject, body })\n```\n\nThat keeps the transport swappable.", at:Date.now()-30000 },
  { role:"user", text:"perfect, ship it", at:Date.now()-20000 },
];
const b = await chromium.launch();
for (const [name, vars] of [["dark",null],["light",LIGHT]]) {
  const p = await b.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:2 });
  p.on("pageerror",()=>{});
  await p.goto("file:///home/ubuntu/projects/cc-bridge/webapp/index.html",{waitUntil:"domcontentloaded"});
  await p.waitForTimeout(300);
  if (vars) await p.evaluate(v=>{ for (const [k,val] of Object.entries(v))
    document.documentElement.style.setProperty("--tg-theme-"+k, val);
    // The client fires `themeChanged` after a switch and the page re-runs its chrome pin on it; a
    // fixture that only sets the variables leaves a dark-pinned --bg under light type.
    pinChromeColour(); }, vars);
  await p.evaluate(items=>{ window.api = async path => path.includes("feed") ? { working:false, items } : {};
    openDrill("fake-sid","session"); }, ITEMS);
  await p.waitForTimeout(600);
  const r = await p.locator("#dfeed").evaluate(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}});
  for(let i=0;i<6;i++){try{await p.screenshot({path:`feed/theme-${name}.png`,clip:r});break;}catch{await p.waitForTimeout(300);}}
  console.log(name, JSON.stringify(await p.evaluate(()=>{
    const a=document.querySelector(".msg.assistant"), u=document.querySelector(".msg.user");
    const cs=getComputedStyle(a), fr=document.getElementById("dfeed").getBoundingClientRect();
    const ar=a.getBoundingClientRect(), ur=u.getBoundingClientRect();
    return { assistantBg:cs.backgroundColor, assistantFont:cs.fontSize,
             userFont:getComputedStyle(u).fontSize,
             assistantLeftGutter:+(ar.left-fr.left).toFixed(1),
             assistantWidth:+ar.width.toFixed(1), feedWidth:+fr.width.toFixed(1),
             userWidth:+ur.width.toFixed(1),
             activityLeft:+(document.querySelector(".msg.activity").getBoundingClientRect().left-fr.left).toFixed(1) };
  })));
  await p.close();
}
await b.close();
