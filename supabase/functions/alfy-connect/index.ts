// alfy-connect — starts a Composio connection for Gmail/Calendar and returns the redirect URL.
// Uses a CUSTOM auth config (Alfy owns the OAuth app → tokens belong to Alfy, not Composio-managed).
// Called from Settings → Connections with the user's JWT.
//
// VERIFY before prod: the /v3/connected_accounts/link body shape + the per-provider
// auth_config_id (created once in the Composio dashboard, supplied via secrets).

import { createClient } from 'npm:@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const COMPOSIO_API_KEY = Deno.env.get('COMPOSIO_API_KEY')!;
const COMPOSIO_BASE = 'https://backend.composio.dev';
const APP_URL = Deno.env.get('PUBLIC_APP_URL') ?? 'https://askalfy.com';

// provider → the Composio auth_config_id you create once in their dashboard.
const AUTH_CONFIG: Record<string, string | undefined> = {
	gmail: Deno.env.get('COMPOSIO_AUTHCFG_GMAIL'),
	googlecalendar: Deno.env.get('COMPOSIO_AUTHCFG_CALENDAR'),
};

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });

	// Identify the user from their session.
	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa.from('users').select('id').eq('auth_user_id', user.id).single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: CORS });

	const { provider } = await req.json();
	const authConfigId = AUTH_CONFIG[provider];
	if (!authConfigId) return new Response(JSON.stringify({ error: `no auth config for ${provider}` }), { status: 400, headers: CORS });

	// Current (non-deprecated) endpoint for Composio-managed OAuth connect links.
	const res = await fetch(`${COMPOSIO_BASE}/api/v3/connected_accounts/link`, {
		method: 'POST',
		headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			user_id: acct.id,
			auth_config_id: authConfigId,
			callback_url: `${APP_URL}/app?connected=${provider}`,
		}),
	});
	const data = await res.json();

	// Record intent; status flips to active on callback.
	await supa.from('connections').upsert(
		{ user_id: acct.id, provider, composio_connection_id: data.id ?? null, status: 'pending' },
		{ onConflict: 'user_id,provider' }
	);

	return new Response(JSON.stringify({ redirect_url: data.redirect_url ?? data.redirectUrl }), {
		headers: { 'Content-Type': 'application/json', ...CORS },
	});
});
