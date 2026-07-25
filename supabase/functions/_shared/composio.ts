// Composio bridge — connects Alfy to apps beyond Google (Slack, Notion, GitHub,
// Outlook, ...) through Composio's managed tool catalog and OAuth, both for
// running tools (getComposioTools/executeComposioTool) and for starting/checking/
// ending a user's connection to a toolkit (initiateComposioConnection/
// listComposioConnections/disconnectComposioToolkit — wired to alfy-composio-
// connect and the "Connected apps" rows in the dashboard's Settings panel).
// Feature-flagged: without COMPOSIO_API_KEY set, everything here no-ops and the
// chat loop runs exactly as before.
//
// "Alfy asks first" still applies to connected apps: unlike PrymalAI-dashboard's
// prymal-chat, _shared/agent.ts does NOT call executeComposioTool directly from
// the tool loop — a composio tool call goes through the same queue()/approval_queue
// path as every other outbound action, and only alfy-approve's executor (via
// executors.ts) calls executeComposioTool, after a yes. See _shared/agent.ts and
// _shared/executors.ts's composio: prefix handling.
//
// Sovereignty note (WIG): Composio is a third-party SaaS that holds user OAuth
// tokens for connected apps. Approved by founder instruction 2026-07-19; keep
// the flag off until the cost/trust review is signed off. This module is built
// and ready but stays inert (composioEnabled is false) until COMPOSIO_API_KEY/
// COMPOSIO_TOOLKITS/COMPOSIO_AUTHCFG_* are actually set as secrets — do not set
// them without the founder's sign-off.

import Anthropic from 'npm:@anthropic-ai/sdk';

const COMPOSIO_API_KEY = Deno.env.get('COMPOSIO_API_KEY') ?? '';
// Comma-separated toolkit slugs to expose, e.g. "slack,notion,github,outlook"
const COMPOSIO_TOOLKITS = (Deno.env.get('COMPOSIO_TOOLKITS') ?? '')
	.split(',').map((s) => s.trim()).filter(Boolean);

export const composioEnabled = Boolean(COMPOSIO_API_KEY && COMPOSIO_TOOLKITS.length);

// Lazily-initialized SDK (npm dep only loaded when the flag is on)
// deno-lint-ignore no-explicit-any
let _composio: any = null;
// deno-lint-ignore no-explicit-any
async function getClient(): Promise<any> {
	if (_composio) return _composio;
	const { Composio } = await import('npm:@composio/core');
	const { AnthropicProvider } = await import('npm:@composio/anthropic');
	_composio = new Composio({ apiKey: COMPOSIO_API_KEY, provider: new AnthropicProvider() });
	return _composio;
}

const composioToolNames = new Set<string>();

// Fetch the Anthropic-format tool defs for this user's connected toolkits.
// Returns [] on any failure — Alfy degrades to Google-only, never crashes.
export async function getComposioTools(userId: string): Promise<Anthropic.Tool[]> {
	if (!composioEnabled) return [];
	try {
		const composio = await getClient();
		const tools = await composio.tools.get(userId, { toolkits: COMPOSIO_TOOLKITS });
		const list: Anthropic.Tool[] = Array.isArray(tools) ? tools : [];
		for (const t of list) composioToolNames.add(t.name);
		return list;
	} catch (err) {
		console.error('Composio tools.get failed:', err);
		return [];
	}
}

export function isComposioTool(name: string): boolean {
	return composioToolNames.has(name);
}

export async function executeComposioTool(
	userId: string,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const composio = await getClient();
	return await composio.tools.execute(name, { userId, arguments: args });
}

// ── Connection management. Each toolkit needs its own auth config, created once
// in the Composio dashboard, referenced here by env var COMPOSIO_AUTHCFG_<TOOLKIT>,
// e.g. COMPOSIO_AUTHCFG_SLACK — same naming AskAlfy used pre-port for
// COMPOSIO_AUTHCFG_GMAIL/COMPOSIO_AUTHCFG_CALENDAR before Google moved to its own
// hand-rolled OAuth.

export function composioToolkits(): string[] {
	return COMPOSIO_TOOLKITS;
}

// Starts a hosted OAuth flow for one toolkit and returns the URL to send the person
// to. Composio redirects back to callbackUrl once they finish authorizing.
export async function initiateComposioConnection(
	userId: string,
	toolkit: string,
	callbackUrl: string,
): Promise<string> {
	if (!composioEnabled) throw new Error('composio_disabled');
	if (!COMPOSIO_TOOLKITS.includes(toolkit)) throw new Error('toolkit_not_enabled');
	const authConfigId = Deno.env.get(`COMPOSIO_AUTHCFG_${toolkit.toUpperCase()}`);
	if (!authConfigId) throw new Error('missing_auth_config');
	const composio = await getClient();
	const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, { callbackUrl });
	return connectionRequest.redirectUrl;
}

// Which of this person's enabled toolkits currently have an active connection.
// Returns [] on any failure — a status check should never break the dashboard.
export async function listComposioConnections(userId: string): Promise<string[]> {
	if (!composioEnabled) return [];
	try {
		const composio = await getClient();
		const { items } = await composio.connectedAccounts.list({
			userIds: [userId],
			toolkitSlugs: COMPOSIO_TOOLKITS,
			statuses: ['ACTIVE'],
		});
		// deno-lint-ignore no-explicit-any
		return (items ?? []).map((a: any) => a.toolkit?.slug).filter(Boolean);
	} catch (err) {
		console.error('Composio connectedAccounts.list failed:', err);
		return [];
	}
}

export async function disconnectComposioToolkit(userId: string, toolkit: string): Promise<void> {
	if (!composioEnabled) return;
	const composio = await getClient();
	const { items } = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [toolkit] });
	// deno-lint-ignore no-explicit-any
	for (const acct of items ?? []) await composio.connectedAccounts.delete((acct as any).id);
}
