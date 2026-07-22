#!/usr/bin/env node
// The night note is a receipt — what it says Alfy did, Alfy did. Nothing in it is written by
// a model, so the entire risk surface is this one pure function. That is worth a real check.
//
// Run: npm run check:recap

import assert from 'node:assert/strict';
import { composeRecap } from '../supabase/functions/_shared/recap.ts';

const row = (status, extra = {}) => ({
	summary: 'Send Email — dana@example.com · Re: Thursday',
	status,
	standing_permission_id: null,
	...extra,
});

// ── a day where nothing happened sends nothing ───────────────────────────────
assert.equal(composeRecap([], null), null);
assert.equal(composeRecap([row('skipped'), row('executing')], null), null, 'skipped/in-flight rows are not news');

// ── pending is reported however old, and carries the way in ──────────────────
{
	const body = composeRecap([row('pending')], 'https://askalfy.com/a?t=abc');
	assert.match(body, /^Still waiting on you:/);
	assert.match(body, /Open: https:\/\/askalfy\.com\/a\?t=abc/);
}
{
	const body = composeRecap([row('pending'), row('pending'), row('pending')], 'L');
	assert.match(body, /and 2 more\./);
}

// ── failures always surface ──────────────────────────────────────────────────
assert.match(composeRecap([row('failed')], null), /didn't go through/);
assert.match(composeRecap([row('executed'), row('failed')], null), /didn't go through/);

// ── autonomy is attributed, never silent ─────────────────────────────────────
{
	const body = composeRecap([row('executed'), row('executed', { standing_permission_id: 'p1' })], null);
	assert.match(body, /Did 2 things today/);
	assert.match(body, /One of those without asking/);
}

// ── the constitution's shape: 5 lines max, and it has to fit in a text ───────
{
	const many = [
		...Array.from({ length: 6 }, () => row('executed')),
		...Array.from({ length: 3 }, () => row('executed', { standing_permission_id: 'p1' })),
		...Array.from({ length: 4 }, () => row('failed')),
		...Array.from({ length: 5 }, () => row('pending')),
	];
	const body = composeRecap(many, 'https://askalfy.com/a?t=' + 'x'.repeat(40));
	assert.equal(body.split('\n').length, 5, 'never more than five lines');
	assert.ok(body.length <= 480, `recap too long for 3 segments: ${body.length}`);
	assert.equal(body.endsWith('\n— A'), true);
}

// ── long summaries get clipped, not wrapped ──────────────────────────────────
{
	const body = composeRecap([row('pending', { summary: 'Send Email — ' + 'y'.repeat(200) })], null);
	assert.ok(body.includes('…'), 'an overlong summary is clipped');
	assert.ok(body.length < 120);
}

console.log('recap ok');
