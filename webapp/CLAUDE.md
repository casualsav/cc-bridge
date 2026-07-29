# The mini app (`webapp/index.html`) — invariants invisible from the code

One file, no build step, no framework. **Entry bar for this file: a paragraph earns its place only
if a future session would break something without it.** State the invariant and the trap it guards;
one line on the incident or owner ruling where one exists. No narration, no correction history, no
value a measure script already asserts — the script is the record.

**Measure with `scripts/webapp-measure/` (read its README first) rather than reasoning about
pixels.** Its two rules — validate the instrument against a known-truth control, and idle before
reading — have each caught real bugs. Before trusting a check, ask what result a broken page would
give it.

## Composer geometry

- **`--t-body` is not the message size.** It sizes list rows, settings values **and the composer
  textarea**, whose line box the capsule's resting height and the six-line cap build on. Messages use their own
  `--t-msg` on `.msg` (also keeps the two sides matched). The two are currently equal (16px; the
  owner tried 18 and asked for 16 back) — not licence to collapse them, since only `--t-body` drags
  the composer's geometry.
- **The capsule is TWO ROWS — field on top at full width, controls under it — and its resting
  height is the SUM OF ITS PARTS, never a picked number:** ring + the field's one-line box + the
  row gap + the mic + ring = 104px. It came off the owner's reference screenshot (the Claude Code
  mobile composer, 189px on a 664px container): scaled to our 370px capsule that is 105. There is
  no `min-height` any more — the content is the resting height, and the old
  `min-height: var(--pill-h-1)` bought 0.4px of a one-line pill. `composerbox.mjs` measures the
  rest height against the parts, the two-row shape, the growth and what must not move.
- **The capsule derives from the mic, never the reverse:** `--pill-h-1 = --mic-d + 2·--pill-ring`
  (40 + 12 = 52) — now the CONTROL ROW's height, still the radius's source. Nothing sets a height
  by hand. The ring is also the capsule's right padding; the model/effort chip's left inset is the
  same concentricity at the other end. It is geometry, not a nudge — a "tidier" round number
  breaks the nesting.
- **`border-radius: calc(var(--pill-h-1) / 2)` — the CONTROL ROW's height, not the live height.**
  Tied to the live height, a grown capsule becomes a lozenge. The radius also equals ring +
  mic-radius, which is what makes the ring read as even *around* the mic — and with the controls on
  the bottom row that now holds at BOTH lower corners: `align-items: center` on a row whose height
  is the mic puts the chip's arc centre 26px off the floor, exactly where the corner's is.
- **The field is `flex: none`, and in a column that is load-bearing:** `flex: 1` carries
  `flex-basis: 0`, so the flex algorithm — not the height `growComposer()` measures and assigns —
  would size the field.
- **The growth cap is LINES, not pixels:** `max-height: calc(var(--ta-lines) * var(--ta-lh) * 1em +
  2 * var(--ta-pad-y))`. A pixel constant that is not a whole multiple of the line box shows the
  last line as a sliver at the scroll boundary.
- **Half-pixel paint snap:** a box centred by flex *free space* with an odd leftover paints its SVG
  0.5px down-right at every DPR, while `getBoundingClientRect()` reports it centred. So `.sendbtn`
  (40px) takes a 20px glyph. Boxes positioned by integer padding are immune (`.ghost` is fine;
  `.chatbtn` was measured, fixed with integer padding, and `header.mjs` asserts the parity). The
  rule is halved free space, not icon-vs-button parity in general.
- **The send plane's optical nudge belongs to `#dsend` alone** (`translate(-1.5px, 1.5px)`). On a
  shared selector it silently displaced the mic and record-stop, whose artwork is already centred.
- **`growComposer()` PRESERVES `scrollTop`; it must not command one.** The browser has already
  scrolled the caret into view; restoring that across the height reset is what makes mid-field
  editing work. One guarded exception: caret at the very end lands at the bottom.
- **A flex child absorbing a height change is not staying pinned.** `#dfeed` is `flex: 1`, so
  static checks pass at any composer height — but `scrollTop` does not move, and the 3s repaint
  only re-pins within 60px of the bottom. `growComposer()` re-pins on that same rule.
- **`syncComposerMode()` runs at parse time while `#drill` is `display:none`.** A hidden element
  measures `scrollHeight === 0`, which once pinned the field at `height: 0`. `growComposer()`
  guards zero measurements; `openDrill()` calls it once visible.
- **`autocorrect="off"` kills inline IME predictions AND autocorrect — the owner's trade.** Do not
  "fix" the prediction-font mismatch instead: the prediction is drawn by the KEYBOARD in the
  device's own UI font, which no `font-family` in the page can reach.

## The soft keyboard

- **WHAT HIS ANDROID TELEGRAM WEBVIEW ACTUALLY DOES — measured, 2026-07-29, and it cost a device
  round-trip.** The keyboard shrinks the **layout** viewport: `innerHeight` 820 → 466 (a 354px
  keyboard), and `visualViewport.height` tracks it exactly (466/466, `offsetTop` 0 throughout), so
  `--kb` computes **0 in every single event** and this page's own compensation never engages there.
  That is why the v0.4.233 pin — hung off `--kb` changing — could not fire on his phone while the
  composer still rose. **All three signals fire**: `window.resize`, `visualViewport.resize` and
  Telegram's `viewportChanged`, typically within 1–3ms of each other, with `viewportChanged` also
  arriving in bursts of a dozen during launch. **The SDK leads the DOM**: one `viewportChanged`
  reported `tg.viewportHeight: 466` while `innerHeight` was still 820 and the scroller still 821 tall
  — so geometry computed from `tg.viewportHeight` would be computed against a stale DOM. Reading the
  DOM (and re-pinning on the resize that follows 7ms later) is right by construction. At rest
  `visualViewport.height` reads **1px larger** than `innerHeight` (821 vs 820), which is what the
  `Math.max(0, …)` clamp is holding back — without it `--kb` would be −1px. Raw log:
  `$(tg shared)/composer-keyboard/device-kbdebug-2026-07-29.log`.
- **The measurement is `visualViewport`, never `innerHeight`, and it is a DIFFERENCE:**
  `innerHeight − visualViewport.height − offsetTop`. A `position: fixed` box is laid out against the
  LAYOUT viewport, which a keyboard does not reliably shrink — so `#drill` carries
  `bottom: var(--kb)` (after the `inset: 0` shorthand, or it is overwritten). Where the client
  already shrank the layout viewport (Android resize mode, Telegram resizing its sheet) the two
  heights agree, `--kb` is 0, and that case is byte-identical — which is why this is a max() of a
  difference and not a branch on the platform. Telegram's `viewportChanged` feeds the same function.
- **Pin on EVERY viewport change, never on `--kb` changing.** That was the device bug (v0.4.233,
  observed on his phone): the lift worked and the transcript never moved, because a client that
  shrinks its own layout viewport holds `--kb` at 0 throughout — correctly — and the one handler that
  would have re-pinned computed 0 → 0. The resize IS the event; whether this page also had to move
  the surface is a different question with a different answer per client. A trailing 350ms re-pin
  follows, because a rise arrives as a burst of resizes on some clients and one mid-animation event
  on others.
- **Riding is CONDITIONAL, and the state is read on SCROLL, not inside the resize handler.** A
  transcript resting within 60px of the floor (`paintFeed`'s own guard) rides with the composer
  through the rise AND the fall; a mid-thread reader is not moved in either direction. Measuring
  "was it at the bottom" inside the handler is the trap — by then the scroller is already shorter, so
  a reader who was sitting exactly on the floor measures 320px away from it.
- **`keyboard.mjs` SIMULATES the keyboard** — a fake `visualViewport` installed before the page's
  script, plus a real viewport resize for the layout-shrink half. It runs the matrix that matters:
  {at the floor, mid-thread} × {rise, fall} × {visual-only shrink, layout shrink}. What no headless
  run can answer is which event Telegram's webview fires for a real keyboard; that leg needs a thumb.

## Feed

- **The fold is a veil to the element's FLOOR, not a band above the label:** runs to `bottom: 0`,
  hits full opacity above the label, and the ramp is EASED — linear reads as an edge. It is written
  once with `--fold-to` as the target colour (`--bg`/`--btn`/`--sec` per variant); overriding
  `background` on a variant silently drops the easing back to linear. `.msg.clip .more` needs its
  `z-index: 1` — `::after` paints after every child.
- **The NEWEST reply is exempt from the fold:** a trailing `role: "assistant"` row renders unfolded
  and folds again when anything lands under it. `assistant` only. "Newest" is the transcript's last
  item, NOT the last DOM row (an optimistic bubble paints after it and would re-fold the reply).
  `paintFeed` fetches a payload-clipped newest's rest itself — once per uuid, never retried
  (`api()` toasts its own failures and a poll would raise one every 3s).
- **A screen-taller newest reply pins by its TOP**, at max(the ceiling scrim's height, the feed's
  padding-top) — the two swap over in fullscreen. Measured from RECTS, never `offsetTop` (relative
  to the offsetParent's *padding* edge; this scroller's padding is the header's footprint, 60px of
  disagreement). `newest.mjs` measures it; `squash.mjs` needs a short row LAST in its fixture or
  its count fails for an unrelated reason.
- **The top-pin reads `feed.lastElementChild` deliberately.** Pin-to-model-read was measured and
  refused — it scrolls a just-sent message 2579px off an 812px viewport (`pinopt.mjs`, a probe;
  `ghostecho.mjs` is the pass/fail guard on the retirement that made the DOM read sound).
- **Slash commands paint no optimistic row.** A command echoes as `role: "command"`, so a user-row
  match can never retire the bubble. "Is a command" is `COMMAND_TOKEN`, written to match
  `slash-policy.ts`'s server-side test exactly — one segment, colon allowed — so `/tmp/foo …` stays
  prose and `/plugin:skill` does not.
- **Over `CONVO_CAP` there is no exact echo** (the server clamps and flags `clipped: true`).
  `echoes()` carries three guards, each blocking a DIFFERENT wrong retirement — do not collapse
  them: `i.clipped` is the licence to compare prefixes at all; the prefix is `i.text.slice(0, -1)`
  because the clamp appends its own `'…'` (compare against `i.text` and nothing ever matches); and
  `o.text.length > pre.length`. **No `4000` is written in the client** — `clipped` already means
  "the server's cap", and a copy would drift. Accepted residual: two messages sharing the whole
  surviving prefix retire each other (a server-issued match token is not available for pane-typed
  text). `ghostecho.mjs` asserts all of it; its guards pass on both pages on purpose.
- **`/clear` renders NOTHING in the feed** — dropped in `transcript.ts` (`RESET_COMMANDS`). Its
  entry can only ever head a fresh file, so the existing "No conversation yet." renders; a lone
  `/clear` on a blank screen reads as debris from the wipe.
- **A composer `/clear` asks first, on the DAEMON's authority** — `confirmReset` is ONE setting for
  every surface, read in `webappSessionAction`, never trusted from the client. The gate sits after
  every existing refusal (a mid-turn `/clear` keeps its plain reason). `{ confirm }` is a **200**
  (the daemon did nothing and is asking) — on the 400 channel it would surface as a red toast
  instead of a dialog. The client raises `askConfirm()` and re-POSTs with `confirmed: true`;
  declining hands the draft back. `sendToSession` captures `drillSid` ONCE because it awaits a
  dialog. `/reset` is in the gate's set though slash-policy refuses it first — deliberate. An
  "Always clear" dialog button was declined (Settings has the toggle). `miniclear.mjs` drives it
  (temporal control; its feed check passes on the broken build — only the pane knows).

## Attachments

- **An ALBUM is ONE message.** Telegram delivers N photos as N updates sharing a `media_group_id`,
  caption on exactly one (not always the first). `bufferPhotoAlbum` debounces 900ms per group (a
  single photo carries no group id and never waits); the flush calls `handleInbound` once.
  Buffering happens BEFORE the access gate on purpose and is safe: the gate runs at flush.
  `meta.image_paths` is set only above one path; `inbound.test.ts` pins the wire format. **Photos
  only** — documents/videos keep one-per-message (`att=` is a single path); a stated exclusion.
- **A picked file is STAGED (`#dstage`), never sent from the picker**; the composer's text goes as
  the caption. The stage sits OUTSIDE `.inputwrap` — a chip inside that flex row disturbs geometry
  derived to the half pixel. `stage.mjs` measures the three misses: `syncComposerMode()` counts a
  staged file as sendable; `openDrill()` clears the stage (`attachToSession` reads `drillSid` at
  *upload* time — a surviving stage delivers to the wrong session); the object URL is revoked on
  discard. A file send paints NO optimistic row (the echo carries the image; a stub would visibly
  vanish on reconcile); a voice note keeps its stub, which swaps into the transcript. The strip
  says "1 attachment", never the filename (the name lives on the discard button's `title`).
- **The paperclip asks WHERE before opening a picker** (`#addctx`: Photos / Files) — two
  differently-declared `<input type=file>`s, because `accept` is the only lever there is. The sheet
  joins the `#dial`/`#calls` rule list (backdrop, 180ms slide, reduced-motion gate) and closes on
  the TAP, not on the picker returning — the picker can be cancelled, and a sheet still standing
  reads as a tap that did nothing.
- **There is no Camera card, and `capture` is why** — measured on the owner's device: Telegram's
  WebView intercepts the chooser, reads `accept`, ignores `capture`, so the card opened the photo
  library exactly like Photos. `batch5.mjs` asserts `#dfcam` absent (its control is v0.4.154, the
  build that had one). If Telegram ever honours `capture` the card comes back; the cards are
  `flex: 1`, so the row re-divides itself.

## Working row

- **Its spacing derives from its NEIGHBOURS**, not its own padding: above is the feed's floor
  gutter, below is `#dworkhost`'s 2px plus the composer's `--sp-1`. A padding-top on `#dworkhost`
  is inert — `--dock-h` measures to the dock's first *ink*, so that box growing moves everything
  equally.
- **The floor gutter is ONE number:** `#dfeed > .msg:last-child` pins 20px. Deriving it from the
  last message's own margin went 2px NEGATIVE for a user bubble — every freshly sent message
  painted under the pill for its whole turn. While the row is up, `#drill.working #dfeed` drops the
  feed's gutter; that compensation belongs on the feed's PADDING, never a negative margin on the
  host — `overflow` clips at the padding box, and a gutter the row overhangs is live scroller where
  a passing message paints behind the row. `workpin.mjs` checks it (its `PENDING` fixture exists
  because fixtures ending on an assistant row passed throughout).
- **The row is a shrink-wrapped PILL**: `.work` carries the fill, the 12px screen gutter lives on
  `#dworkhost` (padding on a shrink-wrapped row is inner air and would start the pill at x=0), and
  the inner padding is the bubble's own 11px — two separate claims, and `workpin.mjs` checks them
  separately. No `::before` mask: a pill's edge is meant to be an edge.
- **The pill holds its ground ALONE** — `--bg` at 78% plus the chip glass. It briefly ran at 60% on
  compositing arithmetic with a scrim underneath that then moved, costing the line 3.20:1 → 2.62:1.
  `dockscrim.mjs` samples TWO grounds with a `park` argument naming which surface the fixture puts
  a bubble behind — parking on the wrong one reports a confident 0% for a scrim that works.

## Bubbles

- **A photo FILLS its bubble** (Telegram's own treatment, measured). The 11px is cancelled by
  NEGATIVE MARGINS on the image, never a smaller padding on `.msg` — the text case keeps every
  number it was tuned with. With no caption the picture bleeds through the bottom and the time
  rides on it in a scrim pill (`.msg.imgonly`, set by the renderer). The image-only radius is
  **`inherit`**, never a literal — the four corners differ and a hand-written value disagrees on
  one. The text bubble's bottom was measured against Telegram and is already tighter; leave it.

## Colour and theming

- **Theming ignores `prefers-color-scheme` completely.** Colours come from the `--tg-theme-*`
  variables with dark fallbacks in `:root`. A light-theme check that sets the media feature renders
  the dark theme and passes without testing anything — set the variables (`themes.mjs`). Removing a
  bubble exposes whatever its fill was hiding.
- **The page is PINNED to Telegram's chrome colour — a TRIAL in its own commit.** The
  `--tg-theme-header-bg-color` param is NOT what the client paints, so `pinChromeColour()` sets
  `--bg` to the hex sampled off the owner's screenshots — his instruction. Gated on the RESOLVED
  page being dark, read from a rendered probe, never `tg.colorScheme`; a light theme keeps its own
  colours. It re-runs on `themeChanged` — **any fixture that injects theme variables must call it
  too**, or a dark-loaded page keeps the pinned `--bg` under black type. Every veil, scrim and fill
  is a `color-mix` of `--bg`, so the one token carries all of them (`headercolor.mjs` asserts it,
  plus the no-param fallback control). Known risk, revertable alone: `--sec` is every raised
  surface, and on a theme whose header colour sits near its secondary they flatten — the harness
  warns on proximity; how close is too close is the owner's eye.

## Header, scrims, z-order

- **The title is two bare lines — no capsule.** The two SIDE chips keep fill/lift/glass (the row's
  only 44px targets); the `--chip-*` family describes the side buttons only.
- **The ceiling scrim is TWO LENGTHS, not percentages of one height:** `--scrim-solid` reaches the
  NAME's floor; `--scrim-ramp` is everything below. Through the cwd's own line box the curve barely
  moves — that line's legibility IS the ground under it; the fade happens below. Fullscreen moves
  the SPLIT only: `html.fs` sets `--scrim-solid: var(--safe-top)`. Percentages could not express
  that — the attempt shipped two bugs in an hour.
- **The ramp keeps FADING through the header's band and lands well past it** (34px). Finish it
  above the header and glass over flat ground reads as paint (tried, owner-rejected); end it at the
  header's bottom and every drop the cwd needs happens in 9px — a cliff (shipped once, "very harsh
  and sudden"). `bleed.mjs` measures the rendered alpha profile — `getComputedStyle` needs the
  pseudo-element as its second argument, and a hit test must scan a band, not a point. The
  steepness check is scale-free (no step over 3× the ramp's own mean) — a fixed per-pixel bound
  really measures the ramp's LENGTH.
- **No glyph-level contrast treatment on the title lines.** Every stroke/shadow version was a
  symptom of a scrim stopping too high — fix the ramp, not the glyphs (owner, on the stroke: "a
  border that doesn't look premium"). Two general traps: stacked `text-shadow`s in the page's own
  colour still darken it ~6 units through 8-bit rounding and paint an accidental plate; buying
  contrast with a fatter stroke is a lumpy blob at 5px.
- **The header is three containers, derived CAPSULE-FIRST:** `--hbtn-d = --h-l1 + --h-l2 +
  2·--h-pad` (36px) and the buttons take that as their HEIGHT, so all three stay equal by
  construction. Line boxes are px, not `--lh-snug` — a fractional row height puts integer padding
  back on a half pixel. **Keep both button axes minus `--hbtn-glyph` EVEN** (36−24, 44−24): that
  parity is why the name's line box is 16 not 15 and why `--hbtn-w` steps by 8. The name rule
  carries `overflow: hidden`, so ink past the line box is SLICED — `header.mjs` measures clearance
  in pixels (canvas text metrics lied by a whole CSS pixel). `--w-semi` on `.name` is load-bearing.
- **The buttons are 44×36 stadiums** — radius `calc(--hbtn-d / 2)`, never `50%` (an ellipse whose
  flanks disagree with the capsule's ends). The height was taken below the 44px touch floor
  knowingly, twice asked; the width holds the target's area — don't take the height lower.
  `.dtitle`'s `margin-inline` is the ONE place the row's width budget is written.
- **The title centres on the dot+name GROUP, not the name** — the name sits ~8px right of the
  cwd's centre, the trade the owner picked; restoring the old `.nmrow::after` mirror is a revert.
  The dot class is shared with the sessions list (`.sess .dot`): a global size bump walks this name
  off its axis.
- **Nothing in the header is conditional** — `#dstop`'s hide-while-recording branch was deleted
  deliberately (do not restore). `#dsub` empty is a real state (a deep-linked open precedes the
  snapshot); it is `min-height`'s one visible job and the state to render after header changes.
- **The drill-in is FULL BLEED:** `#dfeed` is `position: absolute; inset: 0` and RESERVES the two
  floating surfaces as its own padding — top = `--safe-top` + the header's footprint, bottom =
  `--dock-h`, measured by a ResizeObserver on `#ddock`. Two things that look correct and are not:
  a gutter added on top of `--dock-h` doubles the last message's own margin; a conditional rule
  zeroing that padding puts the newest message 77px under the composer mid-turn (one existed).
- **The dock paints nothing; the strip is `.composer::before`**, and its numbers are the owner's:
  starts at the capsule's top edge (`inset: var(--sp-1) 0 0`), `--bg`'s own colour at 22%, and **no
  `backdrop-filter` — that is the point**: nothing is written on this strip, and the blur made
  passing text unreadable. `bleed.mjs`'s check is inverted to say so.
- **The header FLOATS over the feed** (`#drill .vhead` is absolute; `#dfeed`'s top padding is the
  row's footprint) — that is what makes `--chip-fill`'s translucency mean anything. The offset is
  **`top: var(--safe-top)`, not `top: 0`**: an abspos containing block is the ancestor's *padding*
  box, so `#drill`'s padding-top (the whole fullscreen mechanism) does not move it. And "a message
  is behind the chips" by rect overlap CANNOT FAIL (a clipped message still reports a spanning
  rect) — hit-test with `elementsFromPoint` (`header.mjs` does).
- **The chips are a SCRIM, not a raised surface**, measured off Telegram's own ✕ pill:
  `--chip-fill` is **44% of `--bg` at 36%** — a proportion, never a literal hex, because 44% of the
  ground is darker than the ground on any theme. `--chip-glass` is a filter LIST (`blur(20px)
  saturate(0.35)`): the saturate takes the colour cast out of a passing bubble without a
  `brightness()` clamp that would cost the resting colour. Tinting the fill toward `--text` is the
  wrong direction (tried). No filter makes a transparent chip ignore a bright thing under it —
  Telegram's own chips merely sit where the scrim already dissolved the content.
- **`#dfeed` carries `z-index: 0`** — it makes the scroller a stacking context so any z-index
  inside the feed stays LOCAL. Without it, `.more`'s `z-index: 1` tied the ceiling scrim's 1 and
  won on tree order — the fold label painted over the scrim at full strength. Any new floating
  surface over the feed goes above 1 (header and dock are 2). `elementsFromPoint` reports HIT
  order, not paint order — `batch5.mjs` §6 diffs pixels with the scrim toggled instead.
- **The z ladder:** `.tabs` 2 · `.newfab` 3 · `#drill` 5 · `#viewer` 6 · sheets 9/10 · `.err.float`
  11 (an error outranks a launcher). **A full-screen surface with NO z-index is at the BOTTOM of
  the ladder, not "top by source order"** — a positive z-index outranks `auto` at any source
  position (`#viewer` shipped without one; `.tabs`, a body-level sticky `showTab()` never hides,
  overpainted every opened file's header and captured its taps). It is 6, deliberately not 5 — a
  tie resolves by tree order, the dependence being fixed. Hit test and pixel diff answer different
  halves and neither substitutes; `viewerz.mjs` runs both, and its clean reference must FORCE a z
  (the unforced viewer is the thing under test).
- **Fullscreen is gated on `isFullscreen`, never the insets** (`syncSafeTop` sets `html.fs`) — the
  insets alone open a notch-sized gap in normal mode; the gate makes non-fullscreen byte-identical.
  `--safe-top` is PADDING on each top-anchored surface, not margin or top: the strip must be
  painted, and it must belong to the sticky box. Bottom sheets get nothing (72vh clears the chrome,
  measured); if a sheet grows toward the top the fix is a `max-height` — `align-items: flex-end`
  overflows *past* padding.
- **In fullscreen the header rides UP into Telegram's chrome band.** `--chrome-top`/`--chrome-h`
  are separate because the header centres *inside* the second. The pause control is a DOM MOVE into
  `.dtitle` — a control faking "not fullscreen" by zeroing a var fails. `.tcol` is `display:
  contents` outside fullscreen, keeping normal mode byte-identical. `--chrome-l/r` are THE one
  guess in the file — the API never exposes the buttons' x-extents, so they came off a screenshot
  (ink, not touch targets; the pill's 10% margin absorbs it). `BackButton` replaces our chip in
  fullscreen only; whether the client swaps ✕ Close for ← is unverified on a device.

## Sessions list and spawn sheet

- **A card has FOUR states and THREE dot colours, and the mismatch is the design.** `working`
  (green, pulsing) · `waiting` (amber, **still**) · `unreported` and `idle` (both the `--hint` grey).
  The pulse is what says *moving*, so a second animated state would leave two of them reading as
  live — stillness is what tells waiting from working, not the hue. `unreported` deliberately takes
  no fourth colour: four semantic colours on an 11px disc is past what a disc can carry, so its state
  lives in the task line alone. The amber is a literal for the same reason `.dot.on`'s green is
  (a token would make a frozen indicator inheritable). `waitstate.mjs` measures all of it — sampling
  RENDERED pixels, because a declared colour that resolves to the ground passes every
  computed-style assertion and is invisible on the device.
- **A state with something to say REPLACES the task line, never appends to it.** The line is one
  line and the card's height is reflow, so `⏸️ waiting: gh run watch` stands where the last-reply
  snippet would — which is right on its own terms: the snippet predates the wait. **`⏸️` carries
  U+FE0F and needs it**: bare U+23F8 resolves to text presentation and paints as two hairline bars
  that read as a broken character beside the emoji on every other row (seen in the contact sheet).
- **The drill-in header dot (`#ddot`) renders the card's three colours off `SessionFeed.state`** —
  green pulsing, amber still, grey — in the card's own precedence (`working` first, then `waiting`).
  It got **the colour only**: the header is two bare lines and nothing in it is conditional. The
  state is computed by the same `readSessionState` the card uses, which is the point — the two
  disagreed for a release (an amber card opened onto a grey dot) because each read the composite
  itself. A `state`-less payload (an older daemon, or the pre-transcript one) falls back to the
  working boolean, so the dot degrades to what it was rather than to grey.

- **No 5h window on a card, by ruling** — it is an ACCOUNT-level number, the same on every card, so
  it said nothing about the session. `h5Pct` stays on the payload: a 5h/weekly display belongs to
  the sessions PAGE and that design is still to come. **The foot is written only when it has
  content** — it carries `margin-top`, so an empty one is 8px of air under the task line, and the
  5h reading was often the only thing holding it open. `cardfoot.mjs` measures both, and the air
  below the last INKED row, since a zero-height foot reports the card's own padding and can never
  fail. `sessions-view.ts` (the `/sessions` text view) still prints it — untouched, not overlooked.
- **`#newfab` is static markup, a SIBLING of `#tab-sessions`, toggled by `showTab()`.** The list is
  wiped and rebuilt by a 4s poll — a control re-created under the thumb loses the tap. Building it
  inside `renderSessions()` looks natural and is the bug.
- **`#tab-sessions`'s bottom padding IS the pill's licence to float** (`--fab-h` + gutters) — the
  last card must always scroll clear of it, or the pill permanently covers that card's ✕.
- **No shadow, no entrance motion** — this file separates surfaces by fill and inset rings, and the
  4s repaint would replay any reveal forever.
- **No icon tile on a session card** — built, rejected on the owner's device; the status dot rides
  the title line at 11px, scoped `.sess .dot`. Boxiness is a RATIO (reference corner ≈ 0.33 of card
  height): `--r-3xl` (26) is derived, the card is 116 by reflow only, the name takes ONE line and
  ellipsizes (full name on `title`), and a card's `.chip` loses fill AND padding — scoped, since
  the turn-row chip is a real control. `sessions.mjs` carries three control pages, one per design
  round — no single control can falsify all three.
- **The spawn sheet HOSTS the composer's model dial — one component, two hosts.** `dialRow()`,
  `.diallist`/`.dialrow`, `DIAL_MODELS`/`DIAL_EFFORTS` serve both; `paintDial`/`dialHeight`/the
  detail page take a HOST, never `#dial` by id. The detail page is GENERIC (repainted per row —
  Effort and Mode share it). A hosted track needs its own clip box (`.dialtrack`) — clipping at
  `.sheet` leaves the off-screen page showing through the padding strip.
- **No synthetic "Default" row** — shipped once, owner-rejected. Concrete options only, a `Default`
  badge on the configured one, preselected. `spawnSel[k] === ""` means *follow what is configured*;
  the badged row is what `""` displays as, and tapping it sends NOTHING — you cannot pin a value
  that is also the default (the alternative freezes today's default into tomorrow's session).
  `spawnsheet.mjs` pins that a tap puts no `model` on the wire.
- **The sheet's "default" rows resolve DAEMON-SIDE at spawn time** — `webappSessionSpawn` applies
  `tg spawn`'s fallback chain (the `/settings` 🧑‍💻 coding-session defaults; never whatever pane was focused,
  which is the bug it fixed). The chip's badge is read once at sheet-open: a display, never a
  promise. MODE resolves the account's own `permissions.defaultMode`, and **an explicitly named
  mode carries `--permission-mode` even when it is `default`** (`dials.modeExplicit`) — on a box
  configured for bypass, "Ask" without the flag launched in bypass. Preferred-mode preselection
  reads `prefMode.raw` — `value` is a label with an emoji in it.
- **`#spname`'s focus ring is `--btn`.** Unstyled, `outline-style` resolves to `auto` and every
  platform paints its own — which is why `spawnsheet.mjs` samples pixels; a computed-style
  assertion passes on the broken page. The "blue reads as the owner's voice" ruling is about the
  FEED, not this sheet, where `--btn` is already every selected chip.
- **The sheet (and `#sched`, via shared `.sheet`) joins the `#dial`/`#calls`/`#addctx` family** —
  backdrop, 180ms slide, reduced-motion gate; two sheets opening differently is the drift the rule
  prevents. The Surface option left the sheet by ruling (every UI-created session gets a topic);
  the API keeps `headless: true` for bus throwaways — the guard is inverted on purpose.

## Narration and the final dot

- **Real `thinking` blocks are a dead end** — Claude Code persists them with `thinking: ""`
  (`transcript.ts`'s comment carries the measurement; do not build on them). "Thoughts" are mid-turn
  NARRATION: ordinary text blocks between tool calls. Every `t: 'p'` inside a turn item IS
  narration by construction — `webappSessionFeed` lifts the concluding reply out and re-appends it
  as its own `assistant` row.
- **Narration is UNMARKED — no bar, no indent — and byte-identical to the reply is the CHOSEN
  state.** The bar was declined; the indent was declined SEPARATELY and later, off a rendered
  contact sheet. Neither comes back as a faithful restoration — the "original" bar was invisible
  (17/255 from its ground) and what the owner rejected was its visible revival. `thoughts.mjs`
  counts the box properties on which narration differs from the reply: **zero**, and it passes. If
  that count ever moves, someone has re-marked narration — a decision, never a repair. It samples
  PIXELS, because a declared-colour assertion passed a bar no eye could find.
- **Narration is PROSE** — same size, weight, style, colour as the reply; the italic-mono demotion
  is retired for `.msg.activity`, `.msg.thought` and the slash invocation line (`.msg.command .cn`)
  alike. A demotion wanted back must be wanted for those rows specifically. The Telegram live card
  still quotes narration — that divergence is the owner's ruling.
- **A reply's first line opens with a 5px dot** (`FINAL_DOT`, `.fin`) — the complement of the
  unmarked-narration decision, never mirrored onto `.tq`/`.tp`. Which rows get it is not a
  judgement call: `role: "assistant"` IS the set of turn-concluding replies (`transcript.ts` admits
  assistant entries only when `stop_reason !== 'tool_use'`), so scrollback replies correctly carry
  it too. The dot is an inline CHILD of the reply's run, never a property of `.msg.assistant` — a
  row-level treatment would move one of the narration properties and fail that decision by
  construction (`finaldot.mjs` re-measures the zero-count). The stranding — a long first word wraps
  under the dot, leaving it alone on its line — is accepted and ASSERTED: a no-wrap "fix" fails the
  script, because it ships a different design than the one picked.

## Known and deliberately unfixed

- Feather's paperclip artwork is ~0.25px off-centre inside its own viewBox — the drawing, not our
  layout; a magic-number transform for a quarter pixel is worse than the quarter pixel.
