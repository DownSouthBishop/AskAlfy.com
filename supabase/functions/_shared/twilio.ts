// Twilio signature validation + send. The signature check is the ONLY thing standing
// between the agent and anyone who knows a user's phone number — do not make it optional.

import { requireEnv } from './env.ts';

const TWILIO_SID = requireEnv('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = requireEnv('TWILIO_AUTH_TOKEN');
export const TWILIO_FROM = requireEnv('TWILIO_PHONE_NUMBER');

// Timing-safe compare — both values are fixed-length base64 digests.
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// Twilio: signature = base64(HMAC-SHA1(url + sorted-concatenated POST params, auth token)).
// Supabase terminates TLS, so req.url can arrive as http:// — rebuild the https:// URL that
// Twilio actually signed. This must match the webhook URL configured in the Twilio console
// byte for byte (a trailing slash difference will fail the check).
export async function validateTwilioSignature(req: Request, params: Record<string, string>): Promise<boolean> {
	const signature = req.headers.get('x-twilio-signature');
	if (!signature) return false;

	const url = new URL(req.url);
	const signedUrl = `https://${url.host}${url.pathname}${url.search}`;
	const payload = signedUrl + Object.keys(params).sort().map((k) => k + params[k]).join('');

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TWILIO_TOKEN),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
	return safeEqual(expected, signature);
}

// Returns the number of segments Twilio billed, or 0 on failure — callers log it to
// messages.segments for cost metering.
export async function sendSms(to: string, body: string): Promise<number> {
	const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
		method: 'POST',
		headers: {
			Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
	});
	if (!res.ok) return 0;
	const sent = await res.json().catch(() => null);
	return Number(sent?.num_segments ?? 1) || 1;
}
