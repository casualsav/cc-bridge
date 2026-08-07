import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// A class PRIVATE to one component may not claim a common word globally.
//
//   node scopecheck.mjs [page]
//
// This page has ~40 unscoped single-class rules. Most are fine: `.acctdivider`, `.crumbs`, `.vhead`
// are component names nothing else would reach for. A few are DELIBERATELY shared vocabulary —
// `.msg`, `.dot`, `.chip`, `.cardx` — and must stay global; that is the design, and webapp/CLAUDE.md
// says so.
//
// The traps are the rules in between: private to one component, but named with a word the next
// component will also reach for. Three of them bit the bridge command cards:
//   .card .k / .card .v  → metric values two type steps above their labels
//   .meta                → patch file-headers at 12px/nowrap inside a 13px/pre block
//   .cm                  → masked by specificity, so a latent red line rather than a visible bug
// Every one is legal CSS that sets a property the new component never declared, which is exactly why
// no computed-style assertion could see it and why all three were caught by reading rendered output.
//
// So this is a NAME check, not a render check — the cheap half, run in milliseconds, that stops the
// three from being re-globalised. The expensive half (does any foreign rule actually reach my
// nodes?) is cards.mjs §8, and it is per-component by nature.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const css = readFileSync(PAGE, "utf8");

// Words a component reaches for without thinking. Unscoped, each is a landmine for the NEXT
// component, whoever writes it. Not a style rule — every entry here is either a class that already
// caused a defect or a direct sibling of one in the same rule block.
const RESERVED = ["ico", "name", "meta", "cp", "cm", "k", "v", "title", "label", "value", "body", "head", "row", "item", "text", "note"];

// Deliberately shared, and the whole point of them is that they are global. Listed so the check
// states the exception rather than being silently unable to see it.
const SHARED = ["msg", "dot", "chip", "cardx", "sechead", "notice"];

// Strip comments first — the prose in this file quotes selectors constantly, and matching those
// would report a dozen findings that are sentences.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

// Every selector that is a SINGLE class with no ancestor and no other qualifier: `.foo {` or
// `.foo, .bar {`. Anything with a descendant combinator, a second class or an id is already scoped.
const found = new Map();
for (const m of bare.matchAll(/(^|\n)\s*([^{}\n]+)\{/g)) {
  for (const sel of m[2].split(",")) {
    const s = sel.trim();
    const one = /^\.([a-z][a-z0-9-]*)$/.exec(s);
    if (one) found.set(one[1], (found.get(one[1]) || 0) + 1);
  }
}

const offenders = [...found.keys()].filter(c => RESERVED.includes(c) && !SHARED.includes(c));
check(offenders.length === 0,
  offenders.length
    ? `these reserved words are declared as UNSCOPED single-class rules: ${offenders.map(c => "." + c).join(", ")} — scope each to the component that owns it`
    : `no reserved word is claimed globally (checked ${RESERVED.length} against ${found.size} unscoped single-class rules)`);

// The other direction, and the reason SHARED is a list rather than a comment: if a deliberately
// shared class STOPS being global, every surface that borrows it silently loses the treatment. That
// is the same defect with the sign flipped, and it would pass the check above.
const missing = SHARED.filter(c => !found.has(c));
check(missing.length === 0,
  missing.length
    ? `deliberately SHARED vocabulary is no longer global: ${missing.map(c => "." + c).join(", ")} — surfaces that borrow it have silently lost the treatment`
    : `the shared vocabulary is still global (${SHARED.length} classes)`);

console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
