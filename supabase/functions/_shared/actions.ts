// Turning a Composio tool call into something a person can say yes to.
//
// The approval card used to show a summary the MODEL wrote, while action_payload held what
// would actually fire. Those could disagree — you'd approve "Reply to Dana" and something
// else would send. Everything here is derived from the slug and the payload instead, so the
// card cannot describe an action other than the one queued.

// ─────────────────────────────────────────────────────────────────────────────
// Read vs write — the approval boundary, decided generically.
//
// Composio tool metadata carries no read/write flag (only tags, scopes, no_auth), so this
// has to be inferred from the slug. Two rules keep that honest:
//   1. A slug counts as read-only only if it names a read verb AND names no write verb.
//      Verbs appear anywhere in a slug — GOOGLESHEETS_VALUES_GET ends with one,
//      SLACK_LIST_UNREAD_CHANNEL_MESSAGES has it second — so match tokens, not prefixes.
//   2. Anything unrecognised is treated as a WRITE. A newly connected toolkit with
//      unfamiliar naming gets queued for approval, never executed silently. The failure
//      mode is a needless tap, never an unapproved send.
//
// This module has no imports on purpose: it is the one piece of logic the agent, the
// approval executor, the dashboard, and the tests all have to agree on.
// ─────────────────────────────────────────────────────────────────────────────
const READ_VERBS = new Set([
	'GET', 'FETCH', 'LIST', 'SEARCH', 'READ', 'FIND', 'QUERY', 'CHECK',
	'RETRIEVE', 'COUNT', 'DOWNLOAD', 'EXPORT', 'VIEW', 'LOOKUP', 'DESCRIBE',
]);

const WRITE_VERBS = new Set([
	'SEND', 'SENDS', 'CREATE', 'UPDATE', 'DELETE', 'REMOVE', 'ADD', 'POST', 'WRITE',
	'SET', 'MOVE', 'RENAME', 'ARCHIVE', 'INVITE', 'SHARE', 'UPLOAD', 'APPEND',
	'CLEAR', 'PATCH', 'MODIFY', 'MARK', 'REPLY', 'DRAFT', 'INSERT', 'UNARCHIVE',
	'ASSIGN', 'CANCEL', 'CLOSE', 'MERGE', 'PUBLISH', 'SCHEDULE', 'PAY', 'BUY',
	'ORDER', 'REFUND', 'TRANSFER', 'REVOKE', 'GRANT', 'ENABLE', 'DISABLE', 'DUPLICATE',
]);

export function isReadOnly(slug: string): boolean {
	const tokens = slug.toUpperCase().split('_');
	if (tokens.some((t) => WRITE_VERBS.has(t))) return false;
	return tokens.some((t) => READ_VERBS.has(t));
}

// Toolkit prefix → the card's label. Unknown toolkits fall back to a tidied prefix, so a
// newly connected app still renders sensibly with no code change.
const KIND_BY_TOOLKIT: Record<string, string> = {
	GMAIL: 'Email',
	GOOGLECALENDAR: 'Calendar',
	GOOGLEDRIVE: 'File',
	GOOGLESHEETS: 'Spreadsheet',
	GOOGLEDOCS: 'Document',
	SLACK: 'Slack',
	NOTION: 'Notion',
	LINEAR: 'Linear',
	GITHUB: 'GitHub',
	STRIPE: 'Payment',
};

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function toolkitOf(slug: string): string {
	return slug.split('_')[0] ?? '';
}

export function kindOf(slug: string): string {
	const tk = toolkitOf(slug);
	return KIND_BY_TOOLKIT[tk] ?? title(tk);
}

// "GMAIL_SEND_EMAIL" → "Send email". The toolkit prefix is dropped because the card already
// shows it as the kind.
export function actionPhrase(slug: string): string {
	const words = slug.split('_').slice(1);
	if (!words.length) return title(slug);
	return title(words.join(' '));
}

// Payload keys worth showing, in the order a person would want to read them. Checked in
// order and the first match per group wins, so one field can't crowd out the others.
const FIELD_GROUPS: string[][] = [
	['recipient_email', 'to', 'email', 'channel', 'user_id', 'attendees', 'spreadsheetId', 'spreadsheet_id', 'fileId'],
	['subject', 'summary', 'title', 'name', 'range'],
	['body', 'text', 'message', 'content', 'description', 'values'],
	['start_datetime', 'start_time', 'date', 'timezone', 'amount'],
];

function render(value: unknown): string {
	if (value == null) return '';
	if (Array.isArray(value)) return value.map(render).filter(Boolean).join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export interface ActionField {
	label: string;
	value: string;
}

// The lines the approval card renders. Derived, never model-written.
export function actionFields(payload: Record<string, unknown>): ActionField[] {
	const out: ActionField[] = [];
	for (const group of FIELD_GROUPS) {
		for (const key of group) {
			if (!(key in payload)) continue;
			const value = render(payload[key]);
			if (!value) continue;
			out.push({ label: title(key.replace(/[_-]/g, ' ')), value: clip(value, 240) });
			break;
		}
	}
	return out;
}

// One line for the SMS and the card headline: "Send email — to dana@acme.com · Thursday works"
export function actionSummary(slug: string, payload: Record<string, unknown>): string {
	const detail = actionFields(payload).slice(0, 2).map((f) => f.value).join(' · ');
	const phrase = actionPhrase(slug);
	return detail ? `${phrase} — ${clip(detail, 120)}` : phrase;
}

// ─────────────────────────────────────────────────────────────────────────────
// Earned autonomy — see 0005_earned_autonomy.sql.
//
// A standing permission is keyed on the tool AND what it targets, because scope is the
// whole safety story. "Always send emails" is a frightening thing to grant; "always send
// replies to Dana" is a comfortable one. The target is the first field the card shows —
// recipient, channel, spreadsheet — so the permission covers exactly what the person has
// been looking at each time they said yes.
//
// Null means "not eligible": no identifiable target, so no scope narrow enough to trust.
// ─────────────────────────────────────────────────────────────────────────────
export function scopeKey(slug: string, payload: Record<string, unknown>): string | null {
	const target = actionFields(payload)[0]?.value;
	if (!target) return null;
	return `${slug.toUpperCase()}:${target.toLowerCase()}`;
}

// Some things never graduate, however many times you approve them. Routine sends can earn
// autonomy; irreversible and financial ones don't get to. A misfiring habit that emails the
// wrong person is recoverable — one that deletes a drive or moves money is not.
const NEVER_AUTOMATE = new Set([
	'DELETE', 'REMOVE', 'PAY', 'BUY', 'ORDER', 'REFUND', 'TRANSFER',
	'REVOKE', 'GRANT', 'ARCHIVE', 'CLEAR', 'MERGE', 'CANCEL',
]);

export function canEarnAutonomy(slug: string): boolean {
	return !slug.toUpperCase().split('_').some((t) => NEVER_AUTOMATE.has(t));
}

// The longer preview, when the payload carries something the person should actually read.
export function actionDraft(payload: Record<string, unknown>): string | null {
	for (const key of ['body', 'text', 'message', 'content', 'description']) {
		const value = payload[key];
		if (typeof value === 'string' && value.trim()) return value;
	}
	return null;
}
