# Alfy — Handoff for the last session

This repo is built to **near-completion**. Every line of code is here. The remaining work is
**account setup, secrets, deploy, and verifying a short list of external API calls** — no new
architecture. Fork it and finish.

**Update — Phase 1 backend port (see `docs/prymal-port-reference.md`):** Gmail + Calendar no
longer go through Composio. AskAlfy now owns a real Google OAuth app and talks to the Gmail
and Calendar REST APIs directly (pattern ported from PrymalAI-dashboard's proven backend).
A fresh Supabase project (`askalfy`, ref `kpybomnunyhazkenyoeb`) has been provisioned for
this and carries the extended schema (`oauth_tokens`, richer `people`, `standing_instructions`
in addition to the original `0001_alfy_core.sql` tables). PrymalAI-dashboard's own Supabase
project has been paused — AskAlfy replaces it going forward. Composio stays in the dependency
tree for future non-Google apps only; it is not called anywhere in Phase 1's code path.

---

## The accounts (the only things code can't do for itself)

1. **Supabase** — done for Phase 1: the `askalfy` project already exists. Copy its URL +
   anon key into `.env.local`.
2. **Twilio** — a phone number + A2P 10DLC registration (the number *is* the product).
3. **Google Cloud OAuth client** — a **Web application** OAuth 2.0 client (own the app so
   tokens belong to Alfy directly, no third party in between). Register redirect URI
   `${PUBLIC_APP_URL}/auth/google-callback`. Composio is no longer used for Gmail/Calendar —
   this replaces steps 3 ("Composio") from the original four-account list.
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
| DB schema + RLS + link-approval | ✅ done | `supabase/migrations/0001-0004_*.sql` |
| Agent loop (Gmail/Calendar tools + "asks first" queue) | ✅ scaffold | `supabase/functions/_shared/agent.ts` |
| SMS inbound webhook + onboarding on "YES" | ✅ done | `supabase/functions/alfy-sms-inbound/` (Twilio signature now enforced) |
| Magic-link handler (session mint) | ✅ done | `supabase/functions/alfy-link/` |
| `/a` handoff page (token → session → deep-link) | ✅ done | `src/pages/a.astro`, `src/components/AuthHandoff.tsx` |
| Approval executor | ✅ scaffold | `supabase/functions/alfy-approve/` (send_email, create_event; other action_types fail gracefully) |
| Google OAuth connect flow | ✅ scaffold | `supabase/functions/alfy-connect/`, `src/pages/auth/google-callback.astro` + Settings button |
| Approve button → executes | ✅ done | `src/lib/queue.ts` (`approveItem` → `alfy-approve`) |

"Scaffold" = complete structure, correct DB logic, external API calls marked `VERIFY`.
"Done" = uses documented APIs, no open calls.

**Auth model:** onboarding creates one `auth.users` with both the phone AND a synthetic email
(`<digits>@sms.askalfy.com`). Typed login → phone OTP. SMS deep-link → email-style magic link
via that synthetic email. Both resolve to the same account.

---

## The last session, step by step

1. **Supabase project** — already done (`askalfy`, ref `kpybomnunyhazkenyoeb`). Copy its URL +
   anon key into `.env.local` (`PUBLIC_SUPABASE_*`). Migrations `0001`-`0004` are already
   applied to it.
2. **Set function secrets** (see `.env.local.example` list) via `supabase secrets set` —
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are new; `COMPOSIO_*` are no longer needed.
3. **Deploy functions:** `supabase functions deploy alfy-agent alfy-sms-inbound alfy-link alfy-approve alfy-connect`.
4. **Google Cloud OAuth client:** create a Web application OAuth client, register redirect
   URI `${PUBLIC_APP_URL}/auth/google-callback`, put the client ID (also hardcode in
   `src/lib/config.ts`'s `GOOGLE_CLIENT_ID`) and secret in Supabase function secrets.
5. **Twilio:** buy a number → register A2P 10DLC → point the number's inbound webhook at the
   `alfy-sms-inbound` function URL → put SID/token/number in secrets.
6. **Supabase phone auth:** Auth → Providers → Phone → **Twilio** (so login codes send).
7. **The number:** set `ALFY_PHONE` in `src/lib/config.ts` to the real Twilio number.
8. Set `PUBLIC_APP_URL`, deploy the site (Vercel/Netlify), smoke-test the loop below.

**Smoke test:** text the number → get a reply + an `Approve:` link → tap it → land on the
pending card → tap Approve → action fires → confirmation text arrives. For Gmail/Calendar
actions specifically, connect Google first from Settings → Connections.

---

## VERIFY checklist (the only unproven calls — needs live credentials, see
## `docs/prymal-port-reference.md` §9 for what's already self-verified)

- [ ] **Google OAuth token exchange + refresh** (`alfy-connect`, `_shared/google.ts`) against
      a real GCP OAuth client — redirect URI must match exactly.
- [ ] **Gmail send/read + Calendar create/read REST calls** (`_shared/google.ts`) against a
      real connected Google account.
- [ ] **Twilio signature** verification in `alfy-sms-inbound` (now implemented — verify
      against a live Twilio webhook, not just unit logic).
- [ ] **Twilio send** (Messages API basic-auth) — confirm creds/format.

(Session mint in `alfy-link` is resolved — documented `generateLink` + `verifyOtp` pattern.
Composio's connect/tool-execute calls are no longer part of this path — see the Phase 1
update at the top of this doc.)

**Not built yet (see `docs/prymal-port-reference.md` for the full roadmap):** rest of Gmail/
Calendar CRUD, Tasks/Drive/Docs/Sheets, the "Alfy knows" tab wired to real `people` data,
standing-instruction tools + automation runner, Stripe billing/plan tiers.

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
