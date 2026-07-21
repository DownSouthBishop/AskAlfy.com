# Alfy — setup checklist

Every step below turns one `npm run doctor` line green. Run doctor, do the top ✗, run it
again. When it's all green, do the smoke test at the bottom.

```bash
npm install
npm run doctor      # the whole list, with the exact command for each thing missing
npm run dev         # /app renders on demo data with zero setup — check this works first
```

Nothing here needs new code. The code is done; this is accounts, keys, and deploy.

---

## The accounts (in dependency order)

Do these in order — later steps need ids from earlier ones.

| # | Account | What you leave with |
|---|---------|---------------------|
| 1 | **Supabase** — a fresh project, not Prymal's | project ref, URL, anon key, service-role key |
| 2 | **Anthropic** | one API key |
| 3 | **Composio** — one auth config for Gmail, one for Calendar | API key + two `ac_…` auth-config ids |
| 4 | **Twilio** — buy a number, register A2P 10DLC | account SID, auth token, the number (E.164) |

> **Composio: managed or custom auth config?** Both work here — `alfy-connect` reads the
> id from `COMPOSIO_AUTHCFG_*`, so switching is a secrets change, not a code change.
> The difference is who owns the Google OAuth app. **Custom** = Alfy owns it, which means
> Alfy owns Google's CASA security assessment for the restricted Gmail scopes
> (`gmail.send`, `gmail.modify`) — annual, real money, months of lead time. **Managed** =
> Composio owns both. Pick before you create the config; it's the longest-lead item in
> this document by an order of magnitude.

---

## Wiring, step by step

**1 — Frontend env** → turns `PUBLIC_SUPABASE_*` green
```bash
cp .env.local.example .env.local     # fill PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, PUBLIC_APP_URL
```

**2 — Schema** → turns `supabase link` + `migrations` green
```bash
supabase link --project-ref <ref>
supabase db push                     # applies 0001_alfy_core + 0002_approval_hardening
```

**3 — Secrets** → turns `secrets` green. Names are listed in `.env.local.example`; every
function calls `requireEnv`, so a missing one fails at boot with its own name rather than
deep inside a fetch.
```bash
supabase secrets set \
  SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  ANTHROPIC_API_KEY=... \
  COMPOSIO_API_KEY=... COMPOSIO_AUTHCFG_GMAIL=... COMPOSIO_AUTHCFG_CALENDAR=... \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_PHONE_NUMBER=... \
  PUBLIC_APP_URL=https://askalfy.com
```

**4 — Deploy functions** → turns the five `fn …` lines green. Two are called by machines,
not sessions, and must skip the JWT gate:
```bash
supabase functions deploy alfy-agent alfy-approve alfy-connect
supabase functions deploy alfy-sms-inbound --no-verify-jwt   # caller is Twilio (signature-authenticated)
supabase functions deploy alfy-link       --no-verify-jwt    # caller has no session yet — that's the point
```

**5 — Twilio → Supabase**
- Twilio console → the number → Messaging → inbound webhook → the `alfy-sms-inbound`
  function URL, method POST. **Copy it exactly** — the signature check hashes the URL, so
  a trailing-slash difference fails every message with a 403.
- Supabase → Auth → Providers → Phone → Twilio (so typed-login OTP codes send).

**6 — The number** → turns `ALFY_PHONE` green
```
src/lib/config.ts → ALFY_PHONE = '+1…'
```
`npm run build` warns locally if this is still the placeholder and **fails on CI**, so a
dead `sms:` link can't reach production.

**7 — Deploy the site** with the `PUBLIC_*` vars set in the host's environment.

---

## Smoke test

Text the number → reply arrives with an `Approve:` link → tap it → lands on that exact
pending card → tap Approve → the action fires → confirmation text arrives.

That is the entire product. If it works, you're live.

---

## External API shapes — verified

These were the open `VERIFY` items. All confirmed against `docs.composio.dev`:

| Thing | Verified value |
|---|---|
| Host + version | `https://backend.composio.dev/api/v3.1` — **v3.1, not v3**; the v3 paths 404 |
| Auth header | `x-api-key` |
| Execute | `POST /tools/execute/{tool_slug}`, body `{user_id, arguments}` |
| Connect | `POST /connected_accounts/link`, body `{user_id, auth_config_id, callback_url}` → `redirect_url` |
| Result envelope | `{data, error, successful}` — `successful:false` arrives as **HTTP 200**, so it must be checked, not assumed |
| Slugs | `GMAIL_SEND_EMAIL`, `GMAIL_FETCH_EMAILS`, `GOOGLECALENDAR_CREATE_EVENT` |

All of it lives in `supabase/functions/_shared/composio.ts` — one file to edit if a version
or slug moves.

**Two things still need a live key to prove**, because docs can't:
- `GOOGLECALENDAR_FIND_EVENT` is the one slug the reference didn't confirm outright. If a
  read-calendar call 404s, `SLUG_READ_CALENDAR` in `_shared/composio.ts` is the string to
  change (`GOOGLECALENDAR_FREE_BUSY_QUERY` is the documented alternative).
- `GOOGLECALENDAR_CREATE_EVENT` takes `start_datetime` + `event_duration_hour` /
  `event_duration_minutes` + an IANA `timezone` — **not** the raw Google API's
  `start`/`end` objects. The agent's `queue_action` description already spells this out;
  confirm the first real invite lands at the right time.

---

## Cost shape — how the model tiering works

Inference is the only per-message cost, so the agent runs two tiers (`_shared/agent.ts`):

| Tier | Model | Handles | $/MTok in/out |
|---|---|---|---|
| fast | `claude-haiku-4-5` | every turn by default — reads, lookups, "yes", "thanks" | $1 / $5 |
| careful | `claude-sonnet-5` | drafting anything outbound | $3 / $15 |

The loop **starts fast and escalates at most once**, on either of two triggers. Neither
costs a classifier call or an extra round trip:

| Trigger | Fires when | Why |
|---|---|---|
| **drafting** | the model reaches for `queue_action` | something is about to go out in the person's name — already the approval boundary, so it was free to detect |
| **synthesis** | tool output this turn passes `SYNTHESIS_CHARS` (8000) | "give me a quick overview of the channel / the spreadsheet" is read-only, so it never trips the first trigger, but it's the harder job. What makes it hard — a lot of content in, a short useful answer out — is also what makes it measurable |

They behave differently on purpose. Drafting **discards** the assistant turn so the careful
model re-decides for itself, with every read still in context. Synthesis **keeps** everything
— the reads were fine, it's the answering that wants the better model.

Most texts never leave the fast tier. `runAgent` returns `tier` so you can see which one
answered — `alfy-agent`'s response body shows it directly while you're testing.

**Watch this in the smoke test:** the drafting trigger rests on Haiku reliably *calling*
`queue_action` rather than replying "I'll send that" without it. If a drafting request comes
back chatty with nothing in the Today tab, that's the failure mode — the fix is a firmer
rule 2 in `SYSTEM_PROMPT`, not a model change.

The two tiers take **different request shapes**: Haiku 4.5 predates adaptive thinking and
returns a 400 for `output_config.effort`, so it gets neither. Don't merge the two config
objects.

---

## The next real piece of work: a tool surface that follows the connections

Alfy's pitch is that you text it about whatever you've connected — "what did I miss in
Slack", "quick overview of the Q3 sheet". The **model tiering is ready for those**; the
tool surface is not.

Right now `_shared/agent.ts` exposes four hardcoded tools mapping to two fixed Composio
slugs (Gmail, Calendar). Connect Slack in Composio today and Alfy still can't see it —
there is no tool for it, at any model tier.

The fix is not more hardcoded slugs. Composio's own model is that a user's connected
toolkits determine their available tools (`composio.tools.get(user_id, toolkits=[…])`),
so the read side should be built from `connections` at turn start rather than compiled in.
That is a real change to `TOOLS` and `handleTool` — worth scoping deliberately, and worth
doing before adding a third integration by hand.

---

## Known-unfinished, deliberately

- **`standing_permissions` has no creation path.** The dashboard renders and revokes them,
  and the agent sees them via `get_context`, but nothing writes a row and no code bypasses
  the approval queue on their behalf. The Handled tab's "a standing yes you gave" is demo
  copy. Building the auto-execute path means building a hole through the one invariant the
  product is named for — worth doing deliberately, not as cleanup.
- **`users.quiet_hours_start/end` are unused.** They gate proactive sends, and nothing
  proactive exists yet — a reply to a text the person just sent is never quiet-hours-gated.
  Reserved for whenever scheduled checks land.
- **The agent runs inline in the webhook.** Fine at this scale; the seam for an
  enqueue + worker is the `runAgent` call in `alfy-sms-inbound`.
