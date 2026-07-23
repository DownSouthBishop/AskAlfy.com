// alfy-recap — the night note. The other half of the daily brief: alfy-brief reads the
// world at 7am, this reads Alfy's own ledger in the evening and reports what it did with it.
//
// pg_cron ticks this hourly (see 0006_night_note.sql); each tick sends to whoever's local
// hour is the one before their quiet hours start. Auth is the same shared secret as the
// brief — no human in the loop at 8pm either. Deploy with --no-verify-jwt.
//
// No model call anywhere in here (see _shared/recap.ts), so there is no wall-clock budget to
// juggle: a batch is 20 selects and 20 sends, not 20 inferences.

import { createClient } from 'npm:@supabase/supabase-js';
import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { mintLink } from '../_shared/links.ts';
import { composeRecap, type RecapRow } from '../_shared/recap.ts';
import { sendSms, SMS_FROM } from '../_shared/sms.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const RUNNER_SECRET = requireEnv('INTERNAL_FUNCTION_SECRET');
const APP_URL = optionalEnv('PUBLIC_APP_URL', 'https://askalfy.com');

const BATCH = 20;

// Since the last note, not since local midnight. The note goes out in the evening, so a
// midnight boundary would silently swallow everything decided between the send and 00:00 —
// it would belong to neither day's window. 24h of lookback on a 24h cadence has no seam.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Long enough to still work if they read it after dinner, short enough to be dead before the
// morning brief. The token only authenticates the handoff — approving still takes a tap.
const LINK_TTL_MS = 4 * 60 * 60 * 1000;

Deno.serve(async (req) => {
	if (req.headers.get('x-runner-key') !== RUNNER_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

	const { data: due, error } = await supa.rpc('claim_recaps', { p_limit: BATCH });
	if (error) {
		console.error('claim_recaps failed', error);
		return new Response(JSON.stringify({ error: error.message }), { status: 500 });
	}

	const since = new Date(Date.now() - WINDOW_MS).toISOString();
	let sent = 0;
	let quiet = 0;
	let failed = 0;

	for (const person of (due ?? []) as { recap_user_id: string; recap_phone: string }[]) {
		try {
			// Pending is deliberately un-windowed while executed/failed are last-24h only.
			// decided_at is the right clock for both of those: it is set on approve, on skip,
			// and on an autonomous action, whereas executed_at is null on anything that failed.
			const { data: rows, error: rowsErr } = await supa
				.from('approval_queue')
				.select('summary, status, standing_permission_id')
				.eq('user_id', person.recap_user_id)
				.or(`status.eq.pending,and(status.in.(executed,failed),decided_at.gte.${since})`)
				.order('decided_at', { ascending: true, nullsFirst: true })
				.order('created_at', { ascending: true })
				.limit(50);
			if (rowsErr) throw new Error(rowsErr.message);

			// Pending first (decided_at null), oldest of those first; then the day's decisions
			// in the order they happened, so "latest" really is the last thing Alfy did.
			const ledger = (rows ?? []) as RecapRow[];
			const link = ledger.some((r) => r.status === 'pending')
				? `${APP_URL}/a?t=${await mintLink(supa, person.recap_user_id, null, LINK_TTL_MS)}`
				: null;

			const body = composeRecap(ledger, link);
			if (!body) {
				quiet++;
				continue;
			}

			const segments = await sendSms(person.recap_phone, body);
			await supa.from('messages').insert({
				user_id: person.recap_user_id,
				from_phone: SMS_FROM,
				direction: 'outbound',
				body,
				segments: segments || 1,
			});
			sent++;
		} catch (err) {
			// Already claimed, so this person just waits for tomorrow — same trade as the brief.
			console.error(`recap failed for ${person.recap_user_id}`, err);
			failed++;
		}
	}

	return new Response(JSON.stringify({ claimed: due?.length ?? 0, sent, quiet, failed }), {
		headers: { 'Content-Type': 'application/json' },
	});
});
