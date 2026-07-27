// alfy-send-sms-hook — Supabase Auth's "Send SMS" Auth Hook. Supabase Auth has built-in SMS
// provider support for Twilio/MessageBird/Vonage/TextLocal, but not Telnyx, so phone-OTP login
// (src/components/LoginForm.tsx's signInWithOtp/verifyOtp) needs this custom hook instead —
// register it under Auth -> Hooks -> Send SMS in the Supabase dashboard, pointed at this
// function's URL, with SEND_SMS_HOOK_SECRET set to the secret the dashboard gives you.
//
// Auth Hooks follow the Standard Webhooks spec, not a Supabase JWT — deployed with
// verify_jwt: false, same pattern as alfy-sms-inbound authenticating Telnyx instead.

import { Webhook } from 'npm:standardwebhooks@1';
import { sendSms } from '../_shared/telnyx.ts';

const HOOK_SECRET = Deno.env.get('SEND_SMS_HOOK_SECRET')!.replace('v1,whsec_', '');

Deno.serve(async (req) => {
	const payload = await req.text();
	const headers = Object.fromEntries(req.headers);
	const wh = new Webhook(HOOK_SECRET);

	try {
		const { user, sms } = wh.verify(payload, headers) as { user: { phone: string }; sms: { otp: string } };
		// Supabase's own docs disagree on whether user.phone carries a leading '+' — handle both.
		const to = user.phone.startsWith('+') ? user.phone : `+${user.phone}`;
		const ok = await sendSms(to, `Your Alfy code is ${sms.otp}`);
		if (!ok) throw new Error('Telnyx send failed');
		return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
	} catch (error) {
		return new Response(JSON.stringify({ error: { http_code: 500, message: `Failed: ${error}` } }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
});
