// alfy-agent — the brain. Anthropic tool-use loop, forked from Prymal's prymal-chat.
// Invariant that mirrors the brand ("Alfy asks first"): the agent NEVER sends or acts
// externally. Reads are direct (Gmail/Calendar REST via _shared/google.ts); anything
// outbound is queued via a dedicated action tool (or queue_action as a fallback) and
// only executed after approval (see alfy-approve).
//
// Lives here rather than in supabase/functions/alfy-agent/index.ts so alfy-sms-inbound
// can import it without relying on Supabase's per-folder function bundling.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';
import { calendarListEvents, getFreshToken, gmailGetThread, gmailList, gmailListLabels } from './google.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!; // platform pays inference (consumer SMS)

const SYSTEM_PROMPT = `You are Alfy — a warm, comfortably competent assistant a person texts.

Voice: plain words, contractions, no exclamation marks, no emoji, sentence case. Report what
you did, then ask. Max 5 lines. Sign off "— A". Never say "as an AI". Never use hype words.

RULES — never break these:
1. You never send, book, buy, or pay directly. Reading is always fine — do it freely.
2. For anything that leaves the person (an email, a calendar invite, an order), call the
   matching action tool (send_email, create_event, ...) — or queue_action if there's no
   dedicated tool yet. It waits for their yes in the dashboard; they get a link to approve.
3. Draft in the person's voice using their context. If you lack something you need, ask.
4. Be specific: say what you found, what you drafted, and that it's waiting for their yes.`;

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'get_context',
		description: "The person's profile, people they know, and standing okays.",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'get_emails',
		description: 'Search recent Gmail messages (read-only). Use Gmail search syntax for q, e.g. "from:dana is:unread".',
		input_schema: {
			type: 'object',
			properties: { q: { type: 'string' }, maxResults: { type: 'number', default: 10 } },
		},
	},
	{
		name: 'get_email_thread',
		description: 'Read a full Gmail thread by id (read-only).',
		input_schema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
	},
	{
		name: 'list_labels',
		description: 'List the Gmail labels on this account (read-only).',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'get_calendar_events',
		description: 'List upcoming or past calendar events (read-only).',
		input_schema: {
			type: 'object',
			properties: {
				timeMin: { type: 'string' },
				timeMax: { type: 'string' },
				maxResults: { type: 'number', default: 10 },
			},
		},
	},
	{
		name: 'send_email',
		description: 'Draft and queue an email for the person to approve. Nothing sends until they say yes.',
		input_schema: {
			type: 'object',
			properties: {
				to: { type: 'string' },
				cc: { type: 'string' },
				bcc: { type: 'string' },
				subject: { type: 'string' },
				body: { type: 'string' },
			},
			required: ['to', 'subject', 'body'],
		},
	},
	{
		name: 'create_event',
		description: 'Draft and queue a calendar event for the person to approve. Nothing is created until they say yes.',
		input_schema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				startTime: { type: 'string' },
				endTime: { type: 'string' },
				location: { type: 'string' },
				attendees: { type: 'array', items: { type: 'string' } },
				description: { type: 'string' },
			},
			required: ['title', 'startTime', 'endTime'],
		},
	},
	{
		name: 'queue_action',
		description: "Queue an outbound action with no dedicated tool yet, for the person to approve. Nothing happens until they say yes.",
		input_schema: {
			type: 'object',
			properties: {
				kind: { type: 'string', description: 'Card label: Email | Calendar | Order' },
				summary: { type: 'string', description: '"Reply to Dana about Thursday"' },
				draft_content: { type: 'string', description: 'The draft they will see and approve' },
				action_type: { type: 'string', description: 'A short machine name for this action' },
				action_payload: { type: 'object', description: 'Args an executor will need on approval' },
			},
			required: ['kind', 'summary', 'action_type', 'action_payload'],
		},
	},
];

const NOT_CONNECTED = (provider: string) => ({
	error: `${provider} is not connected yet. Ask the person to connect it in Settings.`,
});

async function handleTool(name: string, input: Record<string, unknown>, supa: ReturnType<typeof createClient>, userId: string) {
	switch (name) {
		case 'get_context': {
			const [{ data: user }, { data: people }, { data: perms }] = await Promise.all([
				supa.from('users').select('display_name, about, timezone').eq('id', userId).single(),
				supa.from('people').select('name, context_summary').eq('user_id', userId),
				supa.from('standing_permissions').select('description, action_type').eq('user_id', userId).is('revoked_at', null),
			]);
			return { user, people: people ?? [], standing_okays: perms ?? [] };
		}
		case 'get_emails': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) return NOT_CONNECTED('Gmail');
			return await gmailList(token, input.q as string | undefined, (input.maxResults as number) ?? 10);
		}
		case 'get_email_thread': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) return NOT_CONNECTED('Gmail');
			return await gmailGetThread(token, input.threadId as string);
		}
		case 'list_labels': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) return NOT_CONNECTED('Gmail');
			return await gmailListLabels(token);
		}
		case 'get_calendar_events': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) return NOT_CONNECTED('Calendar');
			return await calendarListEvents(token, input as { timeMin?: string; timeMax?: string; maxResults?: number });
		}
		case 'send_email': {
			const { data, error } = await supa.from('approval_queue').insert({
				user_id: userId,
				kind: 'Email',
				summary: `Email to ${input.to}: ${input.subject}`,
				draft_content: input.body,
				action_type: 'send_email',
				action_payload: { to: input.to, cc: input.cc ?? null, bcc: input.bcc ?? null, subject: input.subject },
				status: 'pending',
			}).select('id').single();
			if (error) throw new Error(error.message);
			return { queued: true, id: data?.id };
		}
		case 'create_event': {
			const { data, error } = await supa.from('approval_queue').insert({
				user_id: userId,
				kind: 'Calendar',
				summary: String(input.title),
				draft_content: (input.description as string | undefined) ?? null,
				action_type: 'create_event',
				action_payload: {
					title: input.title,
					startTime: input.startTime,
					endTime: input.endTime,
					location: input.location ?? null,
					attendees: input.attendees ?? [],
					description: input.description ?? null,
				},
				status: 'pending',
			}).select('id').single();
			if (error) throw new Error(error.message);
			return { queued: true, id: data?.id };
		}
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
			model: 'claude-haiku-4-5-20251001',
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
