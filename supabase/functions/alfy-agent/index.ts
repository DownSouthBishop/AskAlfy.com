// alfy-agent — the brain. Anthropic tool-use loop, forked from Prymal's prymal-chat.
// Invariant that mirrors the brand ("Alfy asks first"): the agent NEVER sends or acts
// externally. Reads are direct; anything outbound is queued via queue_action and only
// executed after approval (see alfy-approve). Reads/tools reach apps through Composio.
//
// VERIFY before prod (see docs/alfy-handoff.md): Composio execute endpoint + auth header,
// and the exact tool slugs (GMAIL_FETCH_EMAILS, GOOGLECALENDAR_FIND_EVENT, ...).

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!; // platform pays inference (consumer SMS)
const COMPOSIO_API_KEY = Deno.env.get('COMPOSIO_API_KEY')!;
const COMPOSIO_BASE = 'https://backend.composio.dev'; // VERIFY host in handoff

const SYSTEM_PROMPT = `You are Alfy — a warm, comfortably competent assistant a person texts.

Voice: plain words, contractions, no exclamation marks, no emoji, sentence case. Report what
you did, then ask. Max 5 lines. Sign off "— A". Never say "as an AI". Never use hype words.

RULES — never break these:
1. You never send, book, buy, or pay directly. Reading is always fine — do it freely.
2. For anything that leaves the person (an email, a calendar invite, an order), call
   queue_action. It waits for their yes in the dashboard; they get a link to approve.
3. Draft in the person's voice using their context. If you lack something you need, ask.
4. Be specific: say what you found, what you drafted, and that it's waiting for their yes.`;

// ── Composio bridge ──────────────────────────────────────────────────────────
// VERIFY: exact path/shape. As of the pulled docs, tool execution runs a tool slug for a
// given user_id whose connected account Composio resolves + auto-refreshes.
async function composio(userId: string, toolSlug: string, args: Record<string, unknown>) {
	const res = await fetch(`${COMPOSIO_BASE}/api/v3/tools/execute/${toolSlug}`, {
		method: 'POST',
		headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: userId, arguments: args }),
	});
	return await res.json();
}

const TOOLS: Anthropic.Tool[] = [
	{ name: 'get_context', description: "The person's profile, people they know, and standing okays.", input_schema: { type: 'object', properties: {} } },
	{
		name: 'read_email', description: 'Read recent or matching emails (safe, read-only).',
		input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', default: 10 } } },
	},
	{
		name: 'read_calendar', description: 'Look at the calendar for openings/conflicts (read-only).',
		input_schema: { type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } } },
	},
	{
		name: 'queue_action', description: 'Queue an outbound action for the person to approve. Nothing happens until they say yes.',
		input_schema: {
			type: 'object',
			properties: {
				kind: { type: 'string', description: 'Card label: Email | Calendar | Order' },
				summary: { type: 'string', description: '"Reply to Dana about Thursday"' },
				draft_content: { type: 'string', description: 'The draft they will see and approve' },
				action_type: { type: 'string', description: 'gmail.send | gcal.create_event | ...' },
				action_payload: { type: 'object', description: 'Args replayed via Composio on approval' },
			},
			required: ['kind', 'summary', 'action_type', 'action_payload'],
		},
	},
];

async function handleTool(name: string, input: Record<string, unknown>, supa: ReturnType<typeof createClient>, userId: string) {
	switch (name) {
		case 'get_context': {
			const [{ data: user }, { data: people }, { data: perms }] = await Promise.all([
				supa.from('users').select('display_name, about, timezone').eq('id', userId).single(),
				supa.from('people').select('name, note').eq('user_id', userId),
				supa.from('standing_permissions').select('description, action_type').eq('user_id', userId).is('revoked_at', null),
			]);
			return { user, people: people ?? [], standing_okays: perms ?? [] };
		}
		case 'read_email':
			return await composio(userId, 'GMAIL_FETCH_EMAILS', { query: input.query ?? '', max_results: input.limit ?? 10 }); // VERIFY slug
		case 'read_calendar':
			return await composio(userId, 'GOOGLECALENDAR_FIND_EVENT', { timeMin: input.timeMin, timeMax: input.timeMax }); // VERIFY slug
		case 'queue_action': {
			const { data, error } = await supa.from('approval_queue').insert({
				user_id: userId,
				kind: input.kind,
				summary: input.summary,
				draft_content: input.draft_content ?? null,
				action_type: input.action_type,
				action_payload: input.action_payload ?? {},
				status: 'pending',
			}).select('id').single();
			if (error) throw new Error(error.message);
			return { queued: true, id: data?.id };
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

// Runs one inbound message through the loop; returns Alfy's reply text.
export async function runAgent(userId: string, message: string, history: Anthropic.MessageParam[] = []): Promise<string> {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
	const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: message }];

	while (true) {
		const res = await anthropic.messages.create({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			system: SYSTEM_PROMPT,
			tools: TOOLS,
			messages,
		});

		if (res.stop_reason !== 'tool_use') {
			return res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('');
		}

		const results: Anthropic.ToolResultBlockParam[] = [];
		for (const block of res.content) {
			if (block.type === 'tool_use') {
				try {
					const out = await handleTool(block.name, block.input as Record<string, unknown>, supa, userId);
					results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
				} catch (err) {
					results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${(err as Error).message}`, is_error: true });
				}
			}
		}
		messages.push({ role: 'assistant', content: res.content });
		messages.push({ role: 'user', content: results });
	}
}
