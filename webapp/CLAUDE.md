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
  (40px) takes a 20px glyph. Boxes positioned by integer padding are immune (`.ghost` is fine; the
  header's `.chatbtn` was measured and fixed the same way before it was retired with the chips). The
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
- **THE CEILING, and it is physics, not tuning: this layer CANNOT track the keyboard.** The DOM is
  handed exactly one snapshot — 112 beacon events, not a single intermediate `innerHeight`/
  `visualViewport` value in any transition — and it arrives **490ms and 532ms after the focus tap**,
  while the IME's own animation is 285ms. A native app rides `WindowInsetsAnimation` frame by frame;
  by the time this page hears anything the keyboard has been fully up for ~200ms. Telegram's
  `viewportChanged` *does* stream intermediate heights, and they are unusable: 500–700ms after the
  DOM already moved, overshooting the target (337 · 351 · 359 · 337 · 370 · 373 · 375 · 377 for a
  true 377) and contradicting themselves inside a millisecond (466 → 821 → 466). Its 7ms "lead" over
  the DOM, in one transition of the log, is 3% of an animation bought with that noise — refused, and
  the DOM stays the source of truth.
- **So the page MIRRORS the keyboard instead: the same animation, started from the focus event.**
  The CURVE is not a taste call — `cubic-bezier(0.2, 0, 0, 1)` is AOSP's `SYNC_IME_INTERPOLATOR =
  PathInterpolator(0.2f, 0f, 0f, 1f)`, verified against the source. The DURATION is: the IME's own
  285 (`ANIMATION_DURATION_SYNC_IME_MS`) shipped and read "just a touch too fast" on the device, so
  **330ms, his calibration**. Ours may exceed the IME's because it starts at the TAP, inside the
  ~500ms blind window — whose far edge is ~450ms, past which the animation would still be running
  when the snapshot lands and the reconcile would cut it short. `--kb-dur` is the one number to turn. `--kb-pre` is room the page takes
  **before the client gives it**, and only for a keyboard height it has already MEASURED this session
  (`kbSeen`) — nothing is guessed, the first rise after a launch is reactive and teaches it, and a
  prediction nothing confirms eases back out after 900ms. When the real resize lands, `layoutFloor`
  drops by the keyboard and `--kb-pre` drops to zero in the same handler: the surface's *apparent*
  floor does not change, so the reconcile starts no journey and costs nothing.
- **`setSurface` owns the disarm decision, and the reason is his webview's redundancy.** A write that
  must not animate (the reconcile) disarms `kbmove` first; a redundant event — he gets three or four
  per change and one repeats — changes nothing and must leave a running journey alone. Disarming on
  every call snapped the ease half way through, which the harness caught as a rise that eased in one
  mode and jumped in the other.
- **The journey is ONE COMPOSITOR LAYER, and the scroller is frozen while it moves.** The owner, on
  the version that eased the box and re-pinned `scrollTop` every frame: *"the transcript doesn't pin
  itself to the top of the keyboard — it moves independently and staggeringly, whereas premium apps
  are completely pinned and move in sync."* That is a defect with a number: a CSS transition
  interpolates on the compositor while a scroll write lands on the main thread a frame later, and
  `keyboard.mjs` measures the result at **69px of gap variation across 19 scroll writes** in one
  330ms animation. So nothing chases anything now — the destination (layout AND scroll position) is
  committed instantly in one frame, then the whole visible surface is parked back where it was with a
  single `translateY` and released. Same var, same clock, same layer: **0.0px of gap variation over
  354px of travel, one scroll write, before the travel.**
- **Who rides:** `#ddock` always; `#dfeed` only when the transcript is riding (`kbridefeed`) — moving
  the scroller's box is how you move its content, so a mid-thread reader is left out by construction;
  **never `.vhead`**, the same reason a transform on `#drill` was refused (the top edge does not move,
  so it would slide the header up from below). Content translated past the top is clipped by the
  viewport and passes UNDER the header on the way, which the existing z-order already provides.
- **TWO classes, and the split is load-bearing:** `kbride` DECLARES the transform, `kbrideon` arms the
  transition. In one rule, adding the class is itself a transform change (`none` → `translateY(dy)`)
  that the browser animates — so the park never lands and the release has nothing to travel from. It
  measured as a perfectly rigid gap with no motion at all. Neither class survives the ride: a
  permanent transform makes these boxes a containing block for anything fixed inside them, forever.
- **A REDUNDANT viewport event must return early.** His webview sends three or four per keyboard, and
  the commit resets the ride — so acting on the duplicates cancelled the animation the first one had
  just started, in the layout-shrink mode that is the only one his phone takes.
- **`noteFeedPosition()` is DEAF for the length of a journey.** The commit's own pin fires a scroll
  event dispatched a frame later against a box that has already changed, so the flag would read "320px
  from the floor" about a position just pinned to it and the next keyboard would refuse to carry the
  reader.
- **`keyboard.mjs` SIMULATES the keyboard** — a fake `visualViewport` installed before the page's
  script, plus a real viewport resize for the layout-shrink half. It runs the matrix that matters:
  {at the floor, mid-thread} × {rise, fall} × {visual-only shrink, layout shrink}, and records EVERY
  FRAME from inside the page for the rigidity claim — a 60ms sample cannot see a one-frame lag, and
  one frame is the whole defect. What no headless
  run can answer is which event Telegram's webview fires for a real keyboard; that leg needs a thumb.

## Feed

- **The fold is a veil to the element's FLOOR, not a band above the label:** runs to `bottom: 0`,
  hits full opacity above the label, and the ramp is EASED — linear reads as an edge. It is written
  once with `--fold-to` as the target colour (`--bg`/`--btn`/`--sec` per variant); overriding
  `background` on a variant silently drops the easing back to linear. `.msg.clip .more` needs its
  `z-index: 1` — `::after` paints after every child.
- **The LAST REPLY is exempt from the fold, and stays exempt until the NEXT reply.** Not until the
  next ROW — the owner, 2026-07-29: "it should stay expanded until your next final message, not right
  away when I message or while you're working". So his own message and the whole turn that follows
  land under an open answer. `assistant` only, and read from the PAYLOAD, never the DOM (an
  optimistic bubble paints after it). `lastReplyIndex()` is that definition, used by the fold and by
  the auto-fetch alike — those two disagreeing is a message rendered unfolded, clipped at 4000 chars,
  with no tap left to read the rest. `paintFeed` fetches a payload-clipped last reply's rest itself —
  once per uuid, never retried (`api()` toasts its own failures and a poll would raise one every 3s).
- **A hand-opened fold is keyed by `msgKey(i)` — `uuid`, or `role:ts` when the row has none.** The
  tap sets a class and the 3s poll rebuilds `innerHTML` from the payload, so anything the open state
  is keyed by must exist for EVERY bubble: rows without a uuid (an optimistic bubble, a transcript
  entry that carried none) had no key at all and lost the tap on the next repaint — measured, and the
  owner's "it re-collapses after 3 seconds". `expandFull()` still needs a real uuid; only the open
  state falls back.
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
  the caption. It sits INSIDE `.inputwrap`, on its own row above the field (the owner's ask once the
  capsule became two rows). It used to sit outside for a reason that died with the single-row
  capsule: a chip in that flex ROW took its width from the textarea. In a column it takes width from
  nothing. It is `display: none` when empty — an empty row would still pay the column's gap. `stage.mjs` measures the three misses: `syncComposerMode()` counts a
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

- **The title is a PILL again and the row carries nothing else** (the owner, 2026-07-30, reversing
  8c6ef3f/v0.4.154 now that the chips are gone). Restored from `8c6ef3f^`: stadium radius off
  `--hbtn-d`, `--chip-lift`, `--chip-glass` — but **NOT `--chip-fill`**. That fill was only ever half
  the floor and the halo was the other half; with the halo deleted in between, the old transparency
  measured the cwd at **2.46:1 dark / 2.03:1 light** over a bright bubble (`halo.py`), under AA and
  against 4.95/5.78 on the build it replaced. So the pill carries **92% of `--bg`** and IS the contrast
  floor; `halo.py`'s inverted control removes the pill's fill (not the ramp) and the cwd falls to
  1.18:1, which is what says the fill is load-bearing rather than decorative.
- **It is SHRINK-WRAPPED (`flex: 0 1 auto; margin-inline: auto`), and that is the difference between a
  pill and a header bar.** A filled box spanning the row is exactly the look the owner ruled out. In
  fullscreen the clearance is a `max-width: 90%` cap plus `margin-inline: auto` — `margin-inline: 5%`
  does not centre a shrink-wrapped box, it offsets it (10.9px against 71.2px, measured).
  `drillhead.mjs` proves shrink-wrap by lengthening the name and watching the box follow: "narrower
  than the row" passed on the old `flex: 1` title too.
- **The back and pause chips are GONE, and `.chatbtn` with them.** Back is the client's own ←, raised
  un-gated for this screen (see `openDrill`); the pause had **no replacement in this app** — a real
  function left the mini app, and it lives on only in Telegram (`/stop`, and 👎 on a message).
- **The ceiling scrim is TWO LENGTHS, not percentages of one height:** `--scrim-solid` is solid
  `--bg` and `--scrim-ramp` is the eased fall. Since 2026-07-30 the solid part ends at the **pill's
  top edge** (`--head-top`) and the ramp is the **pill's own band** (`--hbtn-d`) — the pill-era
  geometry, restored with the pill, because the near-solid band that replaced it IS the header bar the
  owner rejected. The pill-era build wrote those alphas as PERCENTAGES OF THE ELEMENT and they are not
  portable: as a percentage the solid part became "the top 26% of whatever this is", which in
  fullscreen left the client's whole chrome band see-through above the pill. Over the two lengths both
  modes end the solid part at the same place. Fullscreen lengthens **only the ramp**
  (`--chrome-h + --sp-3`): our header rides inside the client's band there, so the transcript scrolls
  under Telegram's buttons and the pill-era length would end 5px above the band's floor.
- **The ramp still fades THROUGH the band rather than capping it** — the transcript is visibly moving
  behind the pill, which is the point of the full-bleed feed. `bleed.mjs` and `headerup.mjs` measure the
  rendered alpha profile (`getComputedStyle` needs the pseudo-element as its second argument; a hit test
  must scan a band, not a point), and the steepness check is scale-free — no step over 3× the ramp's own
  mean, because a fixed per-pixel bound really measures the ramp's LENGTH.
- **No glyph-level contrast treatment on the title lines** (owner, on the stroke: "a border that
  doesn't look premium"). With the halo AND the near-solid ramp both ruled out, the pill's own fill is
  the only floor left — which is why its 92% is a measured number and not a taste call. Two general traps: stacked `text-shadow`s in the page's own
  colour still darken it ~6 units through 8-bit rounding and paint an accidental plate; buying
  contrast with a fatter stroke is a lumpy blob at 5px.
- **`--hbtn-d = --h-l1 + --h-l2 + 2·--h-pad` (36px) survives the buttons it was named for**: it is
  now the pill's height, its radius's source, the scrim's ramp length and the fullscreen centring
  offset. Line boxes are px, not `--lh-snug` — a fractional row height puts integer padding back on a
  half pixel. The name rule
  carries `overflow: hidden`, so ink past the line box is SLICED — `header.mjs` measures clearance
  in pixels (canvas text metrics lied by a whole CSS pixel). `--w-semi` on `.name` is load-bearing.
- **Radius is `calc(--hbtn-d / 2)`, never `50%`** — a percentage radius on a non-square box draws an
  ellipse whose flanks disagree with the ends, and it passes every width check.
- **The title centres on the dot+name GROUP, not the name** — the name sits ~8px right of the
  cwd's centre, the trade the owner picked; restoring the old `.nmrow::after` mirror is a revert.
  The dot class is shared with the sessions list (`.sess .dot`): a global size bump walks this name
  off its axis.
- **Nothing in the header is conditional** — there is nothing left in it that could be. `#dsub` empty
  is a real state (a deep-linked open precedes the
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
- **`--chip-fill` (44% of `--bg` at 36%) is now the COMPOSER capsule's, not the header's** — a
  proportion, never a literal hex, because 44% of the ground is darker than the ground on any theme.
  `--chip-glass` is a filter LIST (`blur(20px) saturate(0.35)`) shared with the header pill: the
  saturate takes the colour cast out of a passing bubble without a `brightness()` clamp that would cost
  the resting colour. Tinting a fill toward `--text` is the wrong direction (tried). **No filter makes a
  transparent surface ignore a bright thing under it** — which is the whole reason the title pill needed
  a denser fill than this one when it came back.
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
  are separate because the header centres *inside* the second. The pause's DOM move and the `.tcol`
  wrapper that existed for it are both gone (2026-07-30) — the header is one container in both layouts
  now, so nothing changes boxes when fullscreen flips. `--chrome-l/r` are THE one guess in the file —
  the API never exposes the buttons' x-extents, so they came off a screenshot (ink, not touch targets;
  the pill's 10% cap absorbs it). `BackButton` is raised for this screen in **every** layout now, not
  fullscreen only; whether the client swaps ✕ Close for ← is unverified on a device.

## The command center's order

- **Usage header → the CHAT lane's card → a "Coding Sessions" label → the coding sessions** (the owner's
  order, 2026-07-30). The chat card is pinned first **whatever order the payload arrives in and whatever
  state it is in** — reordered in `renderSessions`, not daemon-side, because the daemon's order serves
  every surface (`/sessions`, the roster) while this is one surface's layout. Several chat lanes
  (`dmLanes`) all lead, in the payload's own order. `listorder.mjs`'s fixture puts the chat lane LAST and
  idle with the workers working, so the pin is falsifiable rather than fixture-shaped.
- **The label is `.sechead` MINUS the uppercase, scoped to this panel.** The two halves of the ask pull
  against each other — the class carries `text-transform: uppercase`, which renders CODING SESSIONS, and
  the owner settled the label verbatim — so verbatim wins and everything else about the class stays (type
  step, colour, tracking, margins; `listorder.mjs` asserts them against the Scheduled view's own label,
  and that the scope did not leak). Going back to caps is deleting one declaration.
- **The label leads with `✳`, one FROZEN frame of `WORK_GLYPHS`** (the working row's six-glyph spinner —
  `· ✢ ✳ ✶ ✻ ✽`), glyph then a space then the words (the owner's placement, 2026-07-30). It is a
  decoration and nothing else: not animated, not read from any session's state, identical whatever the
  fleet is doing — the *moving* member of that family is the working row, and a second animated one
  would compete with it. It is an ELEMENT rather than a `::before`, so `listorder.mjs` can assert it:
  the harness matches the label as glyph + words (`LABEL`) and asserts the two halves separately,
  rather than being loosened to tolerate a decoration it has no opinion about.
- **The glyph OWNS THE CARDS' DOT COLUMN** (the owner, 2026-07-30) — so scanning down the panel the
  glyph and every status dot are one column. Nothing in it is a tuned offset: the label's
  `padding-left` is the card's own 14px less the label's own 2px margin, the glyph's box IS the dot's
  11px with the glyph centred in it, and the flex `gap` is `.sess .top`'s — which lands the words on
  the card NAMES' axis for free. A `text-indent` sized to the glyph's ink would be a font-metric
  constant that the next font step invalidates silently. `listorder.mjs` measures the rect **and** the
  rendered ink centroid (a box flex-centres while its contents paint off-centre — see the half-pixel
  snap note), each to ±0.5px: **0.00px on rects, 0.25px on paint** — the residual is the glyph's ink
  sitting off-centre inside its own advance, and it is printed rather than rounded away.
- **The words stand on the card NAMES' axis, and the box axis is the only column that exists** (the
  owner's second ask on this label, approved 2026-07-30). It falls out of the gap above rather than
  being set: box 45.00 against 45.00 for every card. **Do not chase the ink edges to zero** — a text
  rect is the ADVANCE box and each letterform sits inside its own side bearings, so the names' own ink
  edges disagree with *each other* (measured @dpr4: `C` 45.75 · `c` 45.50 · `m` 46.00) and no single
  axis can satisfy them all. What IS asserted is the strongest true claim: same letter, the label's
  12px/400 `C` against a card's 14px/600 `C`, **0.25px** apart. The per-letterform scatter is printed
  by `listorder.mjs` and deliberately not gated — it is type, not misalignment.
- **"The C flush with every session name" IS NOT ACHIEVABLE, by any lever — measured in his own font**
  (2026-07-30, after two photos and a verbatim spec naming the glyph→C gap as the only permitted lever).
  Session names start with different letters, and a letterform's left side bearing is its own: in
  **Roboto** the ink edges of the names' own first letters span **0.75px** (`t` of trading −0.625 from
  `m` of memes; `C` `c` `u` `i` `U` in between). They do not share an ink column **with each other**, so
  no single gap can put one `C` on all of them — and neither can a type change, since the label's letter
  is a `C` whatever size it is. The box axis (**45.00**, exact on every card) is the only column that
  exists. Best a single gap could do in Roboto: shift the words **0.25px** left, bounding the worst case
  at 0.375px instead of 0.625 — declined as a font-metric constant baked into a layout, and reported to
  the owner as his call. `labelaxis.mjs` §2 prints the whole table; do not re-open this without it.
- **THE HARNESS'S FONT IS NOT THE DEVICE'S, and every ink claim in this directory is font-local.**
  Headless Chromium here resolves `-apple-system, system-ui, …` to **DejaVu Sans**; his Android WebView
  resolves it to **Roboto**. That is what let `listorder.mjs` report the label's `C` flush with a card
  name (DejaVu: 0.000) while his screen had it 0.25–0.625px right. `device-font.mjs` fetches the real
  Roboto (cached in `.fonts/`, gitignored — a committed binary would ride every deploy) and it is a hard
  failure when unavailable: a measurement in the wrong font reads exactly like the right one. The
  standing gates stay in the harness font on purpose — a gate does not depend on the network — so they
  are regression checks on OUR render, and the device-font question belongs to the probe.
- **This column was DISPUTED off a phone photo and the photo agreed with the harness** (2026-07-30) —
  so before re-aligning it, measure. **A photo of this page is measurable, because the page puts a
  known-size object in every frame: the 11px status dot.** Scale = the dot's ink width ÷ 11, and every
  other offset in the frame converts to CSS px through it; his crop then read **0.25px** on the glyph
  and **0.49px** on the `C` — this file's own numbers. What remains is perceptual, not geometric: the
  `✳`'s ink is **8.8px** wide against the dot's 11, so a reader comparing left EDGES rather than
  centres sees the label 0.8px inset. Edge-aligning or up-sizing the glyph were both rendered for the
  owner and **not** taken. The column is built from paddings, so it is width-invariant by
  construction — `listorder.mjs` now checks two conditions (390/dpr4 and 320/dpr3) and
  `labelaxis.mjs` sweeps 320–430 × dpr 2–3 × {chat lane, worker} first: worst deviation **0.25px**.
- **It renders only where it has something under it, by construction:** emitted before the FIRST worker
  card, so a chat-only fleet gets no label without a condition to keep in sync. With no chat lane it still
  renders — it names the section it heads, and the owner's rule was "at least one coding session".
- **Anything reading this list POSITIONALLY has to match by name.** `cardfoot.mjs` read `[A,B,C,D,E]` off
  the DOM and silently became `[chat, …]` the day the pin landed — 9 checks failed against a correct page.
  It maps the fixture's own order back by name now; `sessions.mjs` measures the panel's first CHILD (less
  that child's margin) rather than its first `.sess`, since the first row may be the header or the label.

## The usage header

- **The account's 5h and weekly windows, ONCE, above the cards** (`#usagehead`, rendered by `renderUsage`
  inside `renderSessions`). Inside that function rather than as static markup because the 4s poll wipes
  the panel — safe here, unlike `#newfab`, because nothing in the header is a tap target to lose. It
  renders **before** the empty-list notice: it describes the account, so a fleet with no sessions still
  has usage worth reading.
- **It borrows the card's box and the foot's row, and that is the whole design** — `.sess` fill, radius
  and padding via the shared class, `.foot`'s size/colour, the cards' own `pctBar`. Two stated
  differences: `cursor: default` (not a tap target) and two stacked rows, each with its own bar.
  `usagehead.mjs` checks the sameness as **pixels** against a real card, not as a claim.
- **`usageWindows` (status-card.ts) is the ONE mapping the pin and the header both go through** — rounded
  percentage plus `fmtResetIn`'s wording. Two surfaces describing one account must not disagree about it,
  and "they read the same file" is not that guarantee. `usage-header.test.ts` pins the mapping (rounding,
  null-not-a-dash, one window, no snapshot); `scripts/usage-parity.ts` prints the header's rows beside the
  pin's strip from ONE read of the live snapshot.
- **The source is `usage.json`** (written by `statusline-command.sh` from Claude Code's own `rate_limits`)
  through `readUsageSnapshot`'s 120s staleness bound — **never** the pane scrape (`statusline.ts`'s
  `h5`/`d7`), which is per-pane and goes stale on an idle session while a header is account-wide. Stale ⇒
  no `usage` key ⇒ **no header**: a percentage nobody can date is worse than none, and `0%` would be a lie.
- **There is no per-model (e.g. Fable) window to show.** Claude Code's statusline JSON exposes
  `rate_limits.five_hour` and `rate_limits.seven_day` and nothing else; the CLI's `/usage` dashboard has a
  "Usage by model" **token** breakdown, which is not a limit percentage and would have to be scraped off a
  driven TUI. Do not derive one from either.

## Toasts

- **Success confirmations are OFF; failures are not — and the split is the point.** The owner,
  2026-07-30, on a green "Spawned test" over his list: the surface behind the bar already shows the
  outcome (a new card, a dropped card, a repainted settings value), so the bar repeated what the eye
  had. A failure has no such surface, so `showErr` is untouched — an action failing silently is worse
  than a redundant confirmation. Retiring the toast function outright would have crossed that line.
- **`showDone(m)` is the retired family — 11 sites, all still calling with their text**, gated by one
  `SUCCESS_TOASTS` flag. `showOk` keeps exactly **one** live caller: the dial's `"… requested…"`, which
  is not a confirmation at all (an effort change can sit behind Claude Code's own confirm for seconds,
  so it reports a REQUEST and the 3s poll reports the outcome). A blanket no-op inside `showOk` would
  have taken that one out silently — `toasts.mjs` pins it firing.
- **Removing a confirmation is only sound if something else says the same thing**, so `toasts.mjs`
  asserts the outcome per action alongside the absent bar, and drives the failure leg on the same
  action to prove the red bar still carries the server's own reason.

## Navigation (three destinations)

- **There is no tab row and no global Files view** (owner-approved restructure, 2026-07-30). The
  destinations are: the **command center** (the app's home), **Scheduled** behind its own pill, and
  **Settings** in the client's ⋮ menu. `showTab()` survives as the plain view switch it always was.
  Deleted with the row: `SHOW_TABS`/`html.notabs`, the four buttons and their CSS, `notabs.mjs`, and
  **the floating-reveal idea** — it existed to bring a four-way row back, and there is nothing left for
  it to reveal. The row also carried `--safe-top` for every flow view; **`body` carries that strip now**
  (0 outside fullscreen, so only fullscreen sees it — `nav.mjs` forces the var to check it).
- **Browsing is a SHEET inside the session that owns the folder** (`#fbrowse`, joining the
  `#spawn`/`#sched` family), reached from the paperclip's sheet as a third card — **Photos · Device ·
  Session folder**, with the old "Files" card renamed because it has always meant *from your phone*. Two
  "Files" a thumb apart, meaning different things, is the ambiguity the card placement exists to avoid. A
  one-tap 📁 in the control row is **PARKED**, not rejected: it costs the dial pill's width budget on a
  360px viewport, and it is a follow-up only if two taps wear badly.
- **The scope is STRUCTURAL, not a label:** `fbHost.root` is the session's cwd, the `..` row is not built
  at the root, and the crumb trail starts at the root's leaf name. There is no tap that leaves the scope.
- **`ls()`/`renderCrumbs()` take their host from `fbHost`** — one component, one host at a time, the same
  pattern `dialRow()` uses. `openFilesSheet(root, at)` takes both explicitly because the callers know
  different things (the paperclip knows the session, a link knows a path and maybe a session).
- **A session's cwd for the browser comes from the SESSIONS payload, never from the drill-in's
  subtitle** — that line is home-abbreviated for display (`~/projects/x`) and `/api/ls` cannot resolve a
  `~`; a root taken from there opens an empty sheet.
- **A file opens in `#viewer` and the sheet is closed first.** The viewer is z 6 and the sheets are 9/10,
  so a sheet left standing paints over the file it just opened and its backdrop eats every tap in the
  viewer's header.
- **Scheduled's pill is bottom-LEFT, square, icon-only and unfilled.** Two filled pills side by side stop
  either from being primary. Not "one gutter left of the blue pill" as the design note said: that pill is
  content-sized, so offsetting from it means arithmetic against a width nothing writes down and a label
  change would silently stack them. Both non-default views (**Scheduled and Settings**) raise the
  client's ← — neither has an on-screen way home, and treating one as the exception ships a view with no
  exit.
- **A `/files` deep link opens the session that owns the folder AND raises its sheet.** The link carries
  `&sid=` (and the `startapp` token record carries `sid`, returned by `/api/resolve`) so the match is
  exact rather than a cwd guess. **With no matching session the sheet opens standalone over the command
  center** at that folder — a link that no longer opens what it promised is worse than one surface with
  no session behind it. The cwd match is EQUALITY, never a prefix: `/files` mints the link from a
  session's cwd, and a prefix would claim a parent folder's link for a child session.
- **The recursive search died with the global view and has no home.** `/api/find` is untouched
  server-side, so the day it earns a place in the sheet there is nothing to rebuild but the UI.
- **`data-files="off"` REMOVES the browse card**, and every handler that reaches for a removed element
  must be guarded — an unguarded `$("ctxbrowse").onclick` threw at parse time on that configuration and
  the throw killed the rest of the script, leaving the composer's own constants uninitialised. `nav.mjs`
  runs that shell.

## Sessions list and spawn sheet

- **A card has FOUR states, THREE dot colours and only THREE it renders at all.** `working`
  (green, pulsing) · `waiting` (amber, **still**) · `unreported` and `idle` (both the `--hint` grey).
  The pulse is what says *moving*, so a second animated state would leave two of them reading as
  live — stillness is what tells waiting from working, not the hue. `unreported` deliberately takes
  no fourth colour: four semantic colours on an 11px disc is past what a disc can carry. It no longer
  takes a task line either — the owner, 2026-07-29: "it continuously shows up when work is actually
  done", so on BOTH card surfaces it reads as a finished session (`✅ <last reply>`, idle's own grey).
  The state itself is untouched: `wait-state.ts` still computes it, `tg roster` still shows it, and
  the bus's report nudges still run off it. It is not user-facing; it is not gone. The amber is a literal for the same reason `.dot.on`'s green is
  (a token would make a frozen indicator inheritable). `waitstate.mjs` measures all of it — sampling
  RENDERED pixels, because a declared colour that resolves to the ground passes every
  computed-style assertion and is invisible on the device.
- **The ONE exception to that amber: a waiting CHAT lane is green** (`.dot.rest`, the owner
  2026-07-29 — a chat lane waiting on its human is its resting state, not a stall, and amber reads
  as a problem where nothing is wrong). It is `.dot.on`'s green **without the pulse**, which is the
  rule above being obeyed rather than broken: stillness is still what tells waiting from working, so
  the hue is free to move. Branched off the payload's own `chat` flag beside the bare-title-row
  rule, never a name match, and it is one branch on one state — every other session's waiting stays
  amber and the chat lane's own working/idle are untouched. `chatrest.mjs` measures the whole
  {chat, worker} × {working, waiting, idle} matrix for exactly that reason. The drill-in header
  (`#ddot`) is not in that file and does not need to be — it shares the mapping now, and
  `dotparity.mjs` is where the two surfaces are compared (see `dotClass` below).
- **A state with something to say REPLACES the task line, never appends to it** — `waiting` is now
  the only one that does. The line is
  `-webkit-line-clamp: 1` (the owner's call, down from 2 on 2026-07-29: a card is a glance, and the
  second line bought a wrapped fragment rather than a second fact) and the card's height is reflow —
  the fullest card measures 96px where it was 116. So `⏸️ waiting: gh run watch` stands where the
  last-reply snippet would — which is right on its own terms: the snippet predates the wait. **`⏸️` carries
  U+FE0F and needs it**: bare U+23F8 resolves to text presentation and paints as two hairline bars
  that read as a broken character beside the emoji on every other row (seen in the contact sheet).
- **ONE function paints every status dot on every surface: `dotClass(s)`.** The card and the drill-in
  header both call it and neither writes the mapping itself — two copies is exactly how they came to
  disagree (the owner, 2026-07-30: a chat lane waiting for him was solid green on the list and amber in
  the chat view at the same moment, because the header's copy had no `chat` branch and `SessionFeed`
  carried no `chat` flag to branch on). The flag is on the feed payload now, on **both** its returns
  including the pre-transcript one. `dotparity.mjs` renders both surfaces off ONE fixture across every
  state and compares class, **rendered pixel** and animation — a colour match with a pulse mismatch is
  still two indicators.
- **`.err` is `:not(.dot)`, and that is a fix, not a nicety.** The toast class's `display: none` reached
  `.dot.err` at a specificity no `.dot.err` declaration could beat (it sets background and animation,
  never display), so an **errored** session painted no dot at all on either surface and the row shifted.
  Do not "simplify" the selector back. Found by reading pixels; a parity check alone passed, because
  both surfaces agreed on nothing.
- **The drill-in header dot (`#ddot`) renders the card's three colours off `SessionFeed.state`** —
  green pulsing, amber still, grey — in the card's own precedence (`working` first, then `waiting`).
  It got **the colour only**: the header is two bare lines and nothing in it is conditional. The
  state is computed by the same `readSessionState` the card uses, which is the point — the two
  disagreed for a release (an amber card opened onto a grey dot) because each read the composite
  itself. A `state`-less payload (an older daemon, or the pre-transcript one) falls back to the
  working boolean, so the dot degrades to what it was rather than to grey.
- **The mode chip is LATCHED daemon-side, and a payload `mode` of `default` means "Ask mode OR nothing
  on screen".** Claude Code's footer shares the mode-indicator slot with its transient hints, so a raw
  read blinks the chip out of a card whose pane never changed mode — measured on the owner's chat lane,
  which takes a paste on every inbound message. `mode-latch.ts` serves the last mode actually SEEN (5
  minutes, then it decays so a hand-cycled pane stops claiming the old one) and
  `scripts/mode-latch-live.ts` manufactures the indicator-less frame — it fails on the pre-fix daemon
  and is INCONCLUSIVE rather than green when the frame doesn't reproduce. There is nothing to fix in
  the client: hiding or holding the chip there would be the same blink with a second source of truth.
- **A session being killed leaves the list on the KILL, not on its pane's death.** `tg kill` / `/exit
  @name` / the ✕ all type /exit, and a BUSY session doesn't read it until its turn ends — 37s of a green
  pulsing card for a session the owner had already killed (`endingSids` in daemon.ts, measured by
  `scripts/webapp-measure/busykill.mjs`; deadcard.mjs covers the idle kill, which needs no mark).

- **The owner's own chat lane is a FULL CARD — no `chat` branch left in `renderSessions` at all.**
  It renders the bare title row (dot, name, dials, ✕) between 2026-07-29 and 2026-07-30 and he
  reversed that himself once the hidden tab row freed the vertical room; the fields are back to the
  same task line and foot every other card carries. `cardfoot.mjs` measures CONGRUENCY, not mere
  presence — same line box, same gap, same card height as an ordinary card — on the fixture that once
  pinned the bare row, and the old page fails 4 of its checks. `/sessions` (`sessions-view.ts`) lost
  its early return in the same commit: one state, one shape, wherever he reads it — a surface that
  keeps the old card reads as a different session.
- **`chat` on the payload now drives exactly ONE thing in the client: the resting dot colour**
  (`.dot.rest`, above). It is still `isChatLaneSession` daemon-side and still **never a name match** —
  the label is "Chat" until a handle resolves. The 5h window stays off this card like every other — a
  separate ruling, now scoped to cards (below).
- **A chat lane's label NEVER carries the numeric Telegram id.** It is `Chat (@handle)`, or plain
  `Chat` until `getChat` answers — the id flashed in the UI and swapped itself out, which the owner
  saw. `warmDmHandles()` runs at webapp start so the resolved name is usually there for the first
  paint; the plain-`Chat` fallback is what guarantees the id never appears at all.
- **No 5h window on a CARD — and that ban is SCOPED, not absolute, since 2026-07-30.** The reasoning is
  unchanged: it is an ACCOUNT-level number, the same on every card, so per-card it said nothing about the
  session. The owner re-confirmed exactly that and approved the **command center's usage header** as the
  once-only home for it — so cards stay banned and the header is the sanctioned exception (see *The usage
  header*). `h5Pct` stays on the card payload untouched, and both `cardfoot.mjs` and `usagehead.mjs` keep
  a fixture that carries it, so "no card shows it" is a client decision and not an empty payload. **The foot is written only when it has
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
  height): `--r-3xl` (26) is derived, the card is 96 by reflow only (26/96 = 0.27, nearer the
  reference than the 0.22 it was at 116 — the one-line clamp moved the card, not the radius), the name takes ONE line and
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
