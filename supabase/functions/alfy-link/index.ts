// alfy-link — validates the one-time SMS token and hands the browser a session token-hash.
// The /a page (AuthHandoff) POSTs { token } here, then exchanges the returned token_hash for
// a real session via verifyOtp. The token authenticates the HANDOFF only; approving still
// needs a deliberate tap ("Alfy asks first").
//
// Session mint uses the documented Supabase pattern: admin.generateLink({type:'magiclink'})
// returns a hashed_token → the browser calls verifyOtp({ token_hash, type:'email' }).
// Every Alfy auth user carries a synthetic email derived from their primary number, so a
// phone-first account can still mint an email-style magic link.
//
// Deploy with --no-verify-jwt: the caller has no session yet — that's what it's here to get.

import { createClient } from 'npm:@supabase/supabase-js';
import { requireEnv } from '../_shared/env.ts';
import { CORS, JSON_CORS } from '../_shared/cors.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

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

	if (!link || link.used_at || new Date(link.expires_at as string).getTime() < Date.now()) {
		return new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: JSON_CORS });
	}

	const { data: phone } = await supa
		.from('user_phones')
		.select('phone_e164')
		.eq('user_id', link.user_id)
		.eq('is_primary', true)
		.maybeSingle();

	if (!phone) return new Response(JSON.stringify({ error: 'no phone' }), { status: 404, headers: JSON_CORS });

	// Mint BEFORE burning the token. Burning first meant a failed mint left the person
	// holding a dead link and no way to retry.
	const { data, error } = await supa.auth.admin.generateLink({
		type: 'magiclink',
		email: syntheticEmail(phone.phone_e164 as string),
	});
	if (error || !data?.properties?.hashed_token) {
		return new Response(JSON.stringify({ error: 'mint failed' }), { status: 500, headers: JSON_CORS });
	}

	// Single-use: only consume the token once a session is actually on its way back.
	await supa.from('access_links').update({ used_at: new Date().toISOString() }).eq('id', link.id);

	return new Response(
		JSON.stringify({ token_hash: data.properties.hashed_token, item: link.approval_id }),
		{ headers: JSON_CORS },
	);
});
