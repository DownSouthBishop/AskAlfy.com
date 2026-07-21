// alfy-connect — starts a Composio connection for Gmail/Calendar and returns the redirect URL.
// Called from Settings → Connections with the user's JWT.
//
// The auth-config ids come from secrets, so managed vs. custom auth is a secrets change,
// not a code change: point COMPOSIO_AUTHCFG_* at whichever config you created in the
// Composio dashboard. (Custom = Alfy owns the OAuth app and the Google verification
// burden that comes with restricted Gmail scopes; managed = Composio owns both.)

import { createClient } from 'npm:@supabase/supabase-js';
import { composioConnectLink } from '../_shared/composio.ts';
import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { CORS, JSON_CORS } from '../_shared/cors.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const APP_URL = optionalEnv('PUBLIC_APP_URL', 'https://askalfy.com');

// provider → the Composio auth_config_id you create once in their dashboard.
const AUTH_CONFIG: Record<string, string | undefined> = {
	gmail: Deno.env.get('COMPOSIO_AUTHCFG_GMAIL'),
	googlecalendar: Deno.env.get('COMPOSIO_AUTHCFG_CALENDAR'),
};

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_CORS });

	// Identify the user from their session.
	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_CORS });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa.from('users').select('id').eq('auth_user_id', user.id).single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: JSON_CORS });

	const { provider } = await req.json().catch(() => ({ provider: null }));
	const authConfigId = AUTH_CONFIG[provider];
	if (!authConfigId) {
		return new Response(
			JSON.stringify({ error: `no auth config for ${provider} — set COMPOSIO_AUTHCFG_* in secrets` }),
			{ status: 400, headers: JSON_CORS },
		);
	}

	try {
		const link = await composioConnectLink(
			acct.id as string,
			authConfigId,
			`${APP_URL}/app?connected=${provider}`,
		);

		// Record intent; status flips to active on callback.
		await supa.from('connections').upsert(
			{ user_id: acct.id, provider, composio_connection_id: link.id, status: 'pending' },
			{ onConflict: 'user_id,provider' },
		);

		return new Response(JSON.stringify({ redirect_url: link.redirectUrl }), { headers: JSON_CORS });
	} catch (err) {
		return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_CORS });
	}
});
