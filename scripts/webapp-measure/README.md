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
    python3 halo.py <out>         # finishes batch5's item 5 — the title's ink-vs-surround contrast
                                  #   at the WORST slice of each line, over a bright bubble, in both
                                  #   themes, against the flat-ground control it validates itself on

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
