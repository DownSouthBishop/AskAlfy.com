# Alfy

A warm, comfortably competent assistant you reach by text message. No app, no login, no
dashboard you have to live in — a phone number.

You text Alfy. It reads across whatever you've connected — mail, calendar, chat,
spreadsheets, files — does the reading itself, drafts anything that needs to go out, and
asks before sending. Every morning it texts you a brief of what actually matters.

**The one rule: nothing leaves without a yes.** Alfy reads freely and acts never. Anything
that sends, posts, books, buys, changes, or deletes becomes a card you tap to approve. That
isn't a prompt instruction — it's enforced in the code, and the section below explains where.

---

## Quick start

```bash
npm install
npm run dev      # /app renders the dashboard on demo data — zero setup required
```

The site builds and runs with no accounts, no keys, and no database. To make it live, see
**[docs/alfy-handoff.md](docs/alfy-handoff.md)** — an ordered checklist, and:

```bash
npm run doctor   # prints exactly what's still missing, with the command to fix each one
```

---

## How it works

```
        text ──▶ alfy-sms-inbound ──▶ agent loop ──▶ Composio Tool Router ──▶ your apps
                  (Twilio sig)            │                                   (read)
                                          │
                                    write?├──▶ approval_queue ──▶ you tap yes
                                                                       │
                       confirmation text ◀── alfy-approve ◀────────────┘
                                                    └──▶ Composio (write)

        pg_cron (hourly) ──▶ alfy-brief ──▶ agent loop ──▶ your morning text
```

| Piece | What it is |
|---|---|
| **Marketing site** | Astro, static. The only CTA is the phone number. |
| **Dashboard** (`/app`) | Three tabs — Today, Handled, Alfy knows. React island. |
| **Login** | Phone OTP, plus a one-time link Alfy texts you (`/a?t=…`). |
| **Edge functions** | Six Deno functions under `supabase/functions/`. |
| **Database** | Postgres with RLS on every table from row one. |

### The agent carries three tools, not one per app

`get_context`, `find_tools`, `use_tool`. That's it.

Composio's Tool Router scopes a session to **every app the person has connected**
(`toolkits: null`) and the model searches for what it needs. So connecting a new app works
with no code change here, and there are no tool slugs hardcoded anywhere to go stale.

It's also the only affordable shape. Five connected apps is 200+ tool schemas; injecting
those into every request would cost more per text than the model does.

### Where the approval boundary actually lives

Inside `use_tool`:

```
read  → runs immediately, returns the result
write → becomes a pending approval_queue row; the model is told it has NOT happened
```

Composio's tool metadata carries no read/write flag — only tags, scopes, and `no_auth` — so
`isReadOnly()` in [`_shared/actions.ts`](supabase/functions/_shared/actions.ts) infers it
from the slug. A slug is read-only **iff it names a read verb and names no write verb**,
matching tokens anywhere in the slug because the verb isn't always first
(`GOOGLESHEETS_VALUES_GET` ends with one).

**It fails closed.** An unrecognised verb counts as a write. A toolkit nobody has seen
before gets queued for approval rather than executed silently. The failure mode is a
needless tap, never an unapproved send.

`alfy-approve` re-derives the same call before firing rather than trusting the queued row —
the queue is data, and that's the last gate before something actually leaves.

> ⚠️ `npm run check:actions` pins this behaviour down, including the unknown-verb cases.
> **Run it if you touch the verb lists.** It already caught one real miss:
> `SLACK_SENDS_A_MESSAGE…` uses a plural verb the first draft didn't match.

### Earned autonomy — Alfy asks to stop asking

A constant approval tax is how an assistant stops being worth it. If you've said yes to the
last four replies to Dana, a fifth prompt isn't caution, it's friction.

So Alfy watches, and when a pattern is unambiguous it **asks — once** — whether to handle
those itself:

> Done — Send email — dana@northbridge.com · Re: Thursday. — A
>
> That's the third one of these you've okayed. Want me to just send email to
> dana@northbridge.com from now on? Reply YES and I'll stop asking.

"Alfy asks first" is intact. It asks about the *pattern* instead of the instance, and the
friction falls as trust is earned rather than staying flat forever.

Four things keep it safe:

- **Scope is tool + target**, never tool alone (`scopeKey()`). "Always send replies to Dana"
  is a comfortable grant; "always send email" is not. The target is the same first field the
  card shows, so the permission covers exactly what you were looking at each time you agreed.
- **Evidence, not vibes.** Three approvals of that exact scope with **zero** skips. One skip
  means it isn't a pattern and Alfy keeps asking. Counted from `approval_queue` by
  `autonomy_candidate()`, so it can't drift.
- **Some things never graduate.** Deletes, payments, purchases, transfers, cancellations —
  see `canEarnAutonomy()`. A misfiring habit that emails the wrong person is recoverable; one
  that moves money isn't.
- **The grant is deterministic, not model-judged.** `alfy-sms-inbound` matches the reply
  against a literal affirmative set *before* the agent sees it. Consent for standing send
  authority doesn't route through a model's reading of the word "yes".

Autonomous actions still appear in **Handled**, attributed to the standing okay rather than
to a tap that never happened — autonomy isn't silence. Revoke any of them in **Alfy knows**.

### The card shows the action, not a description of it

`summary`, the draft, and the card's fields are all derived from the tool slug and payload
in `_shared/actions.ts` — and the browser imports that same module. One implementation, both
sides, so **the card cannot describe an action other than the one queued.**

Approving "send an email" without seeing who it goes to was never really consent. With Slack
posts and spreadsheet edits in the queue, it stops being a detail.

### Two models, and when each one runs

Inference is the only per-message cost, so the loop starts cheap and escalates at most once.
Neither trigger costs a classifier call or an extra round trip.

| Tier | Model | Runs |
|---|---|---|
| fast | `claude-haiku-4-5` | every turn by default — reads, lookups, "yes", "thanks" |
| careful | `claude-sonnet-5` (effort `medium`) | drafting, and synthesis |

- **Drafting** fires when a write is about to be queued — already the safety boundary, so it
  was free to detect. The assistant turn is discarded so the careful model composes it, with
  every read still in context.
- **Synthesis** fires when tool output passes `SYNTHESIS_CHARS` (8000). "Give me a quick
  overview of the channel" is read-only, so it never trips the first trigger, but it's the
  harder job. Nothing is discarded here — the reads were fine, it's the answering that wants
  the better model.

The tiers take **different request shapes**: Haiku 4.5 predates adaptive thinking and returns
a 400 for `output_config.effort`, so it gets neither. Don't merge the two config objects.

`runAgent` returns which tier answered; `alfy-agent`'s response body shows it while testing.

### The daily brief

`pg_cron` ticks hourly and `claim_briefs` takes whoever's **local** brief hour has come round
— one cron entry covers every timezone. It starts on the careful tier, because a brief is
synthesis by definition.

It **claims before running.** A crash costs one brief instead of re-running every tick
forever on a paid API. It also runs sequentially inside a wall-clock budget and leaves the
rest for the next tick, rather than fanning out concurrent agent runs that would blow the
function's time limit.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Astro dev server, demo data, no setup |
| `npm run doctor` | Setup checklist — every ✗ carries the command that fixes it |
| `npm run build` | Static build. Fails **on CI** if the placeholder phone number is still in place |
| `npm run check:actions` | The approval gate + card derivation. **Run after touching verb lists** |
| `npm run check:functions` | Typechecks the edge functions with Deno (the Astro build never sees them) |

---

## Layout

```
src/
  pages/            index, /app, /login, /a (SMS link handoff), 404, styleguide
  components/       marketing sections + AlfyDashboard, LoginForm, AuthHandoff
  lib/              supabase client, queue (data layer + demo fallback), config
supabase/
  functions/
    _shared/        agent, actions, composio, twilio, env, cors
    alfy-sms-inbound  Twilio webhook — the front door
    alfy-approve      the ONLY place an outbound action fires
    alfy-brief        pg_cron target for the daily brief
    alfy-connect      starts a Composio OAuth connect
    alfy-link         one-time SMS token → dashboard session
    alfy-agent        the loop on its own, for testing
  migrations/       0001 core+RLS · 0002 approval · 0003 brief · 0004 integrity · 0005 autonomy
scripts/            doctor, check-actions
docs/               alfy-handoff.md — the setup checklist
```

`CLAUDE.md` is the design constitution: palette, type, voice, and the three dashboard
sections. Match it exactly on anything you touch.

---

## Deliberate limits

Written down so they read as decisions, not oversights.

- **Alfy can't buy or book.** Composio can *search* flights, hotels, and products, but no
  toolkit completes a purchase. Closing that means browser automation through a checkout
  (fragile, and you'd be storing card details) or an integration deal with a provider. The
  shipped behaviour is search-and-hand-off: Alfy finds it and gives you the link. That's also
  the right posture for irreversible money — the `undo_until` window means nothing against a
  nonrefundable fare.
- **`users.quiet_hours_*` is unused.** It would gate proactive sends; the brief is the only
  proactive path and it fires at a time the person chose. Reserved.
- **The agent runs inline in the webhook.** Fine at this scale. The seam for an enqueue +
  worker is the `runAgent` call in `alfy-sms-inbound`.

---

## Stack

Astro 7 · React 19 · Tailwind v4 · Supabase (Postgres + Deno edge functions) · Composio Tool
Router · Twilio · Anthropic.
