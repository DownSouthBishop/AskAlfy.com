# References

Screenshots captured live via browser automation (desktop = 1440px, mobile = 390px,
full viewport height unless noted). Compare new Alfy sections against these per the
iteration protocol in `/CLAUDE.md`.

## pally.com — the competitor to beat
`pally-desktop.png` · `pally-mobile.png` · `pally-phone-demo.png`

- **Learn from it:** the entire site is built around one artifact — an iMessage
  screenshot. Every section reinforces "this lives in your texts already."
  `pally-phone-demo.png` shows the pinned phone with a real conversation: Pally
  proactively bundles three tasks, asks "Can you handle them?", then confirms
  completion in one message. That's the closest existing product to Alfy's
  approval-first motif.
- **Ignore:** the cool-blue palette, the glossy glow/gradient behind the phone, and
  the dense feature-grid pacing — all in tension with Alfy's warm-neutral, no-glow,
  no-gradient constitution.
- **Steal:** the batching pattern in the chat transcript ("A few things need you
  today... Want me to check you in, book the table, and draft the email?") — this
  is a stronger real-world model for the hero conversation mock than anything we
  drafted from scratch, and it's exactly the shape of Alfy's fern hand-off moment.

## claude.ai — palette warmth, serif tone, calm trust
`claude-desktop.png` · `claude-mobile.png`

- **Learn from it:** warm off-white canvas, a serif display headline ("Question
  what's next") paired with restrained sans-serif UI chrome, and generous
  whitespace around a single clear action. This is the closest big-brand analogue
  to the Linen/Espresso/Fraunces-Inter pairing in the constitution.
  desktop capture only — mobile consistently hit a Cloudflare bot-check
  interstitial ("Just a moment...") across repeated attempts; not something
  scriptable from here. The desktop shot already covers the intended
  reference (palette + type tone), so this wasn't chased further.
- **Ignore:** the pricing-card layout and the dense dark footer — not relevant to
  Alfy's single-CTA landing page.
- **Steal:** the headline/subhead spacing ratio and how much negative space
  surrounds the single primary input — apply that restraint to the Alfy hero
  instead of crowding it with proof points.

## family.co — motion craft and micro-interactions
`family-desktop.png` · `family-mobile.png` · `family-midscroll-1.png` ·
`family-midscroll-2.png` · `family-midscroll-3.png`

- **Learn from it:** soft pastel accent shapes, a large confident wordmark
  treatment, and a phone mockup used as the literal product demo
  (`family-midscroll-1.png`) rather than an abstract illustration — same instinct
  as Alfy's conversation mock.
- **Note on the hero captures:** `family-desktop.png` / `family-mobile.png` were
  caught mid-animation — the headline uses a slow, staggered opacity fade that
  didn't fully settle even after a multi-second wait in an automated pass. Treat
  these two as illustrating the *technique* (soft fade-in choreography) rather
  than the final resting state; `family-midscroll-1/2/3.png` show the
  fully-rendered sections further down the page.
- **Ignore:** the crypto-wallet subject matter and icon set, obviously; also the
  hamburger-style top nav on mobile, which undersells the single-CTA simplicity
  Alfy needs.
- **Steal:** the restraint of one hero animation plus static, settled content
  below the fold — matches CLAUDE.md's "one signature animation per section max."

## superlist.com — warm color + mass-market friendliness
`superlist-desktop.png` · `superlist-mobile.png`

- **Learn from it:** a friendly, rounded, high-contrast product screenshot doing
  most of the persuasion work, with short plain-language copy around it — no
  jargon, no hype adjectives, close to Alfy's voice rules.
- **Ignore:** the multi-color, multi-product marketing (lists, docs, tasks all
  pitched at once) — Alfy's site should stay single-purpose ("Text Alfy").
- **Steal:** how confidently the product screenshot is sized relative to the
  headline — the demo isn't a small supporting graphic, it's co-equal with the
  copy. Worth matching for the Alfy conversation mock in the hero.

## linear.app — LAYOUT ONLY
`linear-desktop.png` · `linear-mobile.png`

**Constraint: layout only.** Study spacing rhythm and hierarchy — ignore the dark,
graphite/purple aesthetic entirely; it directly contradicts the constitution's
warm-neutrals-only rule.

- **Learn from it:** tight vertical rhythm between eyebrow / headline / subhead /
  CTA, and how section-to-section spacing compresses as you scroll past the fold
  (hero gets the most air, supporting sections get progressively tighter).
- **Ignore:** everything chromatic — the near-black canvas, the purple accent,
  the glow effects. None of it is compatible with Linen/Espresso/Marigold/Fern.
- **Steal:** the discipline of one strong headline size drop per section (display
  → h1 → h2) rather than many competing sizes on one screen — a good check
  against over-decorating the Alfy type scale.
