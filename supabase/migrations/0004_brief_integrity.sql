-- Three defects found reviewing 0003 before it ever ran. All of them are the kind that
-- surface at 7am, unattended, with nobody watching.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. One primary phone per account, enforced.
--
-- user_phones.is_primary was a plain boolean with no constraint, and claim_briefs joins on
-- it. Two primary rows meant Postgres picked one arbitrarily — the brief would go to a
-- nondeterministic number. alfy-approve's confirmation lookup had the same hole.
--
-- The default stays true so first-phone onboarding is unchanged; linking a second phone now
-- has to say is_primary = false explicitly, and fails loudly instead of quietly corrupting
-- which number is authoritative.
-- ─────────────────────────────────────────────────────────────────────────────
create unique index if not exists user_phones_one_primary_idx
  on user_phones (user_id) where is_primary;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. A bad timezone can no longer exist.
--
-- `at time zone` raises on an invalid string, and users.timezone was unconstrained. Because
-- claim_briefs evaluates it for every candidate row, ONE bad value didn't cost one person
-- their brief — it aborted the whole function, so nobody got one, silently, every hour.
--
-- Validating on write means the read path can't be poisoned. This can't be a CHECK
-- constraint: pg_timezone_names is a view and the lookup isn't immutable.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function assert_valid_timezone()
returns trigger
language plpgsql
as $$
begin
  if new.timezone is null
     or not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'invalid IANA timezone: %', coalesce(new.timezone, '(null)')
      using hint = 'Use a name from pg_timezone_names, e.g. America/New_York';
  end if;
  return new;
end;
$$;

drop trigger if exists users_timezone_valid on users;
create trigger users_timezone_valid
  before insert or update of timezone on users
  for each row execute function assert_valid_timezone();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. claim_briefs: stop the OUT parameters shadowing column names.
--
-- The previous signature returned (user_id, phone_e164, timezone). In a `language sql`
-- function those names are in scope in the body, where the same identifiers are also
-- columns of users and user_phones. Qualified references most likely resolved to the
-- columns — but "most likely" is not a property you want in the one statement that decides
-- who gets texted. Renamed so the two can't collide at all.
--
-- Behaviour is otherwise identical: claim-before-run (a crash costs one brief instead of
-- re-running every tick forever), FOR UPDATE SKIP LOCKED so overlapping ticks never
-- double-send, and LIMIT bounding one invocation rather than the system.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists claim_briefs(int);

create or replace function claim_briefs(p_limit int default 20)
returns table (brief_user_id uuid, brief_phone text, brief_timezone text)
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
     and p.user_id = u.id
     and p.is_primary
  returning u.id, p.phone_e164, u.timezone;
$$;
