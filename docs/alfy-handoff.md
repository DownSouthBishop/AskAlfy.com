# Alfy — Handoff for the last session

This repo is built to **near-completion**. Every line of code is here. The remaining work is
**account setup, secrets, deploy, and verifying a short list of external API calls** — no new
architecture. Fork it and finish.

---

## The four accounts (the only things code can't do for itself)

1. **Supabase** — a *separate* project for Alfy (entity isolation; do NOT reuse Prymal's).
2. **Twilio** — a phone number + A2P 10DLC registration (the number *is* the product).
3. **Composio** — Gmail + Google Calendar via a **custom auth config** (own the OAuth app so
   tokens belong to Alfy, not Composio-managed which redacts them).
4. **Anthropic** — one platform API key (consumers can't paste a key over SMS).

---

## What's already done (do not rebuild)

| Layer | Status | Where |
|---|---|---|
| Marketing site | ✅ done | `src/pages/index.astro` + `src/components/*` |
| Dashboard — 3 tabs (Today / Handled / Alfy knows) | ✅ done, interactive | `src/components/AlfyDashboard.tsx` |
| Weekly breakdown + range control (in Handled) | ✅ done | same |
| Login — phone OTP, Jobs-cut | ✅ done | `src/components/LoginForm.tsx`, `src/pages/login.astro` |
| Data layer (Supabase + demo fallback) | ✅ done | `src/lib/queue.ts`, `src/lib/supabase.ts` |
| DB schema + RLS + link-approval | ✅ done | `supabase/migrations/0001_alfy_core.sql` |
| Agent loop (Composio tools + "asks first" queue) | ✅ scaffold | `supabase/functions/alfy-agent/` |
| SMS inbound webhook + onboarding on "YES" | ✅ scaffold | `supabase/functions/alfy-sms-inbound/` |
| Magic-link handler (session mint) | ✅ done | `supabase/functions/alfy-link/` |
| `/a` handoff page (token → session → deep-link) | ✅ done | `src/pages/a.astro`, `src/components/AuthHandoff.tsx` |
| Approval executor | ✅ scaffold | `supabase/functions/alfy-approve/` |
| Composio connect flow | ✅ scaffold | `supabase/functions/alfy-connect/` + Settings button |
| Approve button → executes | ✅ done | `src/lib/queue.ts` (`approveItem` → `alfy-approve`) |

"Scaffold" = complete structure, correct DB logic, external API calls marked `VERIFY`.
"Done" = uses documented APIs, no open calls.

**Auth model:** onboarding creates one `auth.users` with both the phone AND a synthetic email
(`<digits>@sms.askalfy.com`). Typed login → phone OTP. SMS deep-link → email-style magic link
via that synthetic email. Both resolve to the same account.

---

## The last session, step by step

1. **Supabase project** → copy URL + anon key into `.env.local` (`PUBLIC_SUPABASE_*`).
2. **Run the schema:** `supabase db push` (applies `0001_alfy_core.sql`).
3. **Set function secrets** (see `.env.local.example` list) via `supabase secrets set`.
4. **Deploy functions:** `supabase functions deploy alfy-agent alfy-sms-inbound alfy-link alfy-approve alfy-connect`.
   - First move `runAgent` to `supabase/functions/_shared/agent.ts` and import it in both
     `alfy-agent` and `alfy-sms-inbound` (Supabase bundles per-folder).
5. **Twilio:** buy a number → register A2P 10DLC → point the number's inbound webhook at the
   `alfy-sms-inbound` function URL → put SID/token/number in secrets.
6. **Composio:** create a **custom auth config** for Gmail + Calendar (Alfy owns the OAuth app);
   put the two auth-config ids in secrets (`COMPOSIO_AUTHCFG_GMAIL/_CALENDAR`). The connect
   flow + Settings button already call them.
7. **Supabase phone auth:** Auth → Providers → Phone → **Twilio** (so login codes send).
8. **The number:** set `ALFY_PHONE` in `src/lib/config.ts` to the real Twilio number.
9. Set `PUBLIC_APP_URL`, deploy the site (Vercel/Netlify), smoke-test the loop below.

**Smoke test:** text the number → get a reply + an `Approve:` link → tap it → land on the
pending card → tap Approve → action fires → confirmation text arrives.

---

## VERIFY checklist (the only unproven calls)

- [ ] **Composio execute** endpoint/shape + tool slugs (`GMAIL_SEND_EMAIL`,
      `GOOGLECALENDAR_CREATE_EVENT`, `GMAIL_FETCH_EMAILS`, `GOOGLECALENDAR_FIND_EVENT`) —
      in `alfy-agent` / `alfy-approve`.
- [ ] **Composio connect** body shape for `POST /v3/connected_accounts/link` — in `alfy-connect`.
- [ ] **Twilio signature** verification in `alfy-sms-inbound` (currently a TODO — add before prod).
- [ ] **Twilio send** (Messages API basic-auth) — confirm creds/format.

(Session mint in `alfy-link` is resolved — documented `generateLink` + `verifyOtp` pattern.)

---

## Branding — non-negotiable, must match what's built (see `/CLAUDE.md`)

The finishing session must preserve the design constitution exactly:

- **Only three dashboard sections:** Today, Handled, Alfy knows. Do not add a fourth.
- **Palette (hardcoded, never substitute):** linen `#FAF5EC`, card `#FFFDF8`, hairline
  `#E7DFD0`, espresso `#2E2A24`, marigold `#E08A2E` (primary action only), **fern `#4E7D68`
  reserved for approval/trust moments only**. No purple, neon, gradients, glassmorphism.
- **Type:** Fraunces (headlines only), Inter (everything else). Self-hosted.
- **Voice:** plain words, contractions, no exclamation marks, no emoji, sentence case,
  sign-off "— A". Never "AI-powered" — Alfy is "an assistant."
- **The law:** nothing leaves without a yes. The approval queue + link flow *is* the product.
  Fern = granted trust. Keep it grandmother-comprehensible.

Any new screen inherits `src/styles/global.css` tokens and the card/`label-caps`/`card-lift`
patterns already used in `AlfyDashboard.tsx`. Match, don't reinvent.
