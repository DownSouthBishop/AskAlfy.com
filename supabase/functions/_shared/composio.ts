// Composio bridge, built on Tool Router.
//
// Verified against docs.composio.dev (reference/api-reference/tool-router/* and tools/*):
//   • host      https://backend.composio.dev
//   • version   /api/v3.1/   ← NOT v3; the v3 paths 404
//   • header    x-api-key
//   • session   POST /tool_router/session            { user_id, toolkits }  → { session_id }
//   • search    POST /tool_router/session/{id}/search { queries }           → { tool_schemas }
//   • execute   POST /tool_router/session/{id}/execute { tool_slug, arguments }
//   • direct    POST /tools/execute/{slug}           { user_id, arguments }
//   • result    { data, error, successful } — `successful:false` is an HTTP 200, so it
//               MUST be checked; returning res.json() raw reads every failure as success.
//
// Tool Router rather than a fixed tool list is what makes Alfy work with ANY app the
// person has connected: `toolkits: null` scopes the session to all of them, and the model
// searches for what it needs instead of carrying every schema in context. Five connected
// apps is 200+ tools — injecting those wholesale would cost more per text than the model.

import { requireEnv } from './env.ts';

const COMPOSIO_API_KEY = requireEnv('COMPOSIO_API_KEY');
const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3.1';

async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
	const res = await fetch(`${COMPOSIO_BASE}${path}`, {
		method: 'POST',
		headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok) throw new Error(`Composio ${path} HTTP ${res.status}: ${JSON.stringify(parsed?.error ?? 'no body')}`);
	return parsed ?? {};
}

// The read/write gate lives in actions.ts — it describes what an action IS, and keeping it
// out of here means it stays importable without any secrets set, so it can be tested.
export { isReadOnly } from './actions.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Router
// ─────────────────────────────────────────────────────────────────────────────
export interface ToolSession {
	sessionId: string;
	/** Composio's own guidance for driving this session — appended to Alfy's system prompt. */
	assistivePrompt: string | null;
}

// toolkits: null scopes the session to every toolkit the person has connected.
export async function composioCreateSession(userId: string, timezone?: string): Promise<ToolSession> {
	const body = await call('/tool_router/session', {
		user_id: userId,
		toolkits: null,
		search: { enable: true },
		...(timezone ? { experimental: { assistive_prompt_config: { user_timezone: timezone } } } : {}),
	});
	const sessionId = body.session_id as string | undefined;
	if (!sessionId) throw new Error('Composio session create returned no session_id');
	const experimental = body.experimental as { assistive_prompt?: string } | undefined;
	return { sessionId, assistivePrompt: experimental?.assistive_prompt ?? null };
}

export interface FoundTool {
	slug: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface ToolSearchResult {
	tools: FoundTool[];
	/** Which apps are actually connected — lets Alfy say "Slack isn't linked yet" instead of failing. */
	connected: { toolkit: string; connected: boolean; status: string }[];
}

export async function composioSearchTools(sessionId: string, query: string): Promise<ToolSearchResult> {
	const body = await call(`/tool_router/session/${sessionId}/search`, { queries: [{ query }] });

	const schemas = (body.tool_schemas ?? {}) as Record<string, Record<string, unknown>>;
	const tools: FoundTool[] = Object.entries(schemas).map(([slug, s]) => ({
		slug,
		description: s.description as string | undefined,
		inputSchema: s.input_schema as Record<string, unknown> | undefined,
	}));

	const statuses = (body.toolkit_connection_statuses ?? []) as Record<string, unknown>[];
	const connected = statuses.map((s) => ({
		toolkit: String(s.toolkit ?? ''),
		connected: Boolean(s.has_active_connection),
		status: String(s.status_message ?? ''),
	}));

	return { tools, connected };
}

function unwrap(body: Record<string, unknown>, what: string): unknown {
	if (body.error) throw new Error(`Composio ${what} failed: ${body.error}`);
	if (body.successful === false) throw new Error(`Composio ${what} failed`);
	return body.data ?? body;
}

export async function composioExecuteInSession(
	sessionId: string,
	toolSlug: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const body = await call(`/tool_router/session/${sessionId}/execute`, { tool_slug: toolSlug, arguments: args });
	return unwrap(body, toolSlug);
}

// Direct execute — used by alfy-approve, which fires an approved action later, with no
// live session to attach to.
export async function composioExecute(
	userId: string,
	toolSlug: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const body = await call(`/tools/execute/${toolSlug}`, { user_id: userId, arguments: args });
	return unwrap(body, toolSlug);
}

// Starts an OAuth connect and returns the URL to send the person to.
export async function composioConnectLink(
	userId: string,
	authConfigId: string,
	callbackUrl: string,
): Promise<{ id: string | null; redirectUrl: string | null }> {
	const body = await call('/connected_accounts/link', {
		user_id: userId,
		auth_config_id: authConfigId,
		callback_url: callbackUrl,
	});
	return {
		id: (body.id as string) ?? null,
		redirectUrl: ((body.redirect_url ?? body.redirectUrl) as string) ?? null,
	};
}
