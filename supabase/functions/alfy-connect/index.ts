// alfy-connect — exchanges a Google OAuth authorization code for tokens and marks the
// connection active. The consent-screen redirect is built client-side
// (src/lib/queue.ts's connectProvider, since GOOGLE_CLIENT_ID is public) — this
// function only ever sees the `code` Google hands back on the callback page.
// Replaces the previous Composio connected_accounts/link flow for Gmail/Calendar.

import { createClient } from 'npm:@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

// provider (as stored in `connections`) → platform string (as stored in `oauth_tokens`).
const PLATFORM: Record<string, string> = {
	gmail: 'gmail',
	googlecalendar: 'calendar',
};

Deno.serve(async (req) => {
	const cors = corsHeaders(req);
	if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

	// Identify the user from their session.
	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa.from('users').select('id').eq('auth_user_id', user.id).single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: cors });

	const { provider, code, redirect_uri } = await req.json();
	const platform = PLATFORM[provider];
	if (!platform) return new Response(JSON.stringify({ error: `unknown provider ${provider}` }), { status: 400, headers: cors });
	if (!code || !redirect_uri) return new Response(JSON.stringify({ error: 'missing code or redirect_uri' }), { status: 400, headers: cors });

	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
			redirect_uri,
			grant_type: 'authorization_code',
		}),
	});
	const tokens = await tokenRes.json();
	if (!tokens.access_token) {
		return new Response(JSON.stringify({ error: 'token exchange failed', details: tokens }), { status: 400, headers: cors });
	}

	const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();

	await supa.from('oauth_tokens').upsert(
		{
			user_id: acct.id,
			platform,
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: expiresAt,
			updated_at: new Date().toISOString(),
		},
		{ onConflict: 'user_id,platform' },
	);

	await supa.from('connections').upsert(
		{ user_id: acct.id, provider, status: 'active', connected_at: new Date().toISOString() },
		{ onConflict: 'user_id,provider' },
	);

	return new Response(JSON.stringify({ success: true, provider }), { headers: { 'Content-Type': 'application/json', ...cors } });
});
