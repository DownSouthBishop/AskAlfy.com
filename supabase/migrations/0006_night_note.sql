-- The night note: one text at the end of the day saying what Alfy actually did with it.
-- The morning brief reads the world; this reads Alfy's own ledger (approval_queue) and
-- reports back. It is a receipt, and the trust story only works if it is complete.
--
-- Same scheduling shape as 0003: pg_cron ticks hourly, each tick claims whoever's LOCAL
-- hour has come round, claim-before-run so a crash costs one note instead of looping.

alter table users
  add column if not exists recap_enabled      boolean not null default true,
  add column if not exists recap_last_sent_on date;                          -- their local date

-- Its own switch rather than sharing brief_enabled: a second unasked-for text a day with no
-- way to turn it off on its own is a consent problem, not a settings inconvenience.
grant update (recap_enabled) on users to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- claim_recaps — claim_briefs for the evening. Deliberately a copy rather than a shared
-- parameterised function: switching which column the UPDATE writes would need either CASE
-- over both set-expressions or dynamic SQL, and neither belongs in the one statement that
-- decides who gets texted. Boring duplication is the cheaper risk here.
--
-- There is no recap_hour column. The note goes out the hour BEFORE quiet hours start, so it
-- can never land inside them and there is no new setting to design. Modulo, not minus one:
-- quiet_hours_start = 0 would otherwise compute hour -1 and silently never match.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function claim_recaps(p_limit int default 20)
returns table (recap_user_id uuid, recap_phone text)
language sql
security definer
set search_path = public
as $$
  with due as (
    select u.id
    from users u
    join user_phones p
      on p.user_id = u.id and p.is_primary and p.consent = 'opted_in'
    where u.recap_enabled
      and extract(hour from (now() at time zone u.timezone)) = (u.quiet_hours_start + 23) % 24
      and (u.recap_last_sent_on is null
           or u.recap_last_sent_on < (now() at time zone u.timezone)::date)
    order by u.id
    limit p_limit
    for update of u skip locked
  )
  update users u
     set recap_last_sent_on = (now() at time zone u.timezone)::date
    from due, user_phones p
   where u.id = due.id
     and p.user_id = u.id
     and p.is_primary
  returning u.id, p.phone_e164;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cron entry is NOT in this file, same reason as 0003: pg_net puts the shared secret in the
-- SQL body as a literal. Register it once, live, with the same INTERNAL_FUNCTION_SECRET:
--
--   select cron.schedule('alfy-recap', '0 * * * *', $cron$
--     select net.http_post(
--       url     := 'https://<ref>.supabase.co/functions/v1/alfy-recap',
--       headers := '{"Content-Type":"application/json","x-runner-key":"<INTERNAL_FUNCTION_SECRET>"}'::jsonb
--     );
--   $cron$);
-- ─────────────────────────────────────────────────────────────────────────────
