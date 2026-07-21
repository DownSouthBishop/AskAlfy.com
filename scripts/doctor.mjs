#!/usr/bin/env node
// `npm run doctor` — the setup checklist, as a command.
//
// Every ✗ carries the exact command that turns it green. Work top to bottom until it's
// all ✓, then run the smoke test in docs/alfy-handoff.md. Zero dependencies on purpose:
// this has to run before anything is configured.
//
// `node scripts/doctor.mjs --placeholders` is the prebuild gate — it checks only the
// things that would ship broken, and fails the build on CI (never on a local build, so
// the demo-data dev loop keeps working with zero setup).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const strictOnly = process.argv.includes('--placeholders');
const isCI = Boolean(process.env.CI || process.env.VERCEL || process.env.NETLIFY);

const rows = [];
const ok = (label, detail = '') => rows.push({ state: 'ok', label, detail });
const bad = (label, fix) => rows.push({ state: 'bad', label, fix });
const skip = (label, why) => rows.push({ state: 'skip', label, detail: why });

const read = (rel) => (existsSync(resolve(ROOT, rel)) ? readFileSync(resolve(ROOT, rel), 'utf8') : null);

function sh(cmd, args) {
	try {
		return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch {
		return null;
	}
}

// ── 1. Placeholders that would ship broken ───────────────────────────────────
const config = read('src/lib/config.ts') ?? '';
const phoneLine = config.match(/^export const ALFY_PHONE = '(.*)';$/m);
const placeholder = config.match(/^export const PLACEHOLDER_PHONE = '(.*)';$/m)?.[1];

if (!phoneLine) bad('ALFY_PHONE', 'could not parse src/lib/config.ts — is the export still there?');
else if (phoneLine[1] === placeholder) {
	bad('ALFY_PHONE', `still ${placeholder} → set the real Twilio number in src/lib/config.ts:9`);
} else ok('ALFY_PHONE', phoneLine[1]);

if (strictOnly) {
	report();
	const broken = rows.some((r) => r.state === 'bad');
	if (broken && isCI) process.exit(1);
	process.exit(0);
}

// ── 2. Frontend env ──────────────────────────────────────────────────────────
const envFile = read('.env.local');
if (!envFile) {
	bad('.env.local', 'cp .env.local.example .env.local');
} else {
	const env = Object.fromEntries(
		envFile.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'))
			.map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
	);
	for (const [key, shape] of [
		['PUBLIC_SUPABASE_URL', /^https:\/\/[a-z0-9]+\.supabase\.co$/],
		['PUBLIC_SUPABASE_ANON_KEY', /^.{40,}$/],
		['PUBLIC_APP_URL', /^https?:\/\/.+/],
	]) {
		if (!env[key]) bad(key, `set it in .env.local (site runs on demo data until then)`);
		else if (!shape.test(env[key])) bad(key, `set but malformed: ${env[key].slice(0, 30)}…`);
		else ok(key);
	}
	globalThis.__alfyEnv = env;
}

// ── 3. Supabase project: linked, migrated, secrets, functions ────────────────
const migrations = sh('supabase', ['migration', 'list']);

if (!migrations) {
	skip('supabase link', 'not linked (or CLI unavailable) → supabase link --project-ref <ref>');
	skip('migrations', 'needs a linked project');
	skip('secrets', 'needs a linked project');
} else {
	ok('supabase link');
	// `migration list` prints Local | Remote columns; a row with a local version and a
	// blank remote is an unapplied migration.
	const unapplied = migrations.split('\n')
		.filter((l) => /^\s*\d{4}\w*\s*\|\s*\|/.test(l))
		.map((l) => l.split('|')[0].trim());
	if (unapplied.length) bad('migrations', `${unapplied.join(', ')} not applied → supabase db push`);
	else ok('migrations', 'all applied');

	const REQUIRED_SECRETS = [
		'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
		'ANTHROPIC_API_KEY',
		'COMPOSIO_API_KEY', 'COMPOSIO_AUTHCFG_GMAIL', 'COMPOSIO_AUTHCFG_CALENDAR',
		'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
		'PUBLIC_APP_URL',
	];
	const secretList = sh('supabase', ['secrets', 'list']) ?? '';
	const missing = REQUIRED_SECRETS.filter((s) => !secretList.includes(s));
	if (missing.length) bad('secrets', `missing → supabase secrets set ${missing.map((m) => `${m}=...`).join(' ')}`);
	else ok('secrets', `all ${REQUIRED_SECRETS.length} set`);
}

// ── 4. Functions deployed ────────────────────────────────────────────────────
const FUNCTIONS = ['alfy-agent', 'alfy-sms-inbound', 'alfy-link', 'alfy-approve', 'alfy-connect'];
const supaUrl = globalThis.__alfyEnv?.PUBLIC_SUPABASE_URL;

if (!supaUrl) {
	skip('functions', 'needs PUBLIC_SUPABASE_URL');
} else {
	// A deployed function rejects an unauthenticated POST (401/403); a missing one 404s.
	await Promise.all(FUNCTIONS.map(async (fn) => {
		try {
			const res = await fetch(`${supaUrl}/functions/v1/${fn}`, { method: 'POST' });
			if (res.status === 404) bad(`fn ${fn}`, `not deployed → supabase functions deploy ${fn}`);
			else ok(`fn ${fn}`, `deployed (${res.status})`);
		} catch {
			skip(`fn ${fn}`, 'unreachable');
		}
	}));
}

report();
process.exit(rows.some((r) => r.state === 'bad') ? 1 : 0);

function report() {
	const mark = { ok: '✓', bad: '✗', skip: '–' };
	const width = Math.max(...rows.map((r) => r.label.length)) + 2;
	console.log('');
	for (const r of rows) {
		const tail = r.state === 'bad' ? r.fix : r.detail;
		console.log(`  ${mark[r.state]} ${r.label.padEnd(width)}${tail ?? ''}`);
	}
	const broken = rows.filter((r) => r.state === 'bad').length;
	console.log('');
	console.log(broken ? `  ${broken} left. Fix the ✗ lines above, then re-run.` : '  All green. Run the smoke test in docs/alfy-handoff.md.');
	console.log('');
}
