// The daily-text-cap decision, pure and testable. `used` is today's inbound count INCLUDING
// the message being handled; `cap` is the user's daily_text_cap.
//
//   run    — under the cap, run the agent normally
//   notice — first message over the cap: tell them once, don't run the agent
//   silent — already told them today: drop it, no outbound (bounds a spammer's cost)
//
// Enforced BEFORE runAgent so an over-cap message never reaches the paid model. See
// scripts/check-metering.mjs; the ladder that sets the caps is scripts/unit-economics.mjs.
export type CapAction = 'run' | 'notice' | 'silent';

export function capDecision(used: number, cap: number): CapAction {
	if (used <= cap) return 'run';
	if (used === cap + 1) return 'notice';
	return 'silent';
}

// Alfy's voice: plain, no exclamation, no urgency or guilt, sign "— A". Nudges to upgrade
// without pushing — features are flat, so the only reason to move up is more room.
export function capNotice(cap: number): string {
	return `That's your ${cap} texts for today. I'll pick right back up tomorrow. ` +
		`Want more room sooner? You can bump your plan any time in the dashboard. — A`;
}
