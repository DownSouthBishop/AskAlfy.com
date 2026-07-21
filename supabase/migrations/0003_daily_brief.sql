-- The daily brief: one text each morning that condenses whatever's relevant across the
-- apps the person has connected.
--
-- Scheduling lives in Postgres rather than an external cron so there's no new infra and no
-- second place to look when a brief doesn't arrive. pg_cron ticks hourly; each tick claims
-- the users whose LOCAL hour has come round.

create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table users
  add column if not exists brief_enabled      boolean  not null default true,
  add column if not exists brief_hour         smallint not null default 7,   -- 24h, the person's own timezone
  add column if not exists brief_last_sent_on date;                          -- their local date, not UTC

-- ─────────────────────────────────────────────────────────────────────────────
-- claim_briefs — pick the users due right now AND mark them done, in one statement.
--
-- Claiming BEFORE the run is deliberate. Cal's automation runner wrote last_run_at after
-- the agent finished, so anything that timed out re-ran on every following tick, forever,
-- billing inference each time. For a once-a-day digest, losing one brief to a crash is far
-- cheaper than a hot loop — so the claim happens first and a failure just waits for
-- tomorrow.
--
-- FOR UPDATE SKIP LOCKED + LIMIT means overlapping ticks never double-send and never
-- collide; whatever a tick doesn't take, the next one picks up. There is no global cap:
-- the batch bounds one invocation, not the system.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function claim_briefs(p_limit int default 20)
returns table (user_id uuid, phone_e164 text, timezone text)
language sql
security definer
set search_path = public
as $$
  with due as (
    select u.id
    from users u
    join user_phones p
      on p.user_id = u.id and p.is_primary and p.consent = 'opted_in'
    where u.brief_enabled
      and extract(hour from (now() at time zone u.timezone)) = u.brief_hour
      and (u.brief_last_sent_on is null
           or u.brief_last_sent_on < (now() at time zone u.timezone)::date)
    order by u.id
    limit p_limit
    for update of u skip locked
  )
  update users u
     set brief_last_sent_on = (now() at time zone u.timezone)::date
    from due, user_phones p
   where u.id = due.id
     and p.user_id = u.id and p.is_primary
  returning u.id, p.phone_e164, u.timezone;
$$;

-- Users pick their own brief time from the dashboard; nobody else's.
revoke update on users from authenticated;
grant update (display_name, about, recovery_email, timezone,
              quiet_hours_start, quiet_hours_end,
              brief_enabled, brief_hour) on users to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The cron entry is NOT in this file: pg_net sends the shared secret as a literal in the
-- SQL body, and that must never be committed. Register it once, live, against the project
-- (see docs/alfy-handoff.md), using the same value you set as INTERNAL_FUNCTION_SECRET:
--
--   select cron.schedule('alfy-brief', '0 * * * *', $cron$
--     select net.http_post(
--       url     := 'https://<ref>.supabase.co/functions/v1/alfy-brief',
--       headers := '{"Content-Type":"application/json","x-runner-key":"<INTERNAL_FUNCTION_SECRET>"}'::jsonb
--     );
--   $cron$);
-- ─────────────────────────────────────────────────────────────────────────────
