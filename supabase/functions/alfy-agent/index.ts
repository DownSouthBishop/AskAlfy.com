// The agent loop lives in ../_shared/agent.ts so alfy-sms-inbound can import it
// (Supabase bundles per function folder). This endpoint exists so the loop can be
// exercised on its own during setup — it is not on the SMS path.

import { createClient } from 'npm:@supabase/supabase-js';
import { runAgent } from '../_shared/agent.ts';
import { requireEnv } from '../_shared/env.ts';
import { CORS, JSON_CORS } from '../_shared/cors.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = requireEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

	// Runs as the caller — you can only drive the agent on your own account.
	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_CORS });

	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_CORS });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa.from('users').select('id').eq('auth_user_id', user.id).single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: JSON_CORS });

	const { message } = await req.json().catch(() => ({ message: null }));
	if (!message) return new Response(JSON.stringify({ error: 'missing message' }), { status: 400, headers: JSON_CORS });

	const turn = await runAgent(acct.id as string, String(message));
	return new Response(JSON.stringify(turn), { headers: JSON_CORS });
});
