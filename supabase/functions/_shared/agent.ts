// alfy-agent — the brain. Anthropic tool-use loop, forked from Prymal's prymal-chat.
// Invariant that mirrors the brand ("Alfy asks first"): the agent NEVER sends or acts
// externally on its own judgment. Reads run immediately (read-only Composio tools, or
// get_context/recall_contacts against our own DB); anything outbound is queued via a
// dedicated action tool (or queue_action as a fallback) and only executed after a yes —
// either a fresh tap on Approve (alfy-approve), or a standing permission granted earlier
// for that exact action_type (queue(), below — the yes already happened, it's just
// durable now).
//
// Every outside app — Google (via the bundled 'googlesuper' toolkit), Slack, Notion,
// GitHub, Outlook, Linear, Trello, Asana, HubSpot, Discord, Zoom — is Composio-backed
// (_shared/composio.ts). There is no hand-rolled per-app integration left; Composio is
// the only place an outbound API call to any of these apps happens.
//
// Lives here rather than in supabase/functions/alfy-agent/index.ts so alfy-sms-inbound
// can import it without relying on Supabase's per-folder function bundling.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';
import {
	composioEnabled,
	composioToolkits,
	disconnectComposioToolkit,
	executeComposioTool,
	getComposioTools,
	initiateComposioConnection,
	isComposioTool,
	isReadOnlyComposioTool,
} from './composio.ts';
import { executeAction } from './executors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!; // platform pays inference (consumer SMS)
const APP_URL = Deno.env.get('PUBLIC_APP_URL') ?? 'https://askalfy.com';

// Friendly name (what a person texts / what connect_app takes) -> Composio toolkit slug.
// Google is one bundled toolkit ('googlesuper' covers Gmail/Calendar/Drive/Docs/Sheets
// under a single auth config) rather than 6 separate connects, matching the one-consent
// -screen feel the old hand-rolled Google OAuth had.
const APP_ALIASES: Record<string, string> = {
	google: 'googlesuper',
	slack: 'slack',
	notion: 'notion',
	github: 'github',
	outlook: 'outlook',
	linear: 'linear',
	trello: 'trello',
	asana: 'asana',
	hubspot: 'hubspot',
	discord: 'discord',
	zoom: 'zoom',
};
const APP_NAMES = Object.keys(APP_ALIASES) as (keyof typeof APP_ALIASES)[];

const SYSTEM_PROMPT = `You are Alfy — a warm, comfortably competent assistant a person texts.

Voice: plain words, contractions, no exclamation marks, no emoji, sentence case. Report what
you did, then ask. Max 5 lines. Sign off "— A". Never say "as an AI". Never use hype words.

RULES — never break these:
1. You never send, book, buy, or pay directly. Reading is always fine — do it freely.
2. For anything that leaves the person (an email, a message, an invite, an order) in a
   connected app, call that app's tool. It queues the action; nothing happens until they say
   yes in reply to the confirmation they'll get. If there's no dedicated tool for it, use
   queue_action.
3. Draft in the person's voice using their context. If you lack something you need, ask.
4. Be specific: say what you found, what you drafted, and that it's waiting for their yes.
5. If a tool result comes back already done (auto: true), a standing permission covered it —
   report it the same as any other completed action, don't ask again, that yes already
   happened.
6. get_context's autonomy_candidates lists things the person has approved several times with
   no standing permission yet. You may offer — plainly, no pressure, at most one candidate
   per reply — to stop asking for that one specific thing. Only call
   grant_standing_permission after they clearly say yes in this same exchange; never propose
   and grant in the same turn without an answer. Each text starts fresh with no memory of
   earlier ones, so don't lean on this — mention it lightly when it's naturally relevant,
   don't turn it into a recurring pitch.
7. If connect_app returns a link, put that exact link in your reply — texting it is the only
   way the person can finish connecting. There's no dashboard for this; it all happens here.
8. Before using an app's tools (Gmail, Calendar, Slack, ...), make sure it's actually
   connected — if a tool call comes back saying it isn't, offer connect_app for that app
   rather than pretending the action happened.`;

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'get_context',
		description: "The person's profile, people they know, and standing okays.",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'remember_contact',
		description: "Save or update what Alfy knows about someone — not an outbound action, just memory. Rewrite context_summary to stay current rather than letting it grow forever; do this quietly, don't announce it.",
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				email: { type: 'string' },
				company: { type: 'string' },
				context_summary: { type: 'string', description: 'Plain-language notes, replaces what was there before' },
				tags: { type: 'array', items: { type: 'string' } },
				birthday: { type: 'string', description: 'Free text, e.g. "March 3" — year optional' },
			},
			required: ['name'],
		},
	},
	{
		name: 'recall_contacts',
		description: 'Search what Alfy knows about people (read-only). Use query for free-text name/email/company/notes matching, tag to filter by tag, or stale_days to find people not heard from in a while.',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				tag: { type: 'string' },
				stale_days: { type: 'number' },
				limit: { type: 'number', default: 20 },
			},
		},
	},
	{
		name: 'create_standing_instruction',
		description: 'Set up an ongoing check Alfy runs on a schedule (e.g. "never let me miss a birthday", "tell me if a bill looks overdue"). Not an outbound action — just sets up future automated checking. Store the goal verbatim, no special-casing by type.',
		input_schema: {
			type: 'object',
			properties: {
				goal_text: { type: 'string' },
				cadence: { type: 'string', enum: ['hourly', 'daily', 'weekly'], default: 'daily' },
			},
			required: ['goal_text'],
		},
	},
	{
		name: 'list_standing_instructions',
		description: "List the person's active standing instructions (read-only).",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'cancel_standing_instruction',
		description: 'Cancel a standing instruction the person no longer wants.',
		input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	},
	{
		name: 'grant_standing_permission',
		description: 'Turn a repeated approval into a standing okay so Alfy stops asking for that one specific kind of action and just does it, still confirming after. Only call this after the person clearly says yes to an offer — never propose and grant in the same turn without their answer.',
		input_schema: {
			type: 'object',
			properties: {
				action_type: { type: 'string', description: 'The action_type from get_context\'s autonomy_candidates, e.g. "create_task"' },
				description: { type: 'string', description: 'Plain line for the dashboard Trust list, e.g. "Adds tasks you ask for without checking first"' },
			},
			required: ['action_type', 'description'],
		},
	},
	{
		name: 'connect_app',
		description: "Start connecting an outside app so Alfy can use it for the person: google (Gmail, Calendar, Drive, Docs, Sheets — one connect covers all of them), slack, notion, github, outlook, linear, trello, asana, hubspot, discord, or zoom. Returns a link — put it in your reply exactly as given so they can tap it to finish. If an app isn't set up yet, say so plainly rather than pretending it worked.",
		input_schema: {
			type: 'object',
			properties: { app: { type: 'string', enum: APP_NAMES } },
			required: ['app'],
		},
	},
	{
		name: 'disconnect_app',
		description: 'Disconnect an outside app the person no longer wants Alfy to use.',
		input_schema: {
			type: 'object',
			properties: { app: { type: 'string', enum: APP_NAMES } },
			required: ['app'],
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

// Every outbound action funnels through here: insert a pending approval_queue row and
// return, never call the destination API directly. alfy-approve replays it after a yes.
async function queue(
	supa: ReturnType<typeof createClient>,
	userId: string,
	args: { kind: string; summary: string; draft_content?: string | null; action_type: string; action_payload: Record<string, unknown> },
) {
	// A standing permission already covers this exact action_type — that yes already
	// happened, so execute now instead of queueing. Still logged in approval_queue (as
	// 'executed', tagged with the permission) so it shows up in Handled and in digests the
	// same as anything else, and still confirmed in the reply — the ask goes away, the
	// transparency doesn't.
	const { data: permission } = await supa
		.from('standing_permissions')
		.select('id')
		.eq('user_id', userId)
		.eq('action_type', args.action_type)
		.is('revoked_at', null)
		.maybeSingle();

	if (permission) {
		const { data, error } = await supa.from('approval_queue').insert({
			user_id: userId,
			kind: args.kind,
			summary: args.summary,
			draft_content: args.draft_content ?? null,
			action_type: args.action_type,
			action_payload: args.action_payload,
			status: 'approved',
			standing_permission_id: permission.id,
			decided_at: new Date().toISOString(),
		}).select('id').single();
		if (error) throw new Error(error.message);

		try {
			const { confirmationText } = await executeAction(supa, userId, args.action_type, args.action_payload, args.draft_content ?? null);
			await supa.from('approval_queue').update({
				status: 'executed',
				executed_at: new Date().toISOString(),
				undo_until: new Date(Date.now() + 10 * 60_000).toISOString(),
			}).eq('id', data?.id);
			return { executed: true, auto: true, confirmation: confirmationText ?? `Done — ${args.summary}.` };
		} catch (err) {
			await supa.from('approval_queue').update({ status: 'failed' }).eq('id', data?.id);
			throw err;
		}
	}

	const { data, error } = await supa.from('approval_queue').insert({
		user_id: userId,
		kind: args.kind,
		summary: args.summary,
		draft_content: args.draft_content ?? null,
		action_type: args.action_type,
		action_payload: args.action_payload,
		status: 'pending',
	}).select('id').single();
	if (error) throw new Error(error.message);
	return { queued: true, id: data?.id };
}

async function handleTool(name: string, input: Record<string, unknown>, supa: ReturnType<typeof createClient>, userId: string) {
	switch (name) {
		case 'get_context': {
			const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString();
			const [{ data: user }, { data: people }, { data: perms }, { data: recentDecided }] = await Promise.all([
				supa.from('users').select('display_name, about, timezone').eq('id', userId).single(),
				supa.from('people').select('name, context_summary').eq('user_id', userId),
				supa.from('standing_permissions').select('description, action_type').eq('user_id', userId).is('revoked_at', null),
				supa.from('approval_queue').select('action_type, kind, summary')
					.eq('user_id', userId).in('status', ['approved', 'executed']).is('standing_permission_id', null)
					.gte('decided_at', thirtyDaysAgo),
			]);

			// Things approved 3+ times in the last 30 days with no standing permission yet —
			// candidates the model may offer to stop asking about (system prompt rule 6).
			const grantedTypes = new Set((perms ?? []).map((p) => p.action_type));
			const counts = new Map<string, { count: number; kind: string; example: string }>();
			for (const row of recentDecided ?? []) {
				if (grantedTypes.has(row.action_type)) continue;
				const entry = counts.get(row.action_type) ?? { count: 0, kind: row.kind, example: row.summary };
				entry.count += 1;
				counts.set(row.action_type, entry);
			}
			const autonomy_candidates = [...counts.entries()]
				.filter(([, v]) => v.count >= 3)
				.map(([action_type, v]) => ({ action_type, kind: v.kind, times_approved: v.count, example: v.example }));

			return { user, people: people ?? [], standing_okays: perms ?? [], autonomy_candidates };
		}
		case 'remember_contact': {
			const email = (input.email as string | undefined) ?? null;
			const row = {
				user_id: userId,
				name: input.name,
				email,
				company: input.company ?? null,
				context_summary: input.context_summary ?? null,
				tags: input.tags ?? [],
				birthday: input.birthday ?? null,
				last_interaction: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			const { data, error } = email
				? await supa.from('people').upsert(row, { onConflict: 'user_id,email' }).select('id').single()
				: await supa.from('people').insert(row).select('id').single();
			if (error) throw new Error(error.message);
			return { saved: true, id: data?.id };
		}
		case 'recall_contacts': {
			let q = supa.from('people').select('name, email, company, context_summary, tags, birthday, last_interaction').eq('user_id', userId);
			const query = input.query as string | undefined;
			if (query) q = q.or(`name.ilike.%${query}%,email.ilike.%${query}%,company.ilike.%${query}%,context_summary.ilike.%${query}%`);
			const tag = input.tag as string | undefined;
			if (tag) q = q.contains('tags', [tag]);
			const staleDays = input.stale_days as number | undefined;
			if (staleDays) q = q.lt('last_interaction', new Date(Date.now() - staleDays * 864e5).toISOString());
			const { data, error } = await q.order('updated_at', { ascending: false }).limit((input.limit as number) ?? 20);
			if (error) throw new Error(error.message);
			return data ?? [];
		}
		case 'create_standing_instruction': {
			const cadence = (input.cadence as string | undefined) ?? 'daily';
			const { data, error } = await supa.from('standing_instructions').insert({
				user_id: userId,
				goal_text: input.goal_text,
				trigger_type: 'cron',
				trigger_config: { cadence },
				status: 'active',
			}).select('id').single();
			if (error) throw new Error(error.message);
			return { created: true, id: data?.id };
		}
		case 'list_standing_instructions': {
			const { data, error } = await supa.from('standing_instructions')
				.select('id, goal_text, trigger_config, status, last_run_at, last_result')
				.eq('user_id', userId)
				.in('status', ['active', 'paused'])
				.order('created_at', { ascending: false });
			if (error) throw new Error(error.message);
			return data ?? [];
		}
		case 'cancel_standing_instruction': {
			const { error } = await supa.from('standing_instructions')
				.update({ status: 'cancelled' })
				.eq('id', input.id)
				.eq('user_id', userId);
			if (error) throw new Error(error.message);
			return { cancelled: true };
		}
		case 'grant_standing_permission': {
			const { data, error } = await supa.from('standing_permissions').insert({
				user_id: userId,
				action_type: input.action_type,
				description: input.description,
			}).select('id').single();
			if (error) throw new Error(error.message);
			return { granted: true, id: data?.id };
		}
		case 'connect_app': {
			const app = String(input.app).toLowerCase();
			const slug = APP_ALIASES[app];
			if (!slug || !composioEnabled || !composioToolkits().includes(slug)) {
				return { error: `${app} isn't set up to connect yet.` };
			}
			try {
				const redirectUrl = await initiateComposioConnection(userId, slug, `${APP_URL}/auth/app-connected?app=${app}`);
				return { redirectUrl };
			} catch (err) {
				return { error: `Could not start connecting ${app}: ${(err as Error).message}` };
			}
		}
		case 'disconnect_app': {
			const app = String(input.app).toLowerCase();
			await disconnectComposioToolkit(userId, APP_ALIASES[app] ?? app);
			return { disconnected: true };
		}
		case 'queue_action':
			return await queue(supa, userId, {
				kind: input.kind as string,
				summary: input.summary as string,
				draft_content: input.draft_content as string | undefined,
				action_type: input.action_type as string,
				action_payload: (input.action_payload as Record<string, unknown>) ?? {},
			});
		default: {
			// A connected-app tool (Gmail, Calendar, Slack, Notion, ...) dynamically fetched
			// from _shared/composio.ts for this person's connected toolkits. Reads run
			// immediately (rule 1: "reading is always fine") — everything else queues, same
			// "asks first" rule as every other outbound action: only alfy-approve's executor
			// (executors.ts) calls executeComposioTool for a write, after a yes.
			if (isComposioTool(name)) {
				if (isReadOnlyComposioTool(name)) {
					try {
						return await executeComposioTool(userId, name, input);
					} catch (err) {
						return { error: (err as Error).message };
					}
				}
				return await queue(supa, userId, {
					kind: 'App',
					summary: name.replace(/_/g, ' ').toLowerCase(),
					action_type: `composio:${name}`,
					action_payload: input,
				});
			}
			throw new Error(`Unknown tool: ${name}`);
		}
	}
}

const HISTORY_LIMIT = 8;

// The last few texts, oldest first, so a reply like "yes, that one" still means something.
// Call this BEFORE logging the current inbound message, or it comes back as history too.
// Only alfy-sms-inbound uses it — a cron-triggered automation run has no conversation.
export async function loadHistory(supa: ReturnType<typeof createClient>, userId: string): Promise<Anthropic.MessageParam[]> {
	const { data } = await supa
		.from('messages')
		.select('direction, body')
		.eq('user_id', userId)
		.order('created_at', { ascending: false })
		.limit(HISTORY_LIMIT);

	const msgs: Anthropic.MessageParam[] = (data ?? [])
		.reverse()
		.map((r) => ({
			role: (r.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
			content: String(r.body ?? ''),
		}));
	// The API rejects a conversation that opens on an assistant turn.
	while (msgs.length && msgs[0].role !== 'user') msgs.shift();
	return msgs;
}

// A wedged model that keeps calling tools would otherwise loop until the function times
// out, billing every round. Ten is far past any real turn.
const MAX_ROUNDS = 10;

// Runs one inbound message through the loop; returns Alfy's reply text.
export async function runAgent(userId: string, message: string, history: Anthropic.MessageParam[] = []): Promise<string> {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
	const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: message }];
	// [] while composioEnabled is false (see _shared/composio.ts) — TOOLS is unchanged then.
	const composioTools = await getComposioTools(userId);
	const tools = composioTools.length ? [...TOOLS, ...composioTools] : TOOLS;

	for (let round = 0; ; round++) {
		// Prompt caching. Each round re-sends the whole prefix (tools + system + every prior
		// message and tool result), so without this the cost is quadratic in rounds. A
		// top-level cache_control puts the breakpoint on the last cacheable block, so the
		// prefix caches incrementally: each round writes only its new increment (~1.25x) and
		// reads the rest (~0.1x). Below Haiku's ~4096-token minimum it's a silent no-op, so
		// early rounds still pay full price.
		const res = await anthropic.messages.create({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 1024,
			cache_control: { type: 'ephemeral' },
			system: SYSTEM_PROMPT,
			tools,
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

		if (round >= MAX_ROUNDS) {
			return "I got partway through that and got stuck. Text me again and I'll try a different way. — A";
		}
	}
}
