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
supabase functions deploy alfy-brief      --no-verify-jwt    # caller is pg_cron (x-runner-key)
```

**4b — Schedule the daily brief.** The cron entry can't live in a migration: pg_net sends
the shared secret as a literal in the SQL body, which must never be committed. Run it once,
live, against the project — same value you set as `INTERNAL_FUNCTION_SECRET`:
```sql
select cron.schedule('alfy-brief', '0 * * * *', $cron$
  select net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/alfy-brief',
    headers := '{"Content-Type":"application/json","x-runner-key":"<INTERNAL_FUNCTION_SECRET>"}'::jsonb
  );
$cron$);
```
It ticks hourly and sends to whoever's *local* brief hour has just come round, so one entry
covers every timezone. Verify with `select * from cron.job;`.

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

**The loop:** text the number → reply arrives with an `Approve:` link → tap it → lands on
that exact pending card, showing the real recipient/channel/range → tap Approve → the action
fires → confirmation text arrives.

**A read:** "what did I miss in Slack today" → answer, nothing queued.

**The brief:** set `brief_hour` to the next hour for your own row, wait for the tick, or
fire it by hand:
```bash
curl -X POST https://<ref>.supabase.co/functions/v1/alfy-brief -H "x-runner-key: $INTERNAL_FUNCTION_SECRET"
```
It returns `{claimed, sent, failed, deferred}`. Note `claim_briefs` marks people done
**before** running, so a second immediate call correctly claims nobody.

If those three work, you're live.

---

## External API shapes — verified

These were the open `VERIFY` items. All confirmed against `docs.composio.dev`:

| Thing | Verified value |
|---|---|
| Host + version | `https://backend.composio.dev/api/v3.1` — **v3.1, not v3**; the v3 paths 404 |
| Auth header | `x-api-key` |
| Session | `POST /tool_router/session`, body `{user_id, toolkits: null}` → `{session_id, experimental.assistive_prompt}` |
| Search | `POST /tool_router/session/{id}/search`, body `{queries:[{query}]}` → `{tool_schemas, toolkit_connection_statuses}` |
| Execute | `POST /tool_router/session/{id}/execute`, body `{tool_slug, arguments}` |
| Direct execute | `POST /tools/execute/{slug}`, body `{user_id, arguments}` — used by `alfy-approve`, which fires later with no live session |
| Connect | `POST /connected_accounts/link`, body `{user_id, auth_config_id, callback_url}` → `redirect_url` |
| Result envelope | `{data, error, successful}` — `successful:false` arrives as **HTTP 200**, so it must be checked, not assumed |

All of it lives in `supabase/functions/_shared/composio.ts` — one file to edit if a path
or version moves. **No tool slugs are hardcoded anywhere**: the model discovers them through
`find_tools`, so there is no list to maintain and nothing to get stale.

**What still needs a live key to prove**, because docs can't: that `find_tools` returns
usable schemas for a real connected account, and that the verb heuristic classifies that
account's actual tools correctly. Send yourself one of each — a read and a write — and check
the write lands in Today rather than firing.

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

## How Alfy reaches apps — and how approval survives it

Alfy carries **three** tools, not one per integration: `get_context`, `find_tools`,
`use_tool`. Composio's Tool Router scopes a session to every app the person has connected
(`toolkits: null`) and the model searches for what it needs. So a newly connected app works
with **no code change here** — and five connected apps don't put 200 tool schemas in every
request, which would cost more per text than the model does.

The approval boundary sits in `use_tool`:

```
read  → runs immediately
write → becomes a pending approval_queue row; the model is told it has NOT happened
```

Composio's tool metadata has no read/write flag — only tags, scopes, `no_auth` — so
`isReadOnly()` (in `_shared/actions.ts`) infers it from the slug: read-only iff it names a
read verb *and* names no write verb, matching tokens anywhere in the slug because the verb
isn't always first (`GOOGLESHEETS_VALUES_GET` ends with one).

**It fails closed.** An unrecognised verb counts as a write. A toolkit nobody has seen
before gets queued for approval rather than executed. Worst case is a needless tap; never
an unapproved send. `npm run check:actions` pins that behaviour down, including the
unknown-verb cases — **run it if you touch the verb lists.**

`alfy-approve` re-derives the same call before firing, rather than trusting the queued row.

### The approval card shows the action, not a description of it

`summary`, the card fields, and the draft are all derived from the tool slug and payload in
`_shared/actions.ts` — the browser imports the exact module the agent writes with. The card
therefore cannot describe an action other than the one queued. Approving "send an email"
without seeing the recipient isn't consent, and with Slack posts and sheet edits in the
queue it stops being a detail.

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
