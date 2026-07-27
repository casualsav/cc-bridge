import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// Attachment staging, driven through the REAL picker: a picked file waits in the composer with an ✕,
// the caption rides with it, and nothing reaches the server until send.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
// A real PNG, written here so the harness needs no fixture on disk: an 8x8 blue square.
const PHOTO = join(mkdtempSync(join(tmpdir(), "stage-")), "photo.png");
writeFileSync(PHOTO, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAG0lEQVR4nGNgYGD4z0AswKqQWMUM" +
  "o1YMKysAAP//NxUFvzs1LcYAAAAASUVORK5CYII=", "base64"));
const ts=1785200000000;
const S={sid:"abc",name:"cc",alive:true,working:false,cwd:"~/p",model:"Opus 5",effort:"high"};
const F={...S,items:[{role:"user",text:"hi",ts}]};
let bad=0; const check=(ok,l)=>{ console.log(`${ok?"OK  ":"FAIL"}  ${l}`); if(!ok)bad++; };
// Clicking a control that does not exist must FAIL this harness, not hang it for 30s and die with a
// stack trace — the pre-change page has no ✕ at all, and a control run has to be readable.
const click = async sel => { try { await p.click(sel, { timeout: 1500 }); return true; }
  catch { check(false, `could not click ${sel} — it is not there`); return false; } };

const b=await chromium.launch();
const p=await b.newPage({viewport:{width:375,height:812}});
p.on("pageerror",e=>{ console.log("PAGEERROR:",e.message); bad++; });
await p.goto("file://"+PAGE,{waitUntil:"domcontentloaded"});
// Record every upload the page attempts, so "nothing was sent yet" is a measured claim.
await p.evaluate(({feed,session})=>{
  window.__uploads=[];
  window.api=async path=>path.includes("session/feed")?feed:path.includes("sessions")?{sessions:[session]}:{};
  const realFetch=window.fetch;
  window.fetch=async (u,o)=>{
    const url=String(u&&u.url||u);
    if (url.includes("/api/session/attach")) {
      const fd=o.body; window.__uploads.push({ name:(fd.get("file")||{}).name, caption:fd.get("caption")||"" });
      return new Response(JSON.stringify({ok:true,match:"m1"}),{headers:{"content-type":"application/json"}});
    }
    if (url.includes("/api/session/act")) { window.__uploads.push({act:JSON.parse(o.body||"{}")}); return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}}); }
    return realFetch(u,o);
  };
  openDrill(session.sid,session.name);
},{feed:F,session:S});
await p.waitForTimeout(800);

const vis = s => p.evaluate(x=>{ const e=document.querySelector(x); if(!e) return false; const r=e.getBoundingClientRect(); return r.width>0&&r.height>0; }, s);
check(!(await vis("#dstage .thumb")), "nothing staged at rest");
check(!(await vis("#dsend")), "send hidden with an empty field");

await p.setInputFiles("#dfile", PHOTO).catch(()=>check(false,"no #dfile input on this page"));
await p.waitForTimeout(400);
check(await vis("#dstage .thumb img"), "the picked photo previews as a thumbnail");
check(await vis("#dstage .x"), "it carries an ✕");
check(await vis("#dsend"), "send appears for a staged file with NO text");
check((await p.evaluate(()=>window.__uploads.length))===0, "nothing has been sent yet — staging only");

// ✕ discards, and takes the send button with it.
await click("#dstage .x"); await p.waitForTimeout(300);
check(!(await vis("#dstage .thumb")), "✕ discards the attachment");
check(!(await vis("#dsend")), "send goes away again with nothing to send");
check((await p.evaluate(()=>window.__uploads.length))===0, "discarding sent nothing");

// Re-stage, type a caption, send.
await p.setInputFiles("#dfile", PHOTO).catch(()=>check(false,"no #dfile input on this page"));
await p.fill("#dtext", "what do you make of this?");
await p.waitForTimeout(300);
check(await vis("#dstage .thumb"), "the attachment survives typing — the whole point");
await click("#dsend"); await p.waitForTimeout(600);
const up = await p.evaluate(()=>window.__uploads);
check(up.length===1 && up[0].name==="photo.png", `exactly one upload, of the picked file (${JSON.stringify(up)})`);
check(up[0] && up[0].caption==="what do you make of this?", "the typed message rode along as the caption");
check(!(await vis("#dstage .thumb")), "the strip clears after sending");
check((await p.evaluate(()=>document.getElementById("dtext").value))==="", "the field clears after sending");
// A session switch must not carry a staged file into another session.
await p.setInputFiles("#dfile", PHOTO).catch(()=>check(false,"no #dfile input on this page")); await p.waitForTimeout(200);
await p.evaluate(()=>openDrill("other","Other")); await p.waitForTimeout(400);
check(!(await vis("#dstage .thumb")), "switching sessions discards the stage — it would upload to the wrong one");
await b.close();
console.log(bad?`\n${bad} FAILED`:"\nall checks passed");
process.exit(bad?1:0);
