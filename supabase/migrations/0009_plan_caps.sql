-- A daily ceiling on paid plans. 0006_billing.sql caps the trial (75 total, 20/day) but
-- leaves 'active' and 'plus' uncapped, so one heavy texter can outrun a $25 subscription.
-- Features stay flat across plans — every plan gets every tool. The only thing a plan buys
-- is room, which is also why there's nothing to explain on the pricing page.
--
-- The cap per plan lives in _shared/metering.ts, not here: it's a number we'll re-derive as
-- inference costs move, and a code constant beats a migration every time it changes. This
-- column is a per-account override for the cases the constant gets wrong — comp a heavy
-- user, throttle an abusive one — and is NULL for everyone by default.
alter table users
  add column if not exists daily_text_cap smallint;

-- The count below runs on every inbound text on a paid plan. Partial index so it stays a
-- small index scan rather than growing with the outbound half of the table.
create index if not exists messages_user_inbound_idx
  on messages (user_id, created_at)
  where direction = 'inbound';

-- Today's inbound count, where "today" is the person's own local day — the same timezone
-- the morning brief uses, so the cap resets when their day does, not at UTC midnight.
-- Counts the message currently being handled (it's inserted before the check), so the
-- caller compares used > cap rather than >=.
create or replace function daily_inbound_count(p_user uuid)
  returns int
  language sql
  stable
  security definer
  set search_path = public
as $$
  select count(*)::int
  from messages m
  join users u on u.id = m.user_id
  where m.user_id = p_user
    and m.direction = 'inbound'
    and m.created_at >= date_trunc('day', now() at time zone u.timezone) at time zone u.timezone
$$;
