// alfy-approve — executes an approved action. Called after the person taps Approve.
// This is the ONLY place an outbound action actually fires, and only for status='approved'.
// Reads action_payload the agent stashed, replays it through Composio, texts a confirmation.
//
// VERIFY before prod: Composio execute slugs/shape, Twilio send creds, and how this is
// triggered (dashboard fetch with the user's JWT, or a DB webhook on status change).

import { createClient } from 'npm:@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const COMPOSIO_API_KEY = Deno.env.get('COMPOSIO_API_KEY')!;
const COMPOSIO_BASE = 'https://backend.composio.dev';
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER')!;

// action_type → Composio tool slug. VERIFY slugs against the live toolkit list.
const SLUG: Record<string, string> = {
	'gmail.send': 'GMAIL_SEND_EMAIL',
	'gcal.create_event': 'GOOGLECALENDAR_CREATE_EVENT',
};

async function composio(userId: string, toolSlug: string, args: Record<string, unknown>) {
	const res = await fetch(`${COMPOSIO_BASE}/api/v3/tools/execute/${toolSlug}`, {
		method: 'POST',
		headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: userId, arguments: args }),
	});
	return await res.json();
}

async function sendSms(supa: ReturnType<typeof createClient>, userId: string, to: string, body: string) {
	await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
		method: 'POST',
		headers: { Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
	});
	await supa.from('messages').insert({ user_id: userId, from_phone: TWILIO_FROM, direction: 'outbound', body });
}

Deno.serve(async (req) => {
	const { approval_id } = await req.json();
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

	const { data: row } = await supa
		.from('approval_queue')
		.select('id, user_id, action_type, action_payload, status, summary')
		.eq('id', approval_id)
		.single();

	if (!row || row.status !== 'approved') return new Response(JSON.stringify({ error: 'not approvable' }), { status: 409 });

	const slug = SLUG[row.action_type];
	if (!slug) return new Response(JSON.stringify({ error: `no tool for ${row.action_type}` }), { status: 400 });

	// The person's phone for the confirmation text.
	const { data: phone } = await supa.from('user_phones').select('phone_e164').eq('user_id', row.user_id).eq('is_primary', true).single();

	try {
		await composio(row.user_id, slug, row.action_payload as Record<string, unknown>);
		await supa.from('approval_queue').update({
			status: 'executed',
			executed_at: new Date().toISOString(),
			undo_until: new Date(Date.now() + 10 * 60_000).toISOString(),
		}).eq('id', row.id);
		if (phone) await sendSms(supa, row.user_id, phone.phone_e164, `Done — ${row.summary}. — A`);
		return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
	} catch (err) {
		await supa.from('approval_queue').update({ status: 'failed' }).eq('id', row.id);
		return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
	}
});
