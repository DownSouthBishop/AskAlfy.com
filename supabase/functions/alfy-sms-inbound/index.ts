// alfy-sms-inbound — Twilio Messaging webhook. The front door.
// Verify, dedupe, route, run the agent, text back. At scale, swap the inline runAgent for
// an enqueue + worker (see docs/alfy-handoff.md) — the seam is right here.
//
// Deploy with --no-verify-jwt: the caller is Twilio, authenticated by its signature, not a
// Supabase session.

import { createClient } from 'npm:@supabase/supabase-js';
import { runAgent, type Supa } from '../_shared/agent.ts';
import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { mintLink } from '../_shared/links.ts';
import { sendSms, TWILIO_FROM, validateTwilioSignature } from '../_shared/twilio.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const APP_URL = optionalEnv('PUBLIC_APP_URL', 'https://askalfy.com');

const PG_UNIQUE_VIOLATION = '23505';

// Answering Alfy's "want me to stop asking about these?" question. Kept narrow and literal
// on purpose — this grants a standing permission to act without approval, so it should take
// a clear yes and nothing looser.
const AFFIRMATIVE = new Set(['YES', 'Y', 'YEP', 'YEAH', 'OK', 'OKAY', 'SURE', 'DO IT', 'PLEASE DO']);
const NEGATIVE = new Set(['NO', 'N', 'NOPE', 'NAH', "DON'T", 'DONT', 'NO THANKS']);
const OFFER_WINDOW_MS = 24 * 60 * 60 * 1000;

// Every account carries a synthetic auth email derived from its number, so the phone-first
// user can still mint email-style magic links (see alfy-link). Never actually emailed.
function syntheticEmail(phoneE164: string) {
	return `${phoneE164.replace(/\D/g, '')}@sms.askalfy.com`;
}

// Send + log together so messages.segments stays a real cost number.
async function reply(supa: Supa, userId: string, to: string, body: string) {
	const segments = await sendSms(to, body);
	await supa.from('messages').insert({
		user_id: userId,
		from_phone: TWILIO_FROM,
		direction: 'outbound',
		body,
		segments: segments || 1,
	});
}

Deno.serve(async (req) => {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const form = await req.formData();
	const params: Record<string, string> = {};
	for (const [key, value] of form.entries()) params[key] = String(value);

	// Nothing above this line is trusted. Anyone who knows a number could otherwise drive
	// the agent on that person's account.
	if (!(await validateTwilioSignature(req, params))) {
		return new Response('invalid signature', { status: 403 });
	}

	const from = params['From'] ?? '';
	const body = (params['Body'] ?? '').trim();
	const sid = params['MessageSid'] ?? '';

	// Carrier-mandated keywords — handle before anything else.
	const kw = body.toUpperCase();
	if (kw === 'STOP' || kw === 'UNSUBSCRIBE') {
		await supa.from('user_phones').update({ consent: 'opted_out' }).eq('phone_e164', from);
		return new Response(null, { status: 204 });
	}
	if (kw === 'HELP') {
		await sendSms(from, 'Alfy here. Text anything you want handled. Reply STOP to opt out. — A');
		return new Response(null, { status: 204 });
	}
	// START/UNSTOP re-subscribes an opted-out line. Carrier-mandated alongside STOP, and
	// without it the consent gate below would silently swallow every attempt to come back.
	if (kw === 'START' || kw === 'UNSTOP') {
		const { data: resumed } = await supa
			.from('user_phones')
			.update({ consent: 'opted_in', consent_at: new Date().toISOString() })
			.eq('phone_e164', from)
			.eq('consent', 'opted_out')
			.select('id');
		if (resumed?.length) {
			await sendSms(from, "You're back. Text me anything you want handled. — A");
			return new Response(null, { status: 204 });
		}
		// No opted-out row — fall through so an unknown number still gets onboarded below.
	}

	// Map number → account. Match the NUMBER, never the device.
	const { data: phone } = await supa
		.from('user_phones')
		.select('user_id, consent')
		.eq('phone_e164', from)
		.maybeSingle();

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
				if (u) {
					await supa.from('user_phones').insert({
						user_id: u.id, phone_e164: from, is_primary: true,
						consent: 'opted_in', consent_at: now, verified_at: now,
					});
				}
			}
			await sendSms(from, "You're set up. Text me anything you want handled — I'll draft it and ask before anything sends. — A");
			return new Response(null, { status: 204 });
		}
		await sendSms(from, "Hi, I'm Alfy. Want me to set you up? Reply YES and I'll get you started. — A");
		return new Response(null, { status: 204 });
	}

	// They said STOP. Staying silent is the whole point — do not reply, do not run anything.
	if (phone.consent === 'opted_out') return new Response(null, { status: 204 });

	// Answering Alfy's autonomy question. Handled here, deterministically, BEFORE the agent
	// sees the message: granting a standing permission to send without asking is not a
	// decision to route through a model's reading of the word "yes".
	const answer = AFFIRMATIVE.has(kw) ? 'grant' : NEGATIVE.has(kw) ? 'decline' : null;
	if (answer) {
		const { data: offer } = await supa
			.from('standing_permissions')
			.select('id, description')
			.eq('user_id', phone.user_id)
			.is('granted_at', null)
			.is('declined_at', null)
			.is('revoked_at', null)
			.gte('offered_at', new Date(Date.now() - OFFER_WINDOW_MS).toISOString())
			.order('offered_at', { ascending: false })
			.limit(1)
			.maybeSingle();

		if (offer) {
			const now = new Date().toISOString();
			await supa.from('standing_permissions')
				.update(answer === 'grant' ? { granted_at: now } : { declined_at: now })
				.eq('id', offer.id);

			await reply(supa, phone.user_id as string, from, answer === 'grant'
				? `Done. I'll handle those from now on without asking. You can turn it off any time in Alfy knows. — A`
				: `Understood — I'll keep asking. — A`);
			return new Response(null, { status: 200 });
		}
		// No open question: fall through and let the agent read it as an ordinary message.
	}

	// Dedupe on the twilio_sid unique index. Only a uniqueness collision means "already
	// processed" — any other insert failure is a real error and must not silently drop
	// the person's message.
	const { error: logErr } = await supa.from('messages').insert({
		user_id: phone.user_id, from_phone: from, direction: 'inbound', body, twilio_sid: sid,
	});
	if (logErr) {
		if (logErr.code === PG_UNIQUE_VIOLATION) return new Response(null, { status: 200 });
		console.error('inbound log failed', logErr);
		return new Response('log failed', { status: 500 });
	}

	// The message row is already committed, so a Twilio retry would dedupe to a no-op and
	// the person would hear nothing at all. Answer here instead of throwing.
	let turn;
	try {
		turn = await runAgent(phone.user_id as string, body);
	} catch (err) {
		console.error('agent failed', err);
		await reply(supa, phone.user_id as string, from, "Something went wrong on my end. Try me again in a minute. — A");
		return new Response(null, { status: 200 });
	}

	// Deep-link the approval at what THIS turn queued, not whatever happens to be pending.
	let text = turn.reply;
	if (turn.queuedId) {
		const token = await mintLink(supa, phone.user_id as string, turn.queuedId, 30 * 60_000);
		text += `\nApprove: ${APP_URL}/a?t=${token}`;
	}

	await reply(supa, phone.user_id as string, from, text);
	return new Response(null, { status: 200 });
});
