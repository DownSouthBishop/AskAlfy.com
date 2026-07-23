#!/usr/bin/env node
// The daily cap is what makes the $20 tier safe — it guarantees the margin floor by stopping
// an over-cap text before it reaches the paid model. The whole decision is this one pure
// function; a bad edit here either leaks money (never caps) or annoys everyone (caps too
// early / notices every message). That is worth a real check.
//
// Run: npm run check:metering

import assert from 'node:assert/strict';
import { capDecision, capNotice } from '../supabase/functions/_shared/metering.ts';

const CAP = 10; // the $20 Alfy tier

// ── under the cap: every message runs ────────────────────────────────────────
assert.equal(capDecision(1, CAP), 'run', 'first message of the day runs');
assert.equal(capDecision(CAP, CAP), 'run', 'the Nth message (== cap) still runs — exactly cap runs allowed');

// ── over the cap: notice exactly once, then silence ──────────────────────────
assert.equal(capDecision(CAP + 1, CAP), 'notice', 'first over-cap message gets the notice');
assert.equal(capDecision(CAP + 2, CAP), 'silent', 'second over-cap message is silent — bounds a spammer');
assert.equal(capDecision(CAP + 50, CAP), 'silent', 'still silent far past the cap');

// ── the count includes the current message, so cap N allows exactly N runs ────
const runs = Array.from({ length: 20 }, (_, i) => capDecision(i + 1, CAP)).filter((a) => a === 'run').length;
assert.equal(runs, CAP, `exactly ${CAP} agent runs permitted per day`);

// ── notices happen once, never more, across a busy day ───────────────────────
const notices = Array.from({ length: 20 }, (_, i) => capDecision(i + 1, CAP)).filter((a) => a === 'notice').length;
assert.equal(notices, 1, 'at most one cap notice per day, no matter how many texts');

// ── other tiers behave the same shape ────────────────────────────────────────
assert.equal(capDecision(20, 20), 'run', 'plus tier: 20/day');
assert.equal(capDecision(21, 20), 'notice');
assert.equal(capDecision(40, 40), 'run', 'pro tier: 40/day');
assert.equal(capDecision(41, 40), 'notice');

// ── the notice is a real string that names the cap and stays in voice ────────
assert.match(capNotice(CAP), new RegExp(`${CAP} texts`), 'notice names the cap');
assert.match(capNotice(CAP), /— A$/, 'notice signs off in Alfy voice');
assert.doesNotMatch(capNotice(CAP), /[!]/, 'no exclamation marks — house voice');

console.log('metering check ok');
