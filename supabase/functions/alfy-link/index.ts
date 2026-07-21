// alfy-link — validates the one-time SMS token and hands the browser a session token-hash.
// The /a page (AuthHandoff) POSTs { token } here, then exchanges the returned token_hash for
// a real session via verifyOtp. The token authenticates the HANDOFF only; approving still
// needs a deliberate tap ("Alfy asks first").
//
// Session mint uses the documented Supabase pattern: admin.generateLink({type:'magiclink'})
// returns a hashed_token → the browser calls verifyOtp({ token_hash, type:'email' }).
// Every Alfy auth user carries a synthetic email derived from their primary number, so a
// phone-first account can still mint an email-style magic link. See onboarding in alfy-sms-inbound.

import { createClient } from 'npm:@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// digits of the E.164 number → the account's synthetic auth email (never emailed).
export function syntheticEmail(phoneE164: string) {
	return `${phoneE164.replace(/\D/g, '')}@sms.askalfy.com`;
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

	const { token } = await req.json().catch(() => ({ token: null }));
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

	const { data: link } = await supa
		.from('access_links')
		.select('id, user_id, approval_id, expires_at, used_at')
		.eq('token', token)
		.maybeSingle();

	if (!link || link.used_at || new Date(link.expires_at).getTime() < Date.now()) {
		return new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
	}
	await supa.from('access_links').update({ used_at: new Date().toISOString() }).eq('id', link.id);

	// Primary number → synthetic email → magic-link token_hash.
	const { data: phone } = await supa.from('user_phones').select('phone_e164').eq('user_id', link.user_id).eq('is_primary', true).single();
	if (!phone) return new Response(JSON.stringify({ error: 'no phone' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });

	const { data, error } = await supa.auth.admin.generateLink({ type: 'magiclink', email: syntheticEmail(phone.phone_e164) });
	if (error || !data?.properties?.hashed_token) {
		return new Response(JSON.stringify({ error: 'mint failed' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
	}

	return new Response(
		JSON.stringify({ token_hash: data.properties.hashed_token, item: link.approval_id }),
		{ headers: { 'Content-Type': 'application/json', ...CORS } }
	);
});
