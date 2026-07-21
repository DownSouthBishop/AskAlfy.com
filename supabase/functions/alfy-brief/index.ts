// alfy-brief — the daily brief. pg_cron ticks this hourly (see 0003_daily_brief.sql);
// each tick sends to whoever's local brief hour has just come round.
//
// Auth is a shared secret, not a user session — there's no human in the loop at 7am.
// Deploy with --no-verify-jwt.
//
// Runs SEQUENTIALLY inside a wall-clock budget rather than fanning out. Cal's automation
// runner did Promise.allSettled over up to 50 concurrent agent runs in one invocation,
// which blows the edge function's time limit; the rows are already claimed by then, so
// whatever didn't finish is simply lost. Here, one tick does what it comfortably can and
// leaves the rest for the next — briefs are hourly-granular, so nobody notices.

import { createClient } from 'npm:@supabase/supabase-js';
import { runAgent } from '../_shared/agent.ts';
import { requireEnv } from '../_shared/env.ts';
import { sendSms, TWILIO_FROM } from '../_shared/twilio.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const RUNNER_SECRET = requireEnv('INTERNAL_FUNCTION_SECRET');

const BATCH = 20;
const BUDGET_MS = 100_000; // leave headroom under the edge function ceiling

const PROMPT = `Write this person's daily brief.

Look across what they have connected — mail, calendar, chat, anything else — and pull out
only what actually matters for today: what needs a reply, what they've committed to, what
changed, what's about to be late. Skip anything routine.

This is automation. No one is reading in real time, so don't ask a question and don't offer
to do anything — they can just text you back. Read only; queue nothing.

Lead with the single most important thing. Then at most four short lines. If genuinely
nothing needs them today, say exactly that in one line. Sign off "— A".`;

Deno.serve(async (req) => {
	if (req.headers.get('x-runner-key') !== RUNNER_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const startedAt = Date.now();

	// Claims and marks in one statement — see claim_briefs. Anything this tick can't get
	// to is left for the next one rather than re-run.
	const { data: due, error } = await supa.rpc('claim_briefs', { p_limit: BATCH });
	if (error) {
		console.error('claim_briefs failed', error);
		return new Response(JSON.stringify({ error: error.message }), { status: 500 });
	}

	let sent = 0;
	let failed = 0;
	let deferred = 0;

	for (const person of (due ?? []) as { user_id: string; phone_e164: string }[]) {
		if (Date.now() - startedAt > BUDGET_MS) {
			deferred++;
			continue;
		}
		try {
			// Careful tier from the first call: a brief is synthesis by definition, so there's
			// no point paying for a fast pass that will escalate on volume anyway.
			const turn = await runAgent(person.user_id, PROMPT, { careful: true });
			const body = turn.reply.trim();
			if (!body) continue;

			const segments = await sendSms(person.phone_e164, body);
			await supa.from('messages').insert({
				user_id: person.user_id,
				from_phone: TWILIO_FROM,
				direction: 'outbound',
				body,
				segments: segments || 1,
			});
			sent++;
		} catch (err) {
			// Already claimed, so this person just waits for tomorrow. Logged, not retried —
			// a retry loop on a paid API is worse than a missed digest.
			console.error(`brief failed for ${person.user_id}`, err);
			failed++;
		}
	}

	return new Response(JSON.stringify({ claimed: due?.length ?? 0, sent, failed, deferred }), {
		headers: { 'Content-Type': 'application/json' },
	});
});
