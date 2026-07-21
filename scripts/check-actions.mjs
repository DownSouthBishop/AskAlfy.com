#!/usr/bin/env node
// The read/write gate is the approval boundary — if isReadOnly() ever calls a write "read",
// something sends without anyone saying yes. That is worth a real check.
//
// Run: npm run check:actions

import assert from 'node:assert/strict';
import { isReadOnly } from '../supabase/functions/_shared/actions.ts';
import { actionFields, actionSummary, kindOf } from '../supabase/functions/_shared/actions.ts';

// ── reads: must run without approval ─────────────────────────────────────────
for (const slug of [
	'GMAIL_FETCH_EMAILS',
	'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
	'GOOGLECALENDAR_FIND_EVENT',
	'GOOGLECALENDAR_FREE_BUSY_QUERY',      // verb is last
	'GOOGLESHEETS_VALUES_GET',             // verb is last
	'SLACK_FETCH_CONVERSATION_HISTORY',
	'SLACK_LIST_UNREAD_CHANNEL_MESSAGES',  // verb is second
	'SLACK_GET_UNREAD_MESSAGES_FROM_USER',
	'NOTION_SEARCH_PAGES',
]) {
	assert.equal(isReadOnly(slug), true, `${slug} should be read-only`);
}

// ── writes: must be queued for approval ──────────────────────────────────────
for (const slug of [
	'GMAIL_SEND_EMAIL',
	'GOOGLECALENDAR_CREATE_EVENT',
	'GOOGLECALENDAR_DELETE_EVENT',
	'GOOGLESHEETS_VALUES_UPDATE',
	'GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER',
	'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
	'GOOGLEDRIVE_DELETE_FILE',
	'STRIPE_CREATE_REFUND',
]) {
	assert.equal(isReadOnly(slug), false, `${slug} must require approval`);
}

// ── the important one: unknown verbs fail SAFE, toward approval ──────────────
// A toolkit we've never seen must not get a free pass to act.
for (const slug of [
	'ACME_YEET_THE_THING',
	'NEWAPP_DOSOMETHING',
	'WEIRD',
	'',
]) {
	assert.equal(isReadOnly(slug), false, `unknown verb "${slug}" must fail closed`);
}

// A read verb does NOT rescue a slug that also mutates.
assert.equal(isReadOnly('GMAIL_GET_AND_DELETE_THREAD'), false, 'mixed verbs must fail closed');

// ── the card describes the action it actually queued ─────────────────────────
const emailPayload = { recipient_email: 'dana@northbridge.com', subject: 'Re: Thursday', body: 'Thursday works.' };
const fields = actionFields(emailPayload);
assert.deepEqual(
	fields.map((f) => [f.label, f.value]),
	[['Recipient email', 'dana@northbridge.com'], ['Subject', 'Re: Thursday'], ['Body', 'Thursday works.']],
);
assert.match(actionSummary('GMAIL_SEND_EMAIL', emailPayload), /^Send email — dana@northbridge\.com · Re: Thursday$/);
assert.equal(kindOf('SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL'), 'Slack');
assert.equal(kindOf('ACME_DO_A_THING'), 'Acme', 'unknown toolkits still render a sensible label');

// Long values are clipped, not dumped, so a card can't become a wall of JSON.
const long = actionFields({ text: 'x'.repeat(500) })[0].value;
assert.ok(long.length <= 240 && long.endsWith('…'), 'long values are clipped');

// Arrays read as lists, not [object Object].
assert.equal(actionFields({ attendees: ['a@x.com', 'b@x.com'] })[0].value, 'a@x.com, b@x.com');

console.log('✓ action + approval-gate checks passed');
