// alfy-composio-connect — the connection-management half of the Composio bridge.
// _shared/composio.ts's getComposioTools/executeComposioTool only ever work for a
// toolkit the person has already connected; this function is what starts that
// connection. Mirrors alfy-connect's auth pattern exactly: Bearer JWT -> auth.getUser
// -> service-role lookup of users by auth_user_id.
//
// Stays a no-op in practice until COMPOSIO_API_KEY/COMPOSIO_TOOLKITS/
// COMPOSIO_AUTHCFG_* are set (see _shared/composio.ts's sovereignty note) — status
// just reports enabled:false and an empty toolkit list, and the Settings panel
// shows "coming soon" instead of a live connect link.

import { createClient } from 'npm:@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import {
	composioEnabled,
	composioToolkits,
	initiateComposioConnection,
	listComposioConnections,
	disconnectComposioToolkit,
} from '../_shared/composio.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
	const cors = corsHeaders(req);
	if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa.from('users').select('id').eq('auth_user_id', user.id).single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: cors });

	const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
	const action = body.action ?? (req.method === 'GET' ? 'status' : undefined);

	if (action === 'status') {
		const connected = await listComposioConnections(acct.id);
		return new Response(JSON.stringify({ enabled: composioEnabled, toolkits: composioToolkits(), connected }), {
			headers: { 'Content-Type': 'application/json', ...cors },
		});
	}

	if (action === 'connect') {
		const { toolkit, redirect_uri } = body;
		if (!toolkit || !redirect_uri) {
			return new Response(JSON.stringify({ error: 'missing toolkit or redirect_uri' }), { status: 400, headers: cors });
		}
		try {
			const redirectUrl = await initiateComposioConnection(acct.id, toolkit, redirect_uri);
			return new Response(JSON.stringify({ redirectUrl }), { headers: { 'Content-Type': 'application/json', ...cors } });
		} catch (err) {
			return new Response(JSON.stringify({ error: (err as Error).message ?? String(err) }), { status: 400, headers: cors });
		}
	}

	if (action === 'disconnect') {
		const { toolkit } = body;
		if (!toolkit) return new Response(JSON.stringify({ error: 'missing toolkit' }), { status: 400, headers: cors });
		await disconnectComposioToolkit(acct.id, toolkit);
		return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...cors } });
	}

	return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers: cors });
});
