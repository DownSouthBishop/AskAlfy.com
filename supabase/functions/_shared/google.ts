// Hand-rolled Google OAuth token refresh + Gmail/Calendar REST calls, replacing Composio
// for these two providers. Pattern ported from PrymalAI-dashboard's proven getFreshToken.

import type { createClient } from 'npm:@supabase/supabase-js';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

type SupabaseClient = ReturnType<typeof createClient>;

// Returns a live access token for (userId, platform), refreshing via the stored
// refresh_token when the cached one is within 60s of expiring. Returns null if the
// platform was never connected or the refresh fails — callers surface that as
// "not connected yet" rather than throwing.
export async function getFreshToken(supabase: SupabaseClient, userId: string, platform: string): Promise<string | null> {
	const { data, error } = await supabase
		.from('oauth_tokens')
		.select('access_token, refresh_token, expires_at')
		.eq('user_id', userId)
		.eq('platform', platform)
		.single();

	if (error || !data) return null;

	const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : 0;
	if (Date.now() < expiresAt - 60_000) return data.access_token;
	if (!data.refresh_token) return null;

	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: data.refresh_token,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
		}),
	});
	const tokens = await res.json();
	if (!tokens.access_token) return null;

	await supabase.from('oauth_tokens').update({
		access_token: tokens.access_token,
		expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
		updated_at: new Date().toISOString(),
	}).eq('user_id', userId).eq('platform', platform);

	return tokens.access_token;
}

function base64url(input: string): string {
	return btoa(unescape(encodeURIComponent(input)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

interface SendEmailArgs {
	to: string;
	cc?: string | null;
	bcc?: string | null;
	subject: string;
	body: string;
}

function buildRawEmail({ to, cc, bcc, subject, body }: SendEmailArgs): string {
	const headers = [
		`To: ${to}`,
		cc ? `Cc: ${cc}` : null,
		bcc ? `Bcc: ${bcc}` : null,
		`Subject: ${subject}`,
		'Content-Type: text/plain; charset="UTF-8"',
		'MIME-Version: 1.0',
	].filter(Boolean).join('\r\n');
	return base64url(`${headers}\r\n\r\n${body}`);
}

export async function gmailSend(accessToken: string, args: SendEmailArgs) {
	const res = await fetch(`${GMAIL_BASE}/messages/send`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ raw: buildRawEmail(args) }),
	});
	if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
	return await res.json();
}

export async function gmailList(accessToken: string, q: string | undefined, maxResults = 10) {
	const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 20)) });
	if (q) params.set('q', q);

	const listRes = await fetch(`${GMAIL_BASE}/messages?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	const list = await listRes.json();
	if (!list.messages) return [];

	return await Promise.all(
		list.messages.map(async (m: { id: string }) => {
			const res = await fetch(
				`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
				{ headers: { Authorization: `Bearer ${accessToken}` } },
			);
			const msg = await res.json();
			const headers: Record<string, string> = {};
			for (const h of msg.payload?.headers ?? []) headers[h.name] = h.value;
			return { id: msg.id, threadId: msg.threadId, snippet: msg.snippet, from: headers.From, subject: headers.Subject, date: headers.Date };
		}),
	);
}

export async function gmailGetThread(accessToken: string, threadId: string) {
	const res = await fetch(`${GMAIL_BASE}/threads/${threadId}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Gmail thread lookup failed: ${await res.text()}`);
	return await res.json();
}

export async function gmailListLabels(accessToken: string) {
	const res = await fetch(`${GMAIL_BASE}/labels`, { headers: { Authorization: `Bearer ${accessToken}` } });
	const data = await res.json();
	return data.labels ?? [];
}

export async function gmailCreateLabel(accessToken: string, args: { name: string; labelListVisibility?: string; messageListVisibility?: string }) {
	const res = await fetch(`${GMAIL_BASE}/labels`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: args.name,
			labelListVisibility: args.labelListVisibility ?? 'labelShow',
			messageListVisibility: args.messageListVisibility ?? 'show',
		}),
	});
	if (!res.ok) throw new Error(`Gmail create label failed: ${await res.text()}`);
	return await res.json();
}

async function resolveLabelId(accessToken: string, labelName: string): Promise<string> {
	const labels = await gmailListLabels(accessToken);
	const found = labels.find((l: { name: string; id: string }) => l.name.toLowerCase() === labelName.toLowerCase());
	if (found) return found.id;
	const created = await gmailCreateLabel(accessToken, { name: labelName });
	return created.id;
}

async function gmailModifyThread(accessToken: string, threadId: string, body: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
	const res = await fetch(`${GMAIL_BASE}/threads/${threadId}/modify`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Gmail thread modify failed: ${await res.text()}`);
	return await res.json();
}

export async function gmailApplyLabel(accessToken: string, threadIds: string[], labelName: string) {
	const labelId = await resolveLabelId(accessToken, labelName);
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { addLabelIds: [labelId] })));
}

export async function gmailRemoveLabel(accessToken: string, threadIds: string[], labelName: string) {
	const labelId = await resolveLabelId(accessToken, labelName);
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { removeLabelIds: [labelId] })));
}

export async function gmailArchive(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { removeLabelIds: ['INBOX'] })));
}

export async function gmailMarkRead(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { removeLabelIds: ['UNREAD'] })));
}

export async function gmailMarkUnread(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { addLabelIds: ['UNREAD'] })));
}

// Trash (reversible) rather than permanent delete.
export async function gmailTrash(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map(async (id) => {
		const res = await fetch(`${GMAIL_BASE}/threads/${id}/trash`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
		if (!res.ok) throw new Error(`Gmail trash failed: ${await res.text()}`);
	}));
}

interface CreateFilterArgs {
	from?: string;
	to?: string;
	subject?: string;
	query?: string;
	action: 'archive' | 'markRead' | 'star' | 'delete';
	label?: string;
}

export async function gmailCreateFilter(accessToken: string, args: CreateFilterArgs) {
	const criteria: Record<string, string> = {};
	if (args.from) criteria.from = args.from;
	if (args.to) criteria.to = args.to;
	if (args.subject) criteria.subject = args.subject;
	if (args.query) criteria.query = args.query;

	const addLabelIds: string[] = [];
	const removeLabelIds: string[] = [];
	if (args.action === 'archive') removeLabelIds.push('INBOX');
	else if (args.action === 'markRead') removeLabelIds.push('UNREAD');
	else if (args.action === 'star') addLabelIds.push('STARRED');
	else if (args.action === 'delete') addLabelIds.push('TRASH');
	if (args.label) addLabelIds.push(await resolveLabelId(accessToken, args.label));

	const action: Record<string, string[]> = {};
	if (addLabelIds.length) action.addLabelIds = addLabelIds;
	if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;

	const res = await fetch(`${GMAIL_BASE}/settings/filters`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ criteria, action }),
	});
	if (!res.ok) throw new Error(`Gmail create filter failed: ${await res.text()}`);
	return await res.json();
}

interface SetAutoReplyArgs {
	message: string;
	subject?: string;
	startTime?: string;
	endTime?: string;
	restrictToContacts?: boolean;
	restrictToDomain?: boolean;
}

export async function gmailSetAutoReply(accessToken: string, args: SetAutoReplyArgs) {
	const body: Record<string, unknown> = {
		enableAutoReply: true,
		responseBodyPlainText: args.message,
		responseSubject: args.subject,
		restrictToContacts: args.restrictToContacts ?? false,
		restrictToDomain: args.restrictToDomain ?? false,
	};
	if (args.startTime) body.startTime = new Date(args.startTime).getTime();
	if (args.endTime) body.endTime = new Date(args.endTime).getTime();

	const res = await fetch(`${GMAIL_BASE}/settings/vacation`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Gmail set vacation responder failed: ${await res.text()}`);
	return await res.json();
}

// Gmail has no scheduled-send API — save as a draft and tell the person to use
// Gmail's own Schedule Send from there.
export async function gmailCreateDraft(accessToken: string, args: SendEmailArgs) {
	const res = await fetch(`${GMAIL_BASE}/drafts`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ message: { raw: buildRawEmail(args) } }),
	});
	if (!res.ok) throw new Error(`Gmail create draft failed: ${await res.text()}`);
	return await res.json();
}

interface CalendarListArgs {
	timeMin?: string;
	timeMax?: string;
	maxResults?: number;
}

export async function calendarListEvents(accessToken: string, args: CalendarListArgs) {
	const params = new URLSearchParams({
		maxResults: String(Math.min(args.maxResults ?? 10, 25)),
		singleEvents: 'true',
		orderBy: 'startTime',
	});
	if (args.timeMin) params.set('timeMin', args.timeMin);
	if (args.timeMax) params.set('timeMax', args.timeMax);

	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	const data = await res.json();
	return (data.items ?? []).map((e: Record<string, unknown>) => ({
		id: e.id,
		summary: e.summary,
		start: e.start,
		end: e.end,
		location: e.location,
		attendees: e.attendees,
	}));
}

interface CreateEventArgs {
	title: string;
	startTime: string;
	endTime: string;
	location?: string | null;
	attendees?: string[] | null;
	description?: string | null;
}

export async function calendarCreateEvent(accessToken: string, args: CreateEventArgs) {
	const body = {
		summary: args.title,
		location: args.location ?? undefined,
		description: args.description ?? undefined,
		start: { dateTime: args.startTime },
		end: { dateTime: args.endTime },
		attendees: (args.attendees ?? []).map((email) => ({ email })),
	};
	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Calendar create failed: ${await res.text()}`);
	return await res.json();
}

export async function calendarUpdateEvent(accessToken: string, eventId: string, args: Partial<CreateEventArgs>) {
	const body: Record<string, unknown> = {};
	if (args.title !== undefined) body.summary = args.title;
	if (args.location !== undefined) body.location = args.location;
	if (args.description !== undefined) body.description = args.description;
	if (args.startTime !== undefined) body.start = { dateTime: args.startTime };
	if (args.endTime !== undefined) body.end = { dateTime: args.endTime };
	if (args.attendees !== undefined) body.attendees = (args.attendees ?? []).map((email) => ({ email }));

	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Calendar update failed: ${await res.text()}`);
	return await res.json();
}

export async function calendarDeleteEvent(accessToken: string, eventId: string) {
	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	// 410 Gone means it was already deleted — treat as success.
	if (!res.ok && res.status !== 410) throw new Error(`Calendar delete failed: ${await res.text()}`);
}

export async function calendarScheduleMeet(accessToken: string, args: CreateEventArgs) {
	const body = {
		summary: args.title,
		location: args.location ?? undefined,
		description: args.description ?? undefined,
		start: { dateTime: args.startTime },
		end: { dateTime: args.endTime },
		attendees: (args.attendees ?? []).map((email) => ({ email })),
		conferenceData: {
			createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
		},
	};
	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?conferenceDataVersion=1`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Calendar schedule meet failed: ${await res.text()}`);
	return await res.json();
}

export async function calendarGetAvailability(accessToken: string, args: { timeMin: string; timeMax: string }) {
	const res = await fetch(`${CALENDAR_BASE}/freeBusy`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ timeMin: args.timeMin, timeMax: args.timeMax, items: [{ id: 'primary' }] }),
	});
	if (!res.ok) throw new Error(`Calendar freebusy failed: ${await res.text()}`);
	const data = await res.json();
	return data.calendars?.primary?.busy ?? [];
}
