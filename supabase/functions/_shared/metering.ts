// The daily text cap on paid plans. _shared/billing.ts answers "may this account use Alfy
// at all"; this answers "has it used it enough today". Both run before the agent, so an
// over-cap text never reaches the model.
//
// Every plan gets every tool — a plan buys room, not features (0009_plan_caps.sql).
// Type-only so the cap logic below stays runnable outside Deno — scripts/check-metering.mjs
// imports this file directly.
import type { SupabaseClient } from 'npm:@supabase/supabase-js';

// Texts per day, by plan. A person on Alfy at $25 sending 15 texts a day, every day, with
// each text costing a few Haiku turns, still leaves the subscription well ahead — the
// prompt caching in _shared/agent.ts is what makes that true, since the loop's prefix is
// re-read at ~0.1x rather than re-sent at full price. Re-derive these if the model or its
// pricing changes; they are the only two numbers to touch.
const CAP_BY_PLAN: Record<string, number> = {
	active: 15,
	plus: 45,
};

// The trial has its own caps in billing.ts and never reaches here.
export function capFor(plan: string, override: number | null | undefined): number | null {
	if (override != null) return override;
	return CAP_BY_PLAN[plan] ?? null;
}

// `used` is today's inbound count INCLUDING the text being handled.
//
//   run    — under the cap, run the agent normally
//   notice — first text over the cap: say so once, don't run the agent
//   silent — already said so today: drop it, no outbound at all, so someone hammering the
//            number can't turn our cap into an unbounded outbound SMS bill
export type CapAction = 'run' | 'notice' | 'silent';

export function capDecision(used: number, cap: number): CapAction {
	if (used <= cap) return 'run';
	if (used === cap + 1) return 'notice';
	return 'silent';
}

// Alfy's voice: plain words, no exclamation, no urgency, no guilt. Sign "— A".
export function capNotice(cap: number): string {
	return `That's your ${cap} texts for today. I'll pick right back up tomorrow. ` +
		`Want more room sooner? You can move up a plan any time in the dashboard. — A`;
}

// Returns null when the plan has no cap and nothing needs to happen.
export async function checkDailyCap(
	supa: SupabaseClient,
	userId: string,
	plan: string,
): Promise<{ action: CapAction; cap: number } | null> {
	const { data: user } = await supa.from('users').select('daily_text_cap').eq('id', userId).single();
	const cap = capFor(plan, user?.daily_text_cap as number | null);
	if (cap == null) return null;

	const { data: used } = await supa.rpc('daily_inbound_count', { p_user: userId });
	// A failed count must not lock someone out of the product they paid for.
	if (typeof used !== 'number') return null;

	return { action: capDecision(used, cap), cap };
}
