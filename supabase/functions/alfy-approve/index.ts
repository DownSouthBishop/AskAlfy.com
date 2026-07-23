// alfy-approve — executes an approved action. Called after the person taps Approve.
// This is the ONLY place an outbound action actually fires, and only for status='approved'
// on a row the CALLER owns. Reads action_payload the agent stashed, replays it through
// Composio, texts a confirmation.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js';
import { composioExecute } from '../_shared/composio.ts';
import { actionPhrase, canEarnAutonomy, isReadOnly } from '../_shared/actions.ts';
import { requireEnv } from '../_shared/env.ts';
import { CORS, JSON_CORS } from '../_shared/cors.ts';
import { sendSms, SMS_FROM } from '../_shared/sms.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

// ─────────────────────────────────────────────────────────────────────────────
// Earned autonomy. After an action fires, look at whether this exact thing — same tool,
// same target — has been approved enough times with no refusals to be worth asking about.
//
// Alfy asks; it never assumes. The row goes in with granted_at null, which is an open
// question, not a permission. alfy-sms-inbound turns a "yes" into the grant.
//
// Returns text to append to the confirmation, or '' when there's nothing to ask.
// ─────────────────────────────────────────────────────────────────────────────
async function maybeOfferAutonomy(
	// SupabaseClient, not ReturnType<typeof createClient> — the latter resolves the schema
	// to `never` and every .insert() stops compiling.
	supa: SupabaseClient,
	row: { user_id: unknown; action_type: unknown; scope_key: unknown },
): Promise<string> {
	const slug = String(row.action_type ?? '');
	const scope = row.scope_key ? String(row.scope_key) : null;
	if (!scope || !canEarnAutonomy(slug)) return '';

	const { data: ready } = await supa.rpc('autonomy_candidate', {
		p_user_id: row.user_id,
		p_scope_key: scope,
	});
	if (!ready) return '';

	const target = scope.slice(scope.indexOf(':') + 1);
	const description = `${actionPhrase(slug).toLowerCase()} to ${target}`;

	// The partial unique index makes this a no-op if a question is already open or the
	// person has already answered it — so Alfy can't ask twice.
	const { error } = await supa.from('standing_permissions').insert({
		user_id: row.user_id,
		scope_key: scope,
		action_type: slug,
		description: `Can ${description} without asking`,
		offered_at: new Date().toISOString(),
	});
	if (error) return ''; // already asked, or already answered

	return `\n\nThat's the third one of these you've okayed. Want me to just ${description} from now on? Reply YES and I'll stop asking. You can undo it any time.`;
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

	// Identify the caller. Without this, the default JWT gate accepts the anon key —
	// which every browser has — and anyone could fire anyone's approved action.
	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_CORS });

	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_CORS });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa.from('users').select('id').eq('auth_user_id', user.id).single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: JSON_CORS });

	const { approval_id } = await req.json().catch(() => ({ approval_id: null }));
	if (!approval_id) return new Response(JSON.stringify({ error: 'missing approval_id' }), { status: 400, headers: JSON_CORS });

	// Claim the row: flip approved → executing in one conditional update, scoped to the
	// caller. Two taps (or a double-invoke) race here instead of both sending the email —
	// the loser gets zero rows back.
	const { data: claimed } = await supa
		.from('approval_queue')
		.update({ status: 'executing' })
		.eq('id', approval_id)
		.eq('user_id', acct.id)
		.eq('status', 'approved')
		.select('id, user_id, action_type, action_payload, summary, scope_key')
		.maybeSingle();

	if (!claimed) return new Response(JSON.stringify({ error: 'not approvable' }), { status: 409, headers: JSON_CORS });

	// action_type is the Composio tool slug the agent queued. Re-derive the read/write call
	// here rather than trusting the row: the queue is data, and this is the last gate before
	// something actually leaves. A read has no business in the approval queue at all.
	const slug = String(claimed.action_type ?? '');
	if (!slug || isReadOnly(slug)) {
		await supa.from('approval_queue').update({ status: 'failed' }).eq('id', claimed.id);
		return new Response(JSON.stringify({ error: `not an approvable action: ${slug || '(none)'}` }), { status: 400, headers: JSON_CORS });
	}

	try {
		await composioExecute(claimed.user_id as string, slug, claimed.action_payload as Record<string, unknown>);
	} catch (err) {
		await supa.from('approval_queue').update({ status: 'failed' }).eq('id', claimed.id);
		return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: JSON_CORS });
	}

	await supa.from('approval_queue').update({
		status: 'executed',
		executed_at: new Date().toISOString(),
		undo_until: new Date(Date.now() + 10 * 60_000).toISOString(),
	}).eq('id', claimed.id);

	// Confirmation text to the person's primary number.
	const { data: phone } = await supa
		.from('user_phones')
		.select('phone_e164')
		.eq('user_id', claimed.user_id)
		.eq('is_primary', true)
		.maybeSingle();

	if (phone) {
		const body = `Done — ${claimed.summary}. — A${await maybeOfferAutonomy(supa, claimed)}`;
		const segments = await sendSms(phone.phone_e164 as string, body);
		await supa.from('messages').insert({
			user_id: claimed.user_id, from_phone: SMS_FROM, direction: 'outbound', body, segments: segments || 1,
		});
	}

	return new Response(JSON.stringify({ ok: true }), { headers: JSON_CORS });
});
