-- Approval hardening.
--
-- 0001 gave the dashboard an unrestricted UPDATE on approval_queue, scoped by row but not
-- by column. That let a session rewrite action_payload — the recipient of the email, the
-- attendees on the invite — and *then* approve it. The person would be approving the
-- summary they were shown while a different action fired. RLS has no column granularity,
-- so the fix is column-level GRANTs; the RLS policies below still do the row scoping.

-- 'executing' is the claim state alfy-approve flips a row into before calling Composio,
-- so two concurrent Approve taps can't both send. Added as its own statement: a new enum
-- value cannot be referenced in the same transaction that creates it.
alter type approval_status add value if not exists 'executing';

-- ─────────────────────────────────────────────────────────────────────────────
-- approval_queue: a user may only decide (approve / skip). Everything the agent
-- wrote — kind, summary, draft_content, action_type, action_payload — is immutable
-- from the browser.
-- ─────────────────────────────────────────────────────────────────────────────
revoke update on approval_queue from authenticated;
grant update (status, decided_at) on approval_queue to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- standing_permissions: a user may revoke, not redefine what a permission covers.
-- ─────────────────────────────────────────────────────────────────────────────
revoke update on standing_permissions from authenticated;
grant update (revoked_at) on standing_permissions to authenticated;

-- ponytail: `people` keeps its full update grant — it is the person's own memory of their
--           own contacts, and there is no privileged column on it to protect.
