// The daily-cap decision is a three-way branch on two boundaries, and getting either off by
// one either lets a maxed-out account keep spending or texts someone the same notice all day.
// Run: node --experimental-strip-types scripts/check-metering.mjs
import assert from 'node:assert/strict';
import { capDecision, capFor } from '../supabase/functions/_shared/metering.ts';

const CAP = 15;

assert.equal(capDecision(1, CAP), 'run');
assert.equal(capDecision(CAP, CAP), 'run', 'the cap-th text is included, not rejected');
assert.equal(capDecision(CAP + 1, CAP), 'notice', 'first one over says so, once');
assert.equal(capDecision(CAP + 2, CAP), 'silent', 'no second notice, no outbound');
assert.equal(capDecision(CAP + 900, CAP), 'silent');

assert.equal(capFor('active', null), 15);
assert.equal(capFor('plus', null), 45);
assert.equal(capFor('active', 40), 40, 'a per-account override wins');
assert.equal(capFor('active', 0), 0, 'zero is an override, not a missing value');
assert.equal(capFor('trial', null), null, 'the trial is capped by billing.ts, not here');
assert.equal(capFor('canceled', null), null);

console.log('metering: ok');
