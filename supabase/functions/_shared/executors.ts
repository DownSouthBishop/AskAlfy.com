// The action_type → real API call switch. Extracted from alfy-approve so a second caller —
// the standing-permission auto-execute path in _shared/agent.ts's queue() — can replay the
// exact same executors without a human tap. Two callers, one place these ever fire from.
//
// Every outbound action is now a Composio-backed app (Gmail/Calendar/Drive/Docs/Sheets via
// 'googlesuper', Slack, Notion, GitHub, Outlook, Linear, Trello, Asana, HubSpot, Discord,
// Zoom) — action_type is always `composio:<toolName>`, queued by _shared/agent.ts's
// isComposioTool branch. This is the only place a write actually reaches Composio: both
// callers get here only after a "yes" already happened — a tap on Approve, or a standing
// permission granted earlier (itself a yes, just a durable one).

import type { createClient } from 'npm:@supabase/supabase-js';
import { executeComposioTool } from './composio.ts';

type SupabaseClient = ReturnType<typeof createClient>;

export class UnknownActionError extends Error {}

export async function executeAction(
	_supa: SupabaseClient,
	userId: string,
	actionType: string,
	actionPayload: Record<string, unknown>,
	_draftContent: string | null,
): Promise<{ confirmationText?: string }> {
	if (actionType.startsWith('composio:')) {
		await executeComposioTool(userId, actionType.slice('composio:'.length), actionPayload);
		return {};
	}
	throw new UnknownActionError(`no executor for '${actionType}' yet — nothing was performed`);
}
