// alfy-sms-inbound — Twilio Messaging webhook. The front door.
// Fast + queue-shaped: verify, dedupe, route, run the agent, text back. At scale, swap the
// inline runAgent for an enqueue + worker (see docs/alfy-handoff.md) — the seam is right here.
//
// VERIFY before prod: Twilio signature check, Twilio send creds, and cross-function import of
// runAgent (Supabase bundles per folder — likely move runAgent to functions/_shared/).

import { createClient } from 'npm:@supabase/supabase-js';
import { runAgent } from '../alfy-agent/index.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER')!;
const APP_URL = Deno.env.get('PUBLIC_APP_URL') ?? 'https://askalfy.com';

function randomToken() {
	return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

// Every account carries a synthetic auth email derived from its number, so the phone-first
// user can still mint email-style magic links (see alfy-link). Never actually emailed.
function syntheticEmail(phoneE164: string) {
	return `${phoneE164.replace(/\D/g, '')}@sms.askalfy.com`;
}

async function sendSms(to: string, body: string) {
	// VERIFY: Twilio Messages API. Basic auth = SID:AuthToken.
	await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
		method: 'POST',
		headers: {
			Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
	});
}

Deno.serve(async (req) => {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const form = await req.formData();
	const from = String(form.get('From') ?? '');
	const body = String(form.get('Body') ?? '').trim();
	const sid = String(form.get('MessageSid') ?? '');

	// TODO(VERIFY): validate X-Twilio-Signature (HMAC-SHA1 over full URL + sorted params)
	// before trusting anything above. Reject if it fails.

	// Carrier-mandated keywords — handle before anything else.
	const kw = body.toUpperCase();
	if (kw === 'STOP' || kw === 'UNSUBSCRIBE') {
		await supa.from('user_phones').update({ consent: 'opted_out' }).eq('phone_e164', from);
		return new Response(null, { status: 204 });
	}
	if (kw === 'HELP') { await sendSms(from, 'Alfy here. Text anything you want handled. Reply STOP to opt out. — A'); return new Response(null, { status: 204 }); }

	// Map number → account. Match the NUMBER, never the device.
	const { data: phone } = await supa.from('user_phones').select('user_id, consent').eq('phone_e164', from).maybeSingle();

	if (!phone) {
		// Unknown number. "YES/START" = consent → create the account; else prompt.
		if (['YES', 'START', 'Y'].includes(kw)) {
			const now = new Date().toISOString();
			const { data: created } = await supa.auth.admin.createUser({
				phone: from,
				email: syntheticEmail(from),
				phone_confirm: true,
				email_confirm: true,
			});
			if (created?.user) {
				const { data: u } = await supa.from('users').insert({ auth_user_id: created.user.id }).select('id').single();
				if (u) await supa.from('user_phones').insert({ user_id: u.id, phone_e164: from, is_primary: true, consent: 'opted_in', consent_at: now, verified_at: now });
			}
			await sendSms(from, "You're set up. Text me anything you want handled — I'll draft it and ask before anything sends. — A");
			return new Response(null, { status: 204 });
		}
		await sendSms(from, "Hi, I'm Alfy. Want me to set you up? Reply YES and I'll get you started. — A");
		return new Response(null, { status: 204 });
	}

	// Dedupe: unique twilio_sid means a retry just no-ops here.
	const { error: dupe } = await supa.from('messages').insert({ user_id: phone.user_id, from_phone: from, direction: 'inbound', body, twilio_sid: sid });
	if (dupe) return new Response(null, { status: 200 }); // already processed

	// Run the agent (inline now; enqueue at scale).
	const reply = await runAgent(phone.user_id, body);

	// If the turn queued anything, mint a one-time approval link and append it.
	const { data: pending } = await supa
		.from('approval_queue').select('id').eq('user_id', phone.user_id).eq('status', 'pending')
		.order('created_at', { ascending: false }).limit(1);

	let text = reply;
	if (pending && pending.length > 0) {
		const token = randomToken();
		await supa.from('access_links').insert({
			user_id: phone.user_id, approval_id: pending[0].id, token,
			expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
		});
		text += `\nApprove: ${APP_URL}/a?t=${token}`;
	}

	await supa.from('messages').insert({ user_id: phone.user_id, from_phone: TWILIO_FROM, direction: 'outbound', body: text });
	await sendSms(from, text);
	return new Response(null, { status: 200 });
});
