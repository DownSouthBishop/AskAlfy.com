// Composio bridge. One place for the host, the API version, and the tool slugs, so
// switching managed↔custom auth or bumping the API version is a single-file edit.
//
// Verified against docs.composio.dev (api-reference/tools/postToolsExecuteByToolSlug and
// reference/sdk-reference/*/connected-accounts):
//   • host     https://backend.composio.dev
//   • version  /api/v3.1/   ← NOT v3; the v3 paths 404
//   • header   x-api-key
//   • execute  POST /api/v3.1/tools/execute/{tool_slug}  body { user_id, arguments }
//   • connect  POST /api/v3.1/connected_accounts/link    body { user_id, auth_config_id, callback_url }
//   • result   { data, error, successful } — `successful:false` is an HTTP 200, so it
//              MUST be checked; returning res.json() raw reads every failure as success.

import { requireEnv } from './env.ts';

const COMPOSIO_API_KEY = requireEnv('COMPOSIO_API_KEY');
const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3.1';

// action_type → Composio tool slug. Slugs confirmed against the live toolkit reference.
export const TOOL_SLUG: Record<string, string> = {
	'gmail.send': 'GMAIL_SEND_EMAIL',
	'gcal.create_event': 'GOOGLECALENDAR_CREATE_EVENT',
};

export const SLUG_READ_EMAIL = 'GMAIL_FETCH_EMAILS';
// ponytail: the one slug the docs didn't confirm outright. If a read-calendar call 404s,
// this is the string to change — GOOGLECALENDAR_FREE_BUSY_QUERY is the documented alternative.
export const SLUG_READ_CALENDAR = 'GOOGLECALENDAR_FIND_EVENT';

export interface ComposioResult {
	data?: unknown;
	error?: string | null;
	successful?: boolean;
}

// Throws on transport failure OR on a 200 that carries successful:false. Callers that want
// to hand the failure to the model catch it; alfy-approve lets it bubble so the row fails.
export async function composioExecute(
	userId: string,
	toolSlug: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await fetch(`${COMPOSIO_BASE}/tools/execute/${toolSlug}`, {
		method: 'POST',
		headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: userId, arguments: args }),
	});

	const body = (await res.json().catch(() => null)) as ComposioResult | null;
	if (!res.ok) throw new Error(`Composio ${toolSlug} HTTP ${res.status}: ${body?.error ?? 'no body'}`);
	if (body?.successful === false) throw new Error(`Composio ${toolSlug} failed: ${body.error ?? 'unknown'}`);
	return body?.data ?? body;
}

// Starts an OAuth connect and returns the URL to send the person to.
export async function composioConnectLink(
	userId: string,
	authConfigId: string,
	callbackUrl: string,
): Promise<{ id: string | null; redirectUrl: string | null }> {
	const res = await fetch(`${COMPOSIO_BASE}/connected_accounts/link`, {
		method: 'POST',
		headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: userId, auth_config_id: authConfigId, callback_url: callbackUrl }),
	});
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`Composio connect HTTP ${res.status}: ${body?.error ?? 'no body'}`);
	return { id: body?.id ?? null, redirectUrl: body?.redirect_url ?? body?.redirectUrl ?? null };
}
