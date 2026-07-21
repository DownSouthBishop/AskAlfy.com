-- Alfy core schema (Layer 1 — the data spine)
-- Same shape at 10 users and 10M. Everything keyed by user_id; RLS on from row one.
--
-- IDENTITY MODEL: the account is `users`; phone numbers are credentials that point at it
-- (`user_phones`, many→one). We match the NUMBER, never the device — SMS is number-addressed,
-- and the carrier/Apple Continuity already fans a login code out to every device on that line.
-- Login = phone OTP: type a number → Twilio texts a code → any linked number resolves to the
-- same account. v1 ships single-number (Supabase built-in phone OTP); the table supports
-- linking additional verified numbers later with no refactor.
--
-- Runtime actors:
--   • Edge functions / agent worker use the SERVICE ROLE key → bypass RLS (they act on
--     behalf of a user already identified by the inbound number).
--   • The dashboard uses the user's session → RLS below scopes them to their own rows.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
create type consent_status   as enum ('pending', 'opted_in', 'opted_out');
create type message_direction as enum ('inbound', 'outbound');
create type approval_status  as enum ('pending', 'approved', 'skipped', 'executed', 'failed');

-- ─────────────────────────────────────────────────────────────────────────────
-- users — the tenant. Phone is the identity; auth link is optional & later.
-- ─────────────────────────────────────────────────────────────────────────────
create table users (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid unique references auth.users on delete set null, -- linked on first OTP login
  display_name      text,
  about             text,                               -- "Tell Alfy about yourself" (Alfy knows tab)
  recovery_email    text,                               -- gentle backup so a lost number ≠ lockout
  timezone          text not null default 'America/New_York',
  quiet_hours_start smallint not null default 21,       -- 24h local; no sends 21:00–07:00 by default
  quiet_hours_end   smallint not null default 7,
  created_at        timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- user_phones — numbers that resolve to an account. Match the NUMBER, never the device.
-- The credential for OTP login AND the inbound-routing key. One primary today; linking
-- additional verified numbers later is a row insert, no schema change.
-- ─────────────────────────────────────────────────────────────────────────────
create table user_phones (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  phone_e164  text not null unique,                     -- +15551234567
  is_primary  boolean not null default true,
  label       text,                                     -- 'iPhone', 'work' — optional, user-set
  consent     consent_status not null default 'pending',-- TCPA consent is per-line
  consent_at  timestamptz,
  verified_at timestamptz,                              -- set when the OTP is confirmed
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- connections — pointer to Composio-held credentials. Composio owns the tokens;
-- we only store the reference + status so the dashboard can show "Google — connected".
-- ─────────────────────────────────────────────────────────────────────────────
create table connections (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users on delete cascade,
  provider              text not null,                  -- 'gmail' | 'googlecalendar' | ...
  composio_connection_id text,                          -- Composio connected-account id
  status                text not null default 'active', -- 'active' | 'revoked' | 'error'
  connected_at          timestamptz not null default now(),
  unique (user_id, provider)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- messages — full SMS log. twilio_sid is the idempotency key (Twilio retries webhooks).
-- ─────────────────────────────────────────────────────────────────────────────
create table messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  from_phone  text,                                     -- the specific line this hit / left from
  direction   message_direction not null,
  body        text not null,
  twilio_sid  text unique,                              -- dedupe inbound; null for internal
  segments    smallint not null default 1,             -- for cost metering
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- approval_queue — THE core. Drives the dashboard's Today (pending) + Handled (decided).
-- action_payload is exactly what the worker replays through Composio on approval.
-- ─────────────────────────────────────────────────────────────────────────────
create table approval_queue (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users on delete cascade,
  kind                  text not null,                  -- 'Email' | 'Calendar' | 'Order' — the card label
  summary               text not null,                  -- "Reply to Dana about Thursday"
  draft_content         text,                           -- the editable draft shown on the card
  action_type           text not null,                  -- 'gmail.send' | 'gcal.create_event' | ...
  action_payload        jsonb not null default '{}',    -- args for the Composio tool call
  status                approval_status not null default 'pending',
  standing_permission_id uuid,                          -- FK added below, after standing_permissions exists
  created_at            timestamptz not null default now(),
  decided_at            timestamptz,
  executed_at           timestamptz,
  undo_until            timestamptz                     -- Handled "undo" window
);

create index approval_queue_user_status_idx on approval_queue (user_id, status, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- standing_permissions — the Trust section. "Sends calendar replies without asking."
-- When set, the worker may execute a matching action_type without queueing.
-- ─────────────────────────────────────────────────────────────────────────────
create table standing_permissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  description text not null,                            -- human line shown in the dashboard
  action_type text not null,                            -- what it auto-approves
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz                              -- null = active
);

-- forward-declared above via FK; add the FK now that both tables exist
alter table approval_queue
  add constraint approval_queue_standing_permission_fk
  foreign key (standing_permission_id) references standing_permissions on delete set null;

-- ─────────────────────────────────────────────────────────────────────────────
-- people — the "Alfy knows" contact memory.
-- ─────────────────────────────────────────────────────────────────────────────
create table people (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users on delete cascade,
  name       text not null,
  note       text,                                      -- "Prefers texts. Owes you $40."
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- access_links — the SMS deep-link tokens. This is the approval channel.
-- Alfy texts a one-time link; opening it mints a dashboard session for that user
-- and deep-links to the pending approval. The token authenticates the HANDOFF only —
-- the actual Approve still needs a deliberate tap in the session ("asks first").
-- Locked to service role: minted and validated by an edge function, never read by anon.
-- ─────────────────────────────────────────────────────────────────────────────
create table access_links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  approval_id uuid references approval_queue on delete cascade, -- deep-link target; null = just open dashboard
  token       text not null unique,                     -- random, unguessable (edge fn generates)
  expires_at  timestamptz not null,                     -- short TTL, e.g. now()+30min
  used_at     timestamptz,                              -- single-use for the auth handoff
  created_at  timestamptz not null default now()
);

create index access_links_token_idx on access_links (token) where used_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security. Service role bypasses all of this; these policies govern the
-- USER'S OWN dashboard session only. Owner = the users row linked to auth.uid().
-- ─────────────────────────────────────────────────────────────────────────────
alter table users                enable row level security;
alter table user_phones          enable row level security;
alter table connections          enable row level security;
alter table messages             enable row level security;
alter table approval_queue       enable row level security;
alter table standing_permissions enable row level security;
alter table people               enable row level security;
alter table access_links         enable row level security; -- no policy → service-role-only by design

-- helper: the caller's own users.id (stable across child-table policies)
create or replace function current_user_id() returns uuid
  language sql stable security definer set search_path = public as
$$ select id from users where auth_user_id = auth.uid() $$;

-- users: read + edit self
create policy users_self_select on users for select using (auth_user_id = auth.uid());
create policy users_self_update on users for update using (auth_user_id = auth.uid());

-- child tables: read own rows
create policy phones_own on user_phones          for select using (user_id = current_user_id());
create policy conn_own   on connections          for select using (user_id = current_user_id());
create policy msg_own    on messages             for select using (user_id = current_user_id());
create policy appr_own   on approval_queue        for select using (user_id = current_user_id());
create policy perm_own   on standing_permissions  for select using (user_id = current_user_id());
create policy people_own on people                for select using (user_id = current_user_id());

-- the actions a user takes in the dashboard:
-- approve / skip a queued item (worker executes after status flip)
create policy appr_decide on approval_queue for update
  using (user_id = current_user_id())
  with check (user_id = current_user_id());
-- revoke a standing permission
create policy perm_revoke on standing_permissions for update
  using (user_id = current_user_id());
-- edit people memory
create policy people_edit   on people for update using (user_id = current_user_id());
create policy people_insert on people for insert with check (user_id = current_user_id());

-- ponytail: no updated_at triggers — the app sets timestamps on write. Add moddatetime
--           triggers only if drift shows up. No soft-delete — cascade is fine at this scale.
