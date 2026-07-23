-- Plan limits (Layer 7 — enforce the pricing decision)
--
-- Features are FLAT across tiers (brief, recap, autonomy — everyone gets them). Tiers differ
-- on exactly two things: how many texts you can send per day, and how many apps you can
-- connect. Both live on `users` as plain numbers — three tiers don't warrant a plans table.
-- A billing hook (Stripe webhook, not yet wired) sets these three columns when a plan changes;
-- until then every account sits on the $20 Alfy defaults.
--
-- Defaults = the $20 "Alfy" tier: 10 texts/day (guarantees 44% margin even if maxed daily,
-- Haiku-only), 3 connected apps. See scripts/unit-economics.mjs for the derivation.

alter table users
  add column plan            text     not null default 'alfy',   -- 'alfy' | 'plus' | 'pro'
  add column daily_text_cap  smallint not null default 10,        -- user-initiated texts/day
  add column app_limit       smallint not null default 3;         -- connectable apps

-- The daily cap counts INBOUND user texts only. Proactive sends (brief, recap) are outbound
-- and never count — the decision is that features are free; only the texts a user sends meter.
-- Partial index so the per-inbound count stays cheap at any scale.
create index messages_user_inbound_idx
  on messages (user_id, created_at)
  where direction = 'inbound';

-- Used-vs-cap in one call, resetting at the user's LOCAL midnight (same timezone the brief
-- uses). `used` includes the message just logged, so the edge function checks used > cap.
create or replace function daily_usage(p_user uuid)
  returns table (used int, cap int)
  language sql stable as
$$
  select
    (
      select count(*)::int
      from messages m
      where m.user_id = p_user
        and m.direction = 'inbound'
        and m.created_at >= date_trunc('day', now() at time zone u.timezone) at time zone u.timezone
    ),
    u.daily_text_cap::int
  from users u
  where u.id = p_user
$$;
