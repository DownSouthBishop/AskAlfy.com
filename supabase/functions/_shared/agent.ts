// The brain. Anthropic tool-use loop.
//
// Invariant that mirrors the brand ("Alfy asks first"): the agent NEVER sends or acts
// externally. Reads are direct; anything outbound is queued via queue_action and only
// executed after approval (see alfy-approve). Reads/tools reach apps through Composio.
//
// Lives in _shared/ because Supabase bundles per function folder — alfy-sms-inbound
// imports this, and a cross-folder import from alfy-agent/ would not deploy.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js';
import { requireEnv } from './env.ts';
import { composioExecute, SLUG_READ_CALENDAR, SLUG_READ_EMAIL } from './composio.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY'); // platform pays inference (consumer SMS)

// A runaway loop over a paid API is the expensive failure mode. Real turns use 2–4.
const MAX_TURNS = 12;

const SYSTEM_PROMPT = `You are Alfy — a warm, comfortably competent assistant a person texts.

Voice: plain words, contractions, no exclamation marks, no emoji, sentence case. Report what
you did, then ask. Max 5 lines. Sign off "— A". Never say "as an AI". Never use hype words.

RULES — never break these:
1. You never send, book, buy, or pay directly. Reading is always fine — do it freely.
2. For anything that leaves the person (an email, a calendar invite, an order), call
   queue_action. It waits for their yes in the dashboard; they get a link to approve.
3. Draft in the person's voice using their context. If you lack something you need, ask.
4. Be specific: say what you found, what you drafted, and that it's waiting for their yes.
5. The summary you put on queue_action is the ONLY thing the person reads before saying yes.
   Name the actual recipient, date, or amount in it — never a generic label like "Send an email".`;

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'get_context',
		description: "The person's profile, people they know, and standing okays.",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'read_email',
		description: 'Read recent or matching emails (safe, read-only).',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: "Gmail search syntax, e.g. 'from:dana subject:thursday'" },
				limit: { type: 'number', default: 10 },
			},
		},
	},
	{
		name: 'read_calendar',
		description: 'Look at the calendar for openings/conflicts (read-only).',
		input_schema: {
			type: 'object',
			properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } },
		},
	},
	{
		name: 'queue_action',
		description: 'Queue an outbound action for the person to approve. Nothing happens until they say yes.',
		input_schema: {
			type: 'object',
			properties: {
				kind: { type: 'string', description: 'Card label: Email | Calendar | Order' },
				summary: {
					type: 'string',
					description: 'What they are approving, specific enough to decide on: "Reply to Dana (dana@acme.com) that Thursday works"',
				},
				draft_content: { type: 'string', description: 'The draft they will see and approve' },
				action_type: { type: 'string', description: 'gmail.send | gcal.create_event' },
				action_payload: {
					type: 'object',
					description:
						'Args replayed via Composio on approval. gmail.send: {recipient_email, subject, body}. ' +
						'gcal.create_event: {summary, start_datetime (e.g. "2026-01-16T13:00:00"), timezone (IANA), ' +
						'event_duration_hour, event_duration_minutes, attendees}.',
				},
			},
			required: ['kind', 'summary', 'action_type', 'action_payload'],
		},
	},
];

// Untyped schema on purpose — there are no generated DB types in this repo. Spelling it
// `SupabaseClient` (not `ReturnType<typeof createClient>`) keeps the default generics;
// the ReturnType form resolves the schema to `never` and every .insert() stops compiling.
export type Supa = SupabaseClient;

// Set when a turn queues something, so the caller can deep-link the approval SMS at the
// item this turn actually created rather than whatever happened to be pending.
interface TurnState {
	queuedId: string | null;
}

async function handleTool(
	name: string,
	input: Record<string, unknown>,
	supa: Supa,
	userId: string,
	turn: TurnState,
) {
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
			return await composioExecute(userId, SLUG_READ_EMAIL, {
				query: input.query ?? '',
				max_results: input.limit ?? 10,
			});
		case 'read_calendar':
			return await composioExecute(userId, SLUG_READ_CALENDAR, {
				timeMin: input.timeMin,
				timeMax: input.timeMax,
			});
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
			turn.queuedId = (data?.id as string) ?? null;
			return { queued: true, id: data?.id };
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

// ── Model tiers ──────────────────────────────────────────────────────────────
// Most inbound texts are mechanical: look at the calendar, check for a reply, say yes.
// Haiku handles those. Two kinds of turn are worth more, and each has its own trigger:
//
//   1. DRAFTING — something a person will send under their own name. Detected by
//      queue_action, which is already the product's safety boundary, so it's free.
//   2. SYNTHESIS — "give me a quick overview of the Slack channel / this spreadsheet".
//      Read-only, so it never trips trigger 1, but it's the harder job: a lot of
//      content in, a short useful answer out. Detected by how much the reads dragged
//      back — the thing that makes it hard is the thing that makes it measurable.
//
// Neither needs a classifier call or an extra round trip.
//
// The two tiers take DIFFERENT request shapes — Haiku 4.5 predates adaptive thinking and
// rejects output_config.effort with a 400, so it gets neither. Don't merge these.
const FAST = {
	model: 'claude-haiku-4-5',
	max_tokens: 4096, // enough for tool calls plus a 5-line reply
} as const;

const CAREFUL = {
	model: 'claude-sonnet-5',
	max_tokens: 8000,
	thinking: { type: 'adaptive' },
	// Sonnet 5 at medium ≈ Sonnet 4.6 at high. Raise to 'high' if drafts read flat.
	output_config: { effort: 'medium' },
} as const;

// Characters of tool output in one turn past which synthesis stops being Haiku's job.
// Roughly: a couple of emails stays under it; a channel digest or a sheet dump doesn't.
// ponytail: a flat threshold, not a token count — tune it on real traffic if it misfires.
const SYNTHESIS_CHARS = 8000;

export interface AgentTurn {
	reply: string;
	queuedId: string | null;
	tier: 'fast' | 'careful'; // which model actually answered — the cost signal when testing
}

// Runs one inbound message through the loop.
export async function runAgent(userId: string, message: string, history: Anthropic.MessageParam[] = []): Promise<AgentTurn> {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
	const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: message }];
	const turn: TurnState = { queuedId: null };
	let careful = false;
	let read = 0; // chars of tool output pulled back this turn — drives the synthesis tier

	const text = (res: Anthropic.Message) =>
		res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('');
	const done = (reply: string): AgentTurn => ({ reply, queuedId: turn.queuedId, tier: careful ? 'careful' : 'fast' });

	for (let i = 0; i < MAX_TURNS; i++) {
		const res = await anthropic.messages.create({
			...(careful ? CAREFUL : FAST),
			system: SYSTEM_PROMPT,
			tools: TOOLS,
			messages,
		});

		// Anything that isn't a tool call ends the turn. Naming the cases keeps a truncated
		// or refused response from being texted out as if it were a finished answer.
		if (res.stop_reason !== 'tool_use') {
			if (res.stop_reason === 'max_tokens') return done("I got tangled up on that one. Mind sending it again, a bit shorter? — A");
			if (res.stop_reason === 'refusal') return done("That's not something I can help with. — A");
			return done(text(res));
		}

		// Escalate before drafting, not after: discard this whole assistant turn and let the
		// careful model decide for itself, with every read it already has still in context.
		// Discarding the turn wholesale (rather than running the other tools in it) keeps
		// every tool_use paired with a tool_result, which the API requires.
		if (!careful && res.content.some((b) => b.type === 'tool_use' && b.name === 'queue_action')) {
			careful = true;
			continue;
		}

		const results: Anthropic.ToolResultBlockParam[] = [];
		for (const block of res.content) {
			if (block.type === 'tool_use') {
				try {
					const out = await handleTool(block.name, block.input as Record<string, unknown>, supa, userId, turn);
					results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
				} catch (err) {
					results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${(err as Error).message}`, is_error: true });
				}
			}
		}
		// Synthesis trigger. Unlike the drafting one above, nothing is discarded — the reads
		// were fine, it's the answering that wants the better model. Keep the results and
		// upgrade whoever reads them next.
		read += results.reduce((n, r) => n + String(r.content).length, 0);
		if (!careful && read > SYNTHESIS_CHARS) careful = true;

		messages.push({ role: 'assistant', content: res.content });
		messages.push({ role: 'user', content: results });
	}

	return done("I'm going in circles on that one. Can you tell me a bit more? — A");
}
