// Minting an access link IS the approval channel — a token that hands an SMS off into an
// authenticated dashboard session. Two callers now (the reply to a text, the night note)
// with different lifetimes, so the token and its TTL live in one place rather than drifting
// apart in two files.

import type { Supa } from './agent.ts';

export function randomToken() {
	return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

// approvalId null = "just open the dashboard" (see access_links in 0001). A digest needs one
// link, not one per item: Today already lists everything pending.
export async function mintLink(
	supa: Supa,
	userId: string,
	approvalId: string | null,
	ttlMs: number,
): Promise<string> {
	const token = randomToken();
	await supa.from('access_links').insert({
		user_id: userId,
		approval_id: approvalId,
		token,
		expires_at: new Date(Date.now() + ttlMs).toISOString(),
	});
	return token;
}
