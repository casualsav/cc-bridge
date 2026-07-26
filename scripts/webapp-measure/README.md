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
