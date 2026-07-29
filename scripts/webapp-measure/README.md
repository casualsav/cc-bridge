# Mini-app measurement harness

Renders `webapp/index.html` in headless Chromium and **measures pixels**, because the CSS being
right and the pixels being right are different claims. This caught four real defects in one week
that reading the stylesheet did not: a glyph painting half a pixel off, a fold fading to the wrong
colour, a feed that stopped following its own bottom, and a composer that never grew.

Playwright is not a dependency of this repo — the scripts import it by absolute path from
`~/projects/taste/node_modules/playwright/index.mjs`. Fix that path (or `npm i playwright`
somewhere and point at it) before running. Everything renders `file://` — no server needed.

    node shoot2.mjs <outdir>      # mic/send glyph states (idle, recording, disabled, send), both themes
    python3 measure.py <pngs>     # ink bbox vs the button's own disc centre — for ROUND buttons
    python3 rectmeasure.py <pngs> # same, clipped exactly to a RECTANGULAR button (.ghost/paperclip)
    node grow.mjs                 # composer geometry at 1/2/3/6/7/12 lines, paste, and cleared
    node keyboard.mjs [page][out] # the soft keyboard, as a MATRIX: {resting at the floor, mid-thread}
                                  #   × {rise, fall} × {only the visual viewport shrank, the client
                                  #   shrank its layout viewport too}. A transcript at the floor rides
                                  #   with the composer both ways; a mid-thread reader is never moved.
                                  #   The keyboard is SIMULATED (a fake visualViewport before the
                                  #   page's script, + a real resize for the layout half) at HIS
                                  #   measured 354px. Device leg closed 2026-07-29. Also measures the
                                  #   JOURNEY — mid-flight samples prove the rise and fall are eased
                                  #   and that nothing is eased where nothing moved; against the
                                  #   pre-easing page ONLY those 8 fail, which is what says the
                                  #   resting geometry did not move. Plus the MIRROR: a keyboard seen
                                  #   once is animated from the next FOCUS tap, ~500ms before the
                                  #   client says anything, and the real resize then costs nothing —
                                  #   with the rollback for a prediction nothing confirms. Last check
                                  #   proves the temporary debug beacon is gone, not merely disabled
    node cardfoot.mjs [page][out] # a session card's foot carries the SESSION's numbers — the 5h
                                  #   window is account-level and gone from every card, and no card
                                  #   carries the 8px gap its empty foot would leave. Three fixture
                                  #   cards, one per shape the removal touches. Pass a pre-change
                                  #   page: 6 of 12 fail there
    node composerbox.mjs [page][out] # the TWO-ROW composer: field on the top line, controls on their
                                  #   own line under it, ~3 text lines tall at rest — the rest height
                                  #   measured against its PARTS, the shape, the growth above the
                                  #   control row, and everything outside it holding still. Pass a
                                  #   pre-change page: the rest + shape checks must FAIL there (5 of
                                  #   54), and growth + nothing-else must pass on BOTH
    node suite.mjs                # the six scroll behaviours, each measured twice (see below)
    node themes.mjs               # feed in dark AND light (see the theming trap below)
    node work.mjs <outdir>        # the live working row: both themes, reduced-motion, and the
                                  #   status-absent control (the row must NOT render without it)
    node fullscreen.mjs           # the fullscreen top offset on every top-anchored surface, driven
                                  #   through the REAL SDK's receiveEvent (needs network)
    node agentcard.mjs            # the subagent report card: a fixture transcript through the real
                                  #   parser, plus an unparsed control row and a contrast control
    node slashwork.mjs [page]     # which composer commands may open the optimistic working row.
                                  #   Pass a pre-fix copy of the page: every silence check must FAIL
    node workline.mjs [page]      # the working row's type and its clock — one line one font, never
                                  #   backward, ticker torn down with the row (same page-path control)
    node workpin.mjs [page]       # the working row STATIC above the composer: same viewport position
                                  #   at the top/middle/bottom of a long transcript and at every
                                  #   transcript length, the feed's box ending above it (so nothing
                                  #   can be occluded), plus the guards that the feed isn't
                                  #   bottom-aligned and no bubble shrink-wrapped. Its checks were
                                  #   redesigned when the row left the feed — the header lists which
                                  #   were dropped, kept, re-aimed and added (same page-path control)
    node minislash.mjs [outdir]   # slash commands typed into a mini app chat, END TO END: the shipped
                                  #   page on the LIVE server, real composer, real send button, real
                                  #   throwaway session. Nothing stubbed. Includes the settings.json
                                  #   byte-identity control for /model
    node miniclear.mjs [outdir]   # the 🧹 /clear approval setting honoured by the MINI APP: same
                                  #   end-to-end stance as minislash, plus a stubbed showConfirm that
                                  #   records the question and answers it, so cancel and confirm are
                                  #   both driven. The cancel is proven AT THE PANE — the feed lags a
                                  #   clear by seconds and reports a transcript that is already gone.
                                  #   Flips prefs.json's confirmReset and restores the box's own value.
                                  #   Control is TEMPORAL (daemon-side change): 5 checks fail pre-fix
    node ghostecho.mjs [page]     # an optimistic bubble must recognise its own CLIPPED echo. Over
                                  #   CONVO_CAP the echo comes back shorter than what you typed, so
                                  #   exact-text reconciliation can never match and the feed showed
                                  #   the message TWICE for 120s. Three guards against retiring the
                                  #   wrong bubble, each measured. Control: 2 checks fail pre-change,
                                  #   the guards pass on BOTH pages (a guard that only starts holding
                                  #   after the change would mean the change caused what it guards)
    node finaldot.mjs [page][out] # a FINAL message opens its first line with a 5px dot, and nothing
                                  #   else in the feed does. Presence + the four exclusions (narration
                                  #   above all), painted in BOTH themes, costs the reply no height,
                                  #   the narration byte-identity count re-measured here so it can't
                                  #   drift from thoughts.mjs, and the accepted stranding ASSERTED
                                  #   rather than forbidden. Control: 7 fail pre-change, exclusions
                                  #   pass on both pages
    node refetch.mjs <page> <lbl> # PROBE: for a CLIPPED last row of each role, what route is there
                                  #   to its full text? Established that the assistant-only auto
                                  #   refetch is CORRECT (it replaces the fold bar the newest-reply
                                  #   exemption removes; user/agent keep their tap) and that the one
                                  #   role with no route at all is `command` — latent, never fired:
                                  #   0 of 81 command bodies on this box exceed the cap
    node pinopt.mjs <page> <lbl>  # PROBE, not a check suite: the top-pin's DOM read vs the fold's
                                  #   model read, six states side by side. Refuted the "optimistic
                                  #   bubble breaks the pin" finding and found the one state where
                                  #   the two really diverge — a ghost bubble from the 4000-char
                                  #   payload clamp. Absolute page path; prints numbers, exits 0
    node squash.mjs [page] [out]  # a collapsed long message keeps its 268px height — BOTH kinds (the
                                  #   user-side bubble and the unbubbled prose reply) — in a feed whose
                                  #   content wants 3× the scroller. The flex column makes every
                                  #   overflow:hidden child shrinkable; this is the check that says so.
                                  #   Pass a pre-fix page: every height check must FAIL there
    node deadcard.mjs [outdir]    # a killed session leaves the fleet list and a revived one comes
                                  #   back, timed on BOTH surfaces (live /api/sessions + the rendered
                                  #   tab) against a real throwaway it spawns, kills and reopens.
                                  #   Carries a session that stays live throughout as the control, and
                                  #   asserts on the measured seconds — a pre-fix daemon fails it at
                                  #   ~33s rather than passing slowly, and shoots the 💀 card it serves
    node header.mjs [page]        # the chat header: three containers ONE height, a name one scale
                                  #   step above the cwd, a capsule 20% narrower than its span, and
                                  #   chips the transcript passes BEHIND — hit-tested, not rect maths
                                  #   (a clipped message still REPORTS an overlapping rect, so the
                                  #   obvious check passes on the in-flow layout). Same page-path
                                  #   control: nine checks must fail on a pre-change copy
    node bleed.mjs [page]         # FULL BLEED: the feed is the whole screen, both floating surfaces
                                  #   reserve their space as its padding (the bottom one MEASURED via
                                  #   --dock-h), nothing is occluded at rest, and the transcript
                                  #   scrolls THROUGH the top strip and behind the frosted capsule —
                                  #   hit-tested over a band, since a single-point probe lands in the
                                  #   margin between two messages. Control: 13 checks fail pre-change
    node headerup.mjs [page]      # FULLSCREEN ONLY: the header rides up into Telegram's own chrome
                                  #   row, the pause folds inside the capsule, and the transcript
                                  #   reclaims the row they vacate (~48px). Driven through the REAL
                                  #   SDK's receiveEvent, and it measures normal mode FIRST so every
                                  #   fullscreen claim is a delta from an untouched baseline. What it
                                  #   cannot check: whether the client swaps its ✕ Close for a ← when
                                  #   BackButton.show() is called, and where its buttons sit
                                  #   horizontally — the API exposes no x-extents. Live device only
    node chipalpha.mjs [page]     # how transparent the header chips are, and how present they stay at
                                  #   rest — the two halves of that trade, both measured. Solves the
                                  #   alpha exactly from a chip over two SYNTHESISED backdrops, and
                                  #   validates itself against a declared value first. Sample windows
                                  #   must clear the blur radius (the frost samples a neighbourhood,
                                  #   so near the seam the backdrop is not the one you think) and the
                                  #   chip's rounded ends (antialiasing drags the mean toward the
                                  #   ground) — each of those cost a wrong reading here
    node scrim.mjs [page]         # the working row's scrim: INVISIBLE with nothing behind it, doing
                                  #   its job with a message behind it. Two-sided by construction —
                                  #   each state shot with and without `.work::before` — so neither an
                                  #   always-invisible nor an always-painted bar can pass. Compared on
                                  #   the background right of the row's ink: a translucent layer flips
                                  #   the row's own glyphs from subpixel to grayscale AA, which is
                                  #   real and is not a visible band
    node stage.mjs [page]         # composer attachments: a picked file WAITS with an ✕ instead of
                                  #   uploading, the typed text rides as its caption, ✕ and a session
                                  #   switch both discard it. Every upload is recorded, so "nothing
                                  #   was sent yet" is measured rather than assumed. Same page-path
                                  #   control: the pre-change page fires two captionless uploads
    node slashcmd.mjs [page]      # a local command: invocation folded with its output, in prose, with
                                  #   no escape codes left in it. Carries three controls — an unparsed
                                  #   row that MUST leak, a model id whose literal [1m] must survive,
                                  #   and the `!` bash chip, which must NOT have moved
    node batch5.mjs [page] [out]  # the five-item batch of 2026-07-27, in one pass because four of
                                  #   the five touch the same screen: the paperclip's Camera/Photos/
                                  #   Files sheet, the composer's no-inline-predictions attributes,
                                  #   "1 attachment", no optimistic bubble for any slash command
                                  #   (plus the empty state after /clear), and the header losing its
                                  #   capsule. Same page-path control: 24 checks fail pre-change
    node headercolor.mjs [page]   # the page takes the client's HEADER colour (a trial), and it has to
                                  #   reach EVERYTHING — the ceiling scrim, the composer strip, the
                                  #   working pill, the fold's veil and the chips' 44% tint are each
                                  #   asserted to be mixed from it, through a deliberately absurd
                                  #   probe colour so a literal left behind is obvious. Controls: the
                                  #   fallback (no header_bg_color → the page is byte-identical), and
                                  #   a REPORT of how far raised surfaces (--sec) end up from the new
                                  #   page colour, which is what decides whether the trial survives
    node dockscrim.mjs [page]     # the dock is a SCRIM: invisible over the page, taking ~40% of a
                                  #   passing message's excursion, with the working line's own band
                                  #   left exactly where it was (45% + 60% composites to the old
                                  #   78%). Plus the row's 4px box gap over the capsule. Same
                                  #   page-path control: the shading and the gap fail pre-change
                                  #   while the invisibility and the line's contrast pass on both —
                                  #   which is the claim, since this had to ADD shading to the strip
                                  #   without moving the line's ground
    node newest.mjs [page] [out]  # the NEWEST reply is not folded, and folds again once something
                                  #   lands under it. Plus the two things that follow from taking the
                                  #   fold bar away: the payload-clipped rest is fetched untapped
                                  #   (recorded, so "once" is measured), and a screen-taller reply
                                  #   lands on its FIRST line rather than its last — in fullscreen
                                  #   too, where the scrim and the feed's padding swap over. Same
                                  #   page-path control: 7 checks fail pre-change
    node sessions.mjs [page] [out] # the Sessions page: the reference's card geometry (radius, padding,
                                  #   the icon tile, the type step) and the new-session PILL that
                                  #   floats over the list. The geometry half fails wholesale on a
                                  #   pre-change page; the layering half cannot — that page has no
                                  #   pill, so "it paints above the list" would pass vacuously — and
                                  #   carries its own falsifying controls instead: the same hit test
                                  #   re-run at z-index -1, and the relief re-measured with the list's
                                  #   reserved padding stripped. Also holds the pill's node identity
                                  #   across a 4s poll (the list is rebuilt; the pill must not be),
                                  #   and diffs every card's text against HEAD's page on one fixture —
                                  #   a guard that passes on BOTH, which is what "shape only" means
    node waitstate.mjs [page] [out] # the roster's FOURTH state: working · waiting · unreported · idle,
                                  #   where idle finally means "nothing pending". Runs HEAD's page as
                                  #   its own control in the same process, and splits its checks in
                                  #   two: STATE checks (the amber dot sampled from the render, its
                                  #   stillness, the ⏸️/📤 labels replacing the snippet, the one-line
                                  #   height) must FAIL there — the harness fails if any passes — and
                                  #   GUARDS (the idle and working cards, the other colour distances)
                                  #   must hold on both. Dots are scrolled into view before sampling:
                                  #   a clip outside the image throws, and a control that throws
                                  #   reports nothing
    node thoughts.mjs [page] [out] # a turn's NARRATION is quoted and its answer is not. Three kinds of
                                  #   claim, three instruments: the marking is structural and fails
                                  #   wholesale on a pre-change page; the ABSENCE of a demotion (same
                                  #   size/weight/style/colour/opacity as the reply, per the standing
                                  #   prose ruling) passes on BOTH by design and is a guard, not a
                                  #   control; and the bar is measured in PIXELS off a screenshot in
                                  #   both themes, because the rule this revives declared `var(--sec)`
                                  #   — 9/255 from the pinned page colour, i.e. a bar that passes any
                                  #   declared-colour check and cannot be seen. Fixtures: a payload
                                  #   captured from the LIVE daemon, plus a synthetic one for the
                                  #   merge/split rule a single capture cannot hold
    node spawnsheet.mjs [page] [out] # the new-session sheet, which HOSTS the composer's dial: its
                                  #   headline check is CONGRUENCY — both hosts opened in one page and
                                  #   a row from each compared, DOM shape and computed values, so the
                                  #   shared-component claim is falsifiable rather than promised.
                                  #   Plus the focus ring measured in PIXELS (a
                                  #   computed-style check passes on the broken page — `outline-style`
                                  #   was the UA's `auto`, which each platform paints in its own
                                  #   colour), lowercase entry, the "default"/"ask" relabel with its
                                  #   badge, the pill actions, and the sheet joining the slide-up
                                  #   family. Carries an options-unchanged guard — every row's data-v
                                  #   compared byte for byte with HEAD's page — which passes on BOTH
                                  #   and is what says a relabel dropped nothing. Control: 21 checks
                                  #   fail on the pre-change page
    python3 halo.py <out>         # finishes batch5's item 5 — the title's ink-vs-surround contrast
                                  #   at the WORST slice of each line, over a bright bubble, in both
                                  #   themes, against the flat-ground control it validates itself on
    node tailrole.mjs [script…]   # META: does a script's answer depend on the ROLE its fixture ends
                                  #   on? Re-runs it against a page whose every feed gains a trailing
                                  #   short `user` row. Answered NO for nine of ten (see below).
                                  #   newest.mjs is the positive control and must keep moving

## The fixture's ending role: asked, measured, refuted

Most fixtures here build a transcript as `Array.from({length: N}, (_, i) => ({ role: i % 2 ?
"assistant" : "user", … }))`, and **with an even N that always ends on an `assistant` row**.
`workpin.mjs` was once blind exactly there — both its fixtures ended assistant-last, which hid the
newest message painting *under* the working pill until a user-last `PENDING` fixture was added. So:
does any other script carry the same blind spot?

**No.** `tailrole.mjs` re-ran every one against a page whose feeds all end on a freshly-sent `user`
row: **184 checks across eight scripts, none moved.** The two number-only probes (`suite`, `pinopt`)
were diffed by hand — `suite` identical; `pinopt`'s numbers move exactly as the fold exemption and
top pin predict, which is its subject.

**Why it is inert, which is what makes the refutation durable.** The ending role reaches a
measurement through exactly three vectors, and two of them are gated on a *long* last row:

| vector | where | fires when |
|---|---|---|
| the last row's bottom margin (`assistant` 16px vs `user` 8px) | — | **never any more**: `#dfeed > .msg:last-child` pins it at 20px regardless of role |
| the newest-reply fold exemption | `renderMsg`, `newest = last && role === "assistant"` | last row past `LONG_MSG` (700 chars) |
| the top pin for a screen-taller newest reply | `paintFeed`, `el.classList.contains("assistant") && …` | last row taller than the viewport |

The margin vector — **the one that caused the workpin bug** — was structurally closed by the floor
gutter pin, which is what retired the class rather than any fixture discipline. And every alternating
fixture's rows run 81–250 chars, an order of magnitude under the 700-char fold threshold, so neither
remaining vector can fire. **The only fixtures with long last rows are `newest`, `pinopt` and
`squash` — precisely the three already built around the ending role**, `squash` with an explicit
short `user` row last and a comment saying why. The idiom is inert because the vectors need length,
and the fixtures that have length already drive the ending deliberately.

Two scripts cannot be measured this way and are classified by construction instead — the tool reports
them as `UNREACHED`, never as a pass, because an unreached script prints "identical" for the wrong
reason: **`grow.mjs`** builds its rows with `innerHTML`, so no role logic runs at all (and it measures
the composer, not the feed), and **`sessions.mjs`** never opens a drill — its `i % 2` keys a session
card's model/effort/branch, which is a different idiom that happens to share the operator. Counting
it among the "twelve scripts carrying the feed idiom" over-counts: there are ten.

Pre-existing and untouched, found while running this: `batch5.mjs`'s "the name is unchanged: 14px /
600" fails on **both** pages — stale since the header name moved to `--t-sub`, unrelated to any of
the above.

## Known follow-up: block markdown is card-only

`mdReport()` renders headings and bullets for the **agent card body** and nothing else. Assistant
replies still show `## x` and `- y` literally, through the narrower `md()`. That split is deliberate
— an agent report is a structured document, a chat reply is prose — and `agentcard.mjs` carries a
control asserting the assistant row stays literal, so a future widening of `md()` itself shows up as
a failing check rather than as a silent restyle of every message in the app. Widening it is the
owner's call, not a cleanup.

## Two rules, both learned the hard way

**1. Validate the instrument against a known-truth control before believing it.** Three separate
versions of `measure.py` were wrong — one counted the button's antialiased rim as glyph ink, one
counted its box-shadow as part of the disc, one misread a rectangular button entirely (it reported
29.9px of ink from a 24px glyph). Each looked plausible and each agreed with the conclusion. The
fix was to render a *provably centred* control and a control with a *known* offset and require the
harness to return exactly `0.00` and exactly `+0.50` before trusting any real number. Do the same
for anything new.

**1b. A threshold is part of the instrument. Derive it from the image, never from habit.** Measuring
ink off a reference screenshot means picking a luminance threshold, and "white-ish text is above 140"
is a habit, not a measurement. On the owner's message-bubble reference the bubble's own fill is
luminance **135**, so a threshold of 140 put almost the entire bubble above the line and the "glyph"
bbox was measuring bubble. It produced a meta-to-message size ratio of 0.56 — plausible, wrong, and
it shaped an owner instruction before anyone caught it. Two separate numbers came out of that one
threshold (the type ratio and a 1px glyph offset), which is the tell: a bad threshold corrupts
everything downstream of it, not one value.

The rule: print the luminance **profile** across the edge you are measuring and confirm two clean
plateaus with your threshold between them, then re-measure at two more thresholds inside that gap and
require the answer to be stable. The header and composer references survived exactly this check
(plateaus 27/48 and 45/143, answers stable to <1% across thresholds); the bubble reference did not,
and the difference is that its background is BRIGHT. Any reference with a light fill is where this
bites.

**1c. Never infer WHAT you are measuring from the picture; read it from the page.** `halo.py`'s first
version found the title's ink as "the biggest luminance excursion in the crop", which is reasonable
until the thing you are measuring is a halo — a halo IS an extreme excursion, painted in the ground's
own colour around the glyph. So on exactly the frames where the halo was working, the probe measured
halo-against-bubble and reported the fix as a **regression**: the cwd came back worse with the halo on
than off, twice, across five candidates. The cure was to take the glyph's colour from
`getComputedStyle`, which is not a guess and is right on every frame. Two smaller versions of the same
mistake sat behind it — the element's box was measured instead of the text's (`#dsub` is a block
spanning the whole title, so most of its box was empty background, which reported a 1.4:1 "worst case"
from nothing at all), and `color-mix()` results come back as `color(srgb 0.57 …)` with 0-1 channels,
which read as 0-255 round to `(1,1,1)` and match no pixel in the image.

**1d. A rendering artefact can masquerade as the effect you wanted.** The same item shipped past
review inside this session as eight stacked `text-shadow`s in `var(--bg)` — the page's own colour, so
by construction invisible over the page. It is not: each composite loses a little to 8-bit rounding,
and a wide blur spreads that loss over a wide area, so the ground under the title came back **six
units darker** and rendered as a dark plate the size of the text. On a change whose entire point was
removing a capsule, it drew one back. What made it slip through is that in a dark theme the artefact
*raises* the measured contrast, so the numbers improved while the design got worse. Isolate any
treatment in a minimal page over flat ground before believing the number it produced over a busy one.

**2. Idle before measuring.** `suite.mjs` reads every state twice — immediately, and again after
~7s (two of the app's 3s repaint cycles). A bug that only appears once input stops is invisible to
a check that drives and reads in the same tick, and one shipped exactly that way. Any state that
settles — timers, transitions, re-layout — needs the idle read, permanently.

A corollary worth internalising: a test that *cannot* fail looks identical to a test that passed.
Before believing a green result, ask what it would have printed had the thing been broken. Two
harnesses here silently could not fail — one used hard newlines to test soft wrapping (line count
fixed by the newlines, so width changes could not move it), one re-pinned the very scroll position
it was checking. Both "passed" while the bug was live.

## The theming trap

The mini app **ignores `prefers-color-scheme` entirely**. It themes off the `--tg-theme-*` custom
properties Telegram injects, with dark fallbacks baked into `:root`. So `colorScheme: 'light'` in
Playwright renders the *dark* theme and a light-theme check that sets the media feature tests
nothing and passes. `themes.mjs` sets the variables a light client would inject; copy that approach.
