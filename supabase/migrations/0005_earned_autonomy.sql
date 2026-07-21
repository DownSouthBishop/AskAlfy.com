-- Earned autonomy.
--
-- The approval queue is the product, but a constant tax on every action is how an assistant
-- stops being worth it. If you've said yes to the last four replies to Dana, Alfy asking a
-- fifth time isn't caution, it's friction.
--
-- So Alfy watches, and when a pattern is clear it ASKS — once — whether to stop asking.
-- "Alfy asks first" is intact; it just asks about the pattern instead of the instance. And
-- it only ever asks. A permission is never inferred, never defaulted, never granted by
-- silence.
--
-- standing_permissions has been in the schema since 0001 with nothing able to create a row.
-- This is that path.

-- A permission now has a life: offered → granted → (revoked). granted_at must therefore be
-- nullable; an un-granted row is an open question, not a permission.
alter table standing_permissions
  alter column granted_at drop not null,
  alter column granted_at drop default;

alter table standing_permissions
  add column if not exists scope_key  text,        -- 'GMAIL_SEND_EMAIL:dana@northbridge.com'
  add column if not exists offered_at timestamptz, -- when Alfy asked
  add column if not exists declined_at timestamptz;-- said no; don't ask about this again

-- One live question or permission per scope. Stops Alfy asking twice about the same thing,
-- and stops two grants racing.
create unique index if not exists standing_permissions_scope_idx
  on standing_permissions (user_id, scope_key)
  where scope_key is not null and revoked_at is null and declined_at is null;

-- The agent checks this on every write, so it wants to be a lookup, not a scan.
create index if not exists standing_permissions_active_idx
  on standing_permissions (user_id, scope_key)
  where granted_at is not null and revoked_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Has this person shown they trust this exact action? Approvals with no skips.
--
-- Counted from approval_queue rather than kept as a tally, so it can't drift and there's
-- nothing to backfill. 'skipped' is the signal that matters most: one no means the pattern
-- isn't a pattern, and Alfy should keep asking.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function autonomy_candidate(p_user_id uuid, p_scope_key text, p_min int default 3)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where status in ('approved', 'executing', 'executed')) >= p_min
    and count(*) filter (where status = 'skipped') = 0
  from approval_queue
  where user_id = p_user_id
    and scope_key = p_scope_key;
$$;

-- Denormalised onto the queue row so the count above is a plain indexed read, and so a
-- card can always be traced back to the permission it would graduate into.
alter table approval_queue add column if not exists scope_key text;
create index if not exists approval_queue_scope_idx on approval_queue (user_id, scope_key);

-- Users may answer Alfy's question from the dashboard as well as by text, and may revoke.
-- They may not write scope_key, action_type, or description — those describe what the
-- permission COVERS, and are Alfy's to set.
revoke update on standing_permissions from authenticated;
grant update (granted_at, revoked_at, declined_at) on standing_permissions to authenticated;
