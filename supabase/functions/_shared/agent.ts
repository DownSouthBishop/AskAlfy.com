// The brain. Anthropic tool-use loop over Composio's Tool Router.
//
// Invariant that mirrors the brand ("Alfy asks first"): the agent NEVER sends or acts
// externally. Reads run immediately; anything that writes is turned into a pending
// approval_queue row and only fires after a deliberate tap (see alfy-approve).
//
// The agent carries THREE tools, not one per integration. Composio's Tool Router scopes a
// session to every app the person has connected and lets the model search for what it
// needs, so Alfy works with any toolkit — Slack, Sheets, Notion, whatever gets connected
// next — with no code change here, and without carrying 200 tool schemas in context.
//
// Lives in _shared/ because Supabase bundles per function folder: alfy-sms-inbound and
// alfy-brief both import it, and a cross-folder import would not deploy.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js';
import { requireEnv } from './env.ts';
import { actionDraft, actionSummary, kindOf, scopeKey } from './actions.ts';
import {
	composioCreateSession,
	composioExecuteInSession,
	composioSearchTools,
	isReadOnly,
	type ToolSession,
} from './composio.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY'); // platform pays inference (consumer SMS)

// A runaway loop over a paid API is the expensive failure mode. Real turns use 3–6.
const MAX_TURNS = 14;

export type Supa = SupabaseClient;

const SYSTEM_PROMPT = `You are Alfy — a warm, comfortably competent assistant a person texts.

Voice: plain words, contractions, no exclamation marks, no emoji, sentence case. Report what
you did, then ask. Max 5 lines. Sign off "— A". Never say "as an AI". Never use hype words.

HOW YOU WORK
You reach the person's apps through two tools. find_tools searches everything they've
connected — email, calendar, chat, spreadsheets, files — and hands back the exact tools plus
the arguments each one takes. use_tool runs one.

Always find_tools before use_tool. Never invent a tool name or an argument name; use the
schema you were given. If find_tools says an app isn't connected, say so plainly and tell
them they can link it in the dashboard — don't pretend or work around it.

RULES — never break these:
1. Reading is always fine. Do it freely and without asking.
2. Anything that WRITES — sends, posts, books, buys, changes, deletes — does not happen when
   you call it. It becomes a request waiting for their yes, and they get a link. Say so:
   "it's waiting for your yes", never "I sent it".
   The one exception: if use_tool comes back {sent:true, standing_okay:true}, they have
   already told you to stop asking about that exact thing, so it really did go. Say it's
   done, and mention it was one of their standing okays.
3. Draft in the person's voice using their context. If you lack something you need, ask.
4. Be specific about what you found and what's waiting.`;

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'get_context',
		description: "The person's profile, the people they know, and their standing okays.",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'find_tools',
		description:
			'Search everything the person has connected for tools that can do a thing. Returns tool ' +
			'names with the arguments each accepts, plus which apps are actually connected. ' +
			'Call this before use_tool, and search by what you want to accomplish ' +
			'("read recent slack messages in #general", "send an email").',
		input_schema: {
			type: 'object',
			properties: { query: { type: 'string', description: 'What you are trying to do, in plain words' } },
			required: ['query'],
		},
	},
	{
		name: 'use_tool',
		description:
			'Run one tool returned by find_tools. Reads run immediately and return their result. ' +
			'Anything that writes is queued for the person to approve — you will get back ' +
			'{queued:true}, which means it has NOT happened yet.',
		input_schema: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'The exact tool name from find_tools' },
				arguments: { type: 'object', description: 'Arguments matching that tool\'s schema' },
			},
			required: ['tool', 'arguments'],
		},
	},
];

interface TurnState {
	queuedId: string | null;
	session: ToolSession | null;
	/** chars of tool output pulled back this turn — drives the synthesis tier */
	read: number;
}

// Has the person already told Alfy to stop asking about exactly this? A permission is
// scoped to tool + target, granted, and not revoked — nothing here infers one.
async function standingOkay(supa: Supa, userId: string, scope: string | null): Promise<boolean> {
	if (!scope) return false;
	const { data } = await supa
		.from('standing_permissions')
		.select('id')
		.eq('user_id', userId)
		.eq('scope_key', scope)
		.not('granted_at', 'is', null)
		.is('revoked_at', null)
		.maybeSingle();
	return Boolean(data);
}

async function queueForApproval(
	supa: Supa,
	userId: string,
	slug: string,
	payload: Record<string, unknown>,
	turn: TurnState,
) {
	const { data, error } = await supa.from('approval_queue').insert({
		user_id: userId,
		kind: kindOf(slug),
		summary: actionSummary(slug, payload),
		draft_content: actionDraft(payload),
		action_type: slug,
		action_payload: payload,
		scope_key: scopeKey(slug, payload),
		status: 'pending',
	}).select('id').single();
	if (error) throw new Error(error.message);
	turn.queuedId = (data?.id as string) ?? null;
	return {
		queued: true,
		note: 'Waiting for their yes. It has not happened yet — tell them it is waiting, not that it is done.',
	};
}

// Logged as already-decided so it still appears in Handled, attributed to the standing okay
// rather than to a tap that never happened. An action Alfy takes on its own still has to be
// visible; autonomy is not the same as silence.
async function recordAutonomous(
	supa: Supa,
	userId: string,
	slug: string,
	payload: Record<string, unknown>,
	scope: string,
) {
	const now = new Date().toISOString();
	const { data: perm } = await supa
		.from('standing_permissions')
		.select('id')
		.eq('user_id', userId)
		.eq('scope_key', scope)
		.not('granted_at', 'is', null)
		.is('revoked_at', null)
		.maybeSingle();

	await supa.from('approval_queue').insert({
		user_id: userId,
		kind: kindOf(slug),
		summary: actionSummary(slug, payload),
		draft_content: actionDraft(payload),
		action_type: slug,
		action_payload: payload,
		scope_key: scope,
		standing_permission_id: perm?.id ?? null,
		status: 'executed',
		decided_at: now,
		executed_at: now,
		undo_until: new Date(Date.now() + 10 * 60_000).toISOString(),
	});
}

async function session(supa: Supa, userId: string, turn: TurnState): Promise<ToolSession> {
	if (turn.session) return turn.session;
	// Lazy: a turn that never touches an app never pays for a session.
	const { data: user } = await supa.from('users').select('timezone').eq('id', userId).single();
	turn.session = await composioCreateSession(userId, user?.timezone as string | undefined);
	return turn.session;
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
		case 'find_tools': {
			const s = await session(supa, userId, turn);
			const found = await composioSearchTools(s.sessionId, String(input.query ?? ''));
			return {
				tools: found.tools.map((t) => ({
					tool: t.slug,
					description: t.description,
					arguments: t.inputSchema,
					// Told plainly so the model reports honestly rather than claiming it sent something.
					needs_approval: !isReadOnly(t.slug),
				})),
				connected_apps: found.connected,
			};
		}
		case 'use_tool': {
			const slug = String(input.tool ?? '');
			const args = (input.arguments as Record<string, unknown>) ?? {};
			if (!slug) throw new Error('use_tool needs a tool name from find_tools');

			// THE approval boundary. Unrecognised verbs count as writes — see isReadOnly.
			if (!isReadOnly(slug)) {
				// ...unless the person has already said "stop asking about this one". That
				// permission is scoped to this tool and this target, was offered by Alfy and
				// granted deliberately, and is revocable from the dashboard.
				const scope = scopeKey(slug, args);
				if (await standingOkay(supa, userId, scope)) {
					const s = await session(supa, userId, turn);
					const result = await composioExecuteInSession(s.sessionId, slug, args);
					await recordAutonomous(supa, userId, slug, args, scope!);
					return { sent: true, standing_okay: true, result };
				}
				return await queueForApproval(supa, userId, slug, args, turn);
			}

			const s = await session(supa, userId, turn);
			return await composioExecuteInSession(s.sessionId, slug, args);
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

// ── Model tiers ──────────────────────────────────────────────────────────────
// Most inbound texts are mechanical: look at the calendar, check for a reply, say yes.
// Haiku handles those. Two kinds of turn are worth more, and each has its own trigger:
//
//   1. DRAFTING — something a person will send under their own name. Detected by a write
//      being queued, which is already the product's safety boundary, so it's free.
//   2. SYNTHESIS — "give me a quick overview of the Slack channel / this spreadsheet".
//      Read-only, so it never trips trigger 1, but it's the harder job: a lot of content
//      in, a short useful answer out. Detected by how much the reads dragged back — the
//      thing that makes it hard is the thing that makes it measurable.
//
// Neither needs a classifier call or an extra round trip.
//
// The two tiers take DIFFERENT request shapes — Haiku 4.5 predates adaptive thinking and
// rejects output_config.effort with a 400, so it gets neither. Don't merge these.
const FAST = {
	model: 'claude-haiku-4-5',
	max_tokens: 4096,
} as const;

const CAREFUL = {
	model: 'claude-sonnet-5',
	max_tokens: 8000,
	thinking: { type: 'adaptive' },
	// Sonnet 5 at medium ≈ Sonnet 4.6 at high. Raise to 'high' if drafts read flat.
	output_config: { effort: 'medium' },
} as const;

const SYNTHESIS_CHARS = 8000;

export interface AgentTurn {
	reply: string;
	queuedId: string | null;
	tier: 'fast' | 'careful';
}

export interface RunOptions {
	/** Start on the careful tier — the daily brief is synthesis by definition. */
	careful?: boolean;
	/** Extra instructions for this run (e.g. "no human is present"). */
	extraSystem?: string;
}

export async function runAgent(
	userId: string,
	message: string,
	opts: RunOptions = {},
): Promise<AgentTurn> {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
	const messages: Anthropic.MessageParam[] = [{ role: 'user', content: message }];
	const turn: TurnState = { queuedId: null, session: null, read: 0 };
	let careful = opts.careful ?? false;

	const text = (res: Anthropic.Message) =>
		res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('');
	const done = (reply: string): AgentTurn => ({ reply, queuedId: turn.queuedId, tier: careful ? 'careful' : 'fast' });

	for (let i = 0; i < MAX_TURNS; i++) {
		// Composio's session prompt explains its own meta-tools; appending it beats
		// second-guessing them here. Only present once a session exists.
		const system = [SYSTEM_PROMPT, opts.extraSystem, turn.session?.assistivePrompt]
			.filter(Boolean).join('\n\n');

		const res = await anthropic.messages.create({
			...(careful ? CAREFUL : FAST),
			system,
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

		// Drafting trigger: a write is about to be queued. Discard this whole assistant turn
		// so the careful model composes it, with every read it already has still in context.
		// Discarding wholesale (rather than running the turn's other tools) keeps every
		// tool_use paired with a tool_result, which the API requires.
		const writing = res.content.some((b) =>
			b.type === 'tool_use' && b.name === 'use_tool' &&
			!isReadOnly(String((b.input as { tool?: string })?.tool ?? ''))
		);
		if (!careful && writing) {
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

		// Synthesis trigger. Unlike drafting, nothing is discarded — the reads were fine,
		// it's the answering that wants the better model.
		turn.read += results.reduce((n, r) => n + String(r.content).length, 0);
		if (!careful && turn.read > SYNTHESIS_CHARS) careful = true;

		messages.push({ role: 'assistant', content: res.content });
		messages.push({ role: 'user', content: results });
	}

	return done("I'm going in circles on that one. Can you tell me a bit more? — A");
}
