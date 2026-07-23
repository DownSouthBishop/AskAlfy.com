// What one Alfy user costs per month, and therefore how low the price can go.
//
// Every number below is an assumption you can argue with — they are named, not buried.
// Run: node scripts/unit-economics.mjs   (add --check for the self-test)
//
// Structure mirrors the actual bill: inference (agent.ts), SMS (sms.ts),
// tool calls (composio.ts), and the flat platform cost spread over the user base.

// ── Unit prices (USD) ────────────────────────────────────────────────────────
// Anthropic, per 1M tokens. Sonnet 5 standard rate — the $2/$10 intro expires 2026-08-31,
// so pricing on the intro rate would be pricing on a cliff.
const HAIKU_IN = 1.00, HAIKU_OUT = 5.00;
const SONNET_IN = 3.00, SONNET_OUT = 15.00;

// We are NOT locked to Twilio. Two parts to the per-segment cost:
//   aggregator markup — Twilio ~$0.0079, Bandwidth/Telnyx ~$0.004. This we CAN cut.
//   A2P 10DLC surcharge — ~$0.003, charged by the mobile carriers, passed through by every
//                         aggregator. This we CANNOT cut without leaving SMS.
// So the cheaper-carrier floor is markup + surcharge, not markup alone.
// Per-segment all-in rates (base + blended A2P carrier surcharge), US 10DLC, 2026.
// The carrier surcharge (~$0.003) is unavoidable on any provider; the BASE is where they
// differ. Telnyx runs its own network and undercuts the aggregators roughly 2x.
const CARRIERS = {
	telnyx: { out: 0.004 + 0.003, in: 0.004 },   // $0.007 out — cheapest quality option
	plivo:  { out: 0.0077 + 0.0042, in: 0.0055 }, // $0.012 out
	sinch:  { out: 0.0078 + 0.004, in: 0.0060 },  // ~$0.012 out
	twilio: { out: 0.0083 + 0.004, in: 0.0079 },  // $0.012 out — the incumbent, priciest
};
const DEFAULT_CARRIER = 'telnyx';
const SMS_OUT = CARRIERS[DEFAULT_CARRIER].out;
const SMS_IN = CARRIERS[DEFAULT_CARRIER].in;
const SEGMENTS_PER_REPLY = 2;

// Composio "Ridiculously Cheap": $29/mo for 200k tool calls, then $0.299/1k.
const COMPOSIO_PER_CALL = 0.299 / 1000;

// ── Per-turn shape (from supabase/functions/_shared/agent.ts) ────────────────
// The loop re-sends the whole history every round and there is NO prompt caching,
// so input tokens are quadratic in rounds. This is where the money goes.
const ROUNDS_PER_TURN = 4;           // MAX_TURNS is 14; real turns run 3-6
const PROMPT_TOKENS = 1500;          // system + 3 tool schemas + Composio assistive prompt
const TOOL_RESULT_TOKENS = 3000;     // find_tools schemas / a read's payload, per round
const OUT_TOKENS_PER_ROUND = 200;
// Capping Alfy's reply length: the final answer is bounded to ~1 SMS segment (~40 tokens),
// and each intermediate round is told to stay terse. Lowers output tokens AND locks
// segments=1 by construction. The constitution already caps at 5 lines; this is 2.
const OUT_TOKENS_CAPPED = 60;
// Conversational memory: the last ~8 messages (SMS-length, ~55 tokens each) fed into every
// turn so Alfy remembers the last exchange. Added to the prompt prefix, so caching absorbs
// most of the within-turn cost; the cross-turn growth is the real add.
const HISTORY_TOKENS = 8 * 55;
const CAREFUL_THINKING_TOKENS = 1200; // adaptive thinking on the drafting/synthesis tier

// Cumulative input across a loop: round i re-sends the prompt plus every prior tool result.
// `tool` is the per-round increment — trimming what find_tools hands back shrinks the
// quadratic term, which is why it is a knob and not a constant.
function turnTokens(rounds = ROUNDS_PER_TURN, tool = TOOL_RESULT_TOKENS, prompt = PROMPT_TOKENS, out = OUT_TOKENS_PER_ROUND) {
	let input = 0;
	for (let i = 0; i < rounds; i++) input += prompt + i * (tool + out);
	return { input, output: rounds * out };
}

function turnCost({ careful = false, rounds = ROUNDS_PER_TURN, tool = TOOL_RESULT_TOKENS, prompt = PROMPT_TOKENS, out = OUT_TOKENS_PER_ROUND, local = false } = {}) {
	if (local) return 0; // self-hosted weights: inference is capex, not per-token
	const { input, output } = turnTokens(rounds, tool, prompt, out);
	const [pin, pout] = careful ? [SONNET_IN, SONNET_OUT] : [HAIKU_IN, HAIKU_OUT];
	const outTokens = output + (careful ? CAREFUL_THINKING_TOKENS : 0);
	return (input * pin + outTokens * pout) / 1e6;
}

// ── Usage profiles ───────────────────────────────────────────────────────────
// carefulShare: fraction of texts that escalate to Sonnet (a write gets queued, or a read
// drags back >8k chars). Drafting and "summarise this channel" are the whole point, so
// this is not a rounding error.
const PROFILES = {
	light:   { textsPerDay: 3,  carefulShare: 0.20 },
	typical: { textsPerDay: 10, carefulShare: 0.30 },
	heavy:   { textsPerDay: 25, carefulShare: 0.35 },
};

const DAYS = 30;
const BRIEF_ROUNDS = 8;       // synthesis across several apps, careful tier from turn one
const TOOL_CALLS_PER_TURN = 2; // one find_tools + one use_tool, typical

// Single source of truth for a monthly bill. Every scenario is a config here rather than a
// delta subtracted from another scenario — deltas overlap (caching and a cheaper brief both
// discount the same brief spend) and silently double-count when stacked.
//
//   brief/night — the proactive sends. The brief runs an 8-round agent loop; the night note
//                 runs NO model (alfy-recap reads the ledger), so it is one SMS and nothing else.
//   cached      — cache_control on the loop prefix
//   briefCareful— false runs the brief on the fast tier
//   segments    — SMS segments per outbound reply
//   escalate    — override carefulShare (0 = never leave Haiku)
//   rounds/tool — loop length and the per-round tool payload (trim what find_tools returns)
//   local       — self-hosted weights: per-token inference goes to zero
//   dataChannel — leave SMS for WhatsApp/RCS/app push; carrier cost goes to ~zero
function monthlyVariable(
	{ textsPerDay, carefulShare },
	{
		brief = true, night = true, cached = false, briefCareful = true,
		segments = SEGMENTS_PER_REPLY, escalate = null, rounds = ROUNDS_PER_TURN,
		tool = TOOL_RESULT_TOKENS, out = OUT_TOKENS_PER_ROUND, local = false, dataChannel = false,
		carrier = DEFAULT_CARRIER, history = 0,
	} = {},
) {
	const turns = textsPerDay * DAYS;
	const cost = cached ? cachedTurnCost : turnCost;
	const share = escalate === null ? carefulShare : escalate;
	const shape = { rounds, tool, out, local, prompt: PROMPT_TOKENS + history };

	const inference =
		turns * (1 - share) * cost(shape) +
		turns * share * cost({ ...shape, careful: true }) +
		(brief ? DAYS * cost({ ...shape, careful: briefCareful, rounds: BRIEF_ROUNDS }) : 0);

	// Per text: 1 in, 1 reply out. Plus a confirmation text on each approved write,
	// then whichever proactive sends are still switched on.
	const outbound = turns * (1 + share) + DAYS * ((brief ? 1 : 0) + (night ? 1 : 0));
	const rate = CARRIERS[carrier];
	const [cIn, cOut] = dataChannel ? [0, 0] : [rate.in, rate.out];
	const sms = turns * cIn + outbound * segments * cOut;

	const composio = (turns + (brief ? DAYS : 0)) * TOOL_CALLS_PER_TURN * COMPOSIO_PER_CALL;

	return { inference, sms, composio, total: inference + sms + composio };
}

// ── Fixed platform cost, amortised ───────────────────────────────────────────
// Supabase Pro (cron + edge functions), one Twilio number, one A2P campaign.
// ponytail: flat until you outgrow one Supabase project — revisit past ~10k users.
const FIXED_MONTHLY = 25 + 1.15 + 2;

const fixedPerUser = (users) => FIXED_MONTHLY / users;

// Price floor = cost / (1 - margin), because payment fees and margin are taken off the top.
const STRIPE = (n) => n * 0.029 + 0.30;

function floorPrice(cost, marginTarget = 0) {
	// Solve p - stripe(p) - cost = margin * p
	return (cost + 0.30) / (1 - 0.029 - marginTarget);
}

// ── Levers ───────────────────────────────────────────────────────────────────
// Cache reads bill at 0.1x, writes at 1.25x. agent.ts sets no cache_control today, so
// every round re-pays full price for a prefix it just sent. This is the big one.
// Minimum cacheable prefix: below this the marker is ignored and you pay full price.
// Haiku 4.5 needs 4096, Sonnet 5 needs 2048 — the system prompt alone does NOT reach
// Haiku's floor, so caching only starts paying once a tool result lands.
const MIN_CACHEABLE = { fast: 4096, careful: 2048 };

function cachedTurnCost({ careful = false, rounds = ROUNDS_PER_TURN, tool = TOOL_RESULT_TOKENS, prompt = PROMPT_TOKENS, out = OUT_TOKENS_PER_ROUND, local = false } = {}) {
	if (local) return 0;
	const [pin, pout] = careful ? [SONNET_IN, SONNET_OUT] : [HAIKU_IN, HAIKU_OUT];
	const min = careful ? MIN_CACHEABLE.careful : MIN_CACHEABLE.fast;
	const step = tool + out;
	let cost = 0, cached = 0; // tokens already written to cache

	for (let i = 0; i < rounds; i++) {
		const sent = prompt + i * step;
		const fresh = sent - cached;
		if (sent >= min) {
			cost += (cached * pin * 0.1 + fresh * pin * 1.25) / 1e6; // read old, write new
			cached = sent;
		} else {
			cost += (sent * pin) / 1e6; // prefix too short to cache — full price
		}
	}
	const outTokens = rounds * out + (careful ? CAREFUL_THINKING_TOKENS : 0);
	return cost + (outTokens * pout) / 1e6;
}

// Each row is the FULL config, applied cumulatively — read the change column as the
// marginal saving of adding that one lever to everything above it.
const STACK = [
	['as built',                {}],
	['+ prompt caching',        { cached: true }],
	['+ brief on Haiku',        { cached: true, briefCareful: false }],
	['+ 1-segment replies',     { cached: true, briefCareful: false, segments: 1 }],
	['+ drop night note',       { cached: true, briefCareful: false, segments: 1, night: false }],
	['+ drop brief',            { cached: true, briefCareful: false, segments: 1, night: false, brief: false }],
];

function levers(profile = PROFILES.typical, users = 1000) {
	console.log(`\nLEVERS, CUMULATIVE (typical user, ${profile.textsPerDay} texts/day)`);
	let prev = null;
	for (const [label, opts] of STACK) {
		const t = monthlyVariable(profile, opts).total;
		const cost = t + fixedPerUser(users);
		const delta = prev === null ? '' : ` (-$${(prev - t).toFixed(2)})`;
		console.log(
			`  ${label.padEnd(22)} $${t.toFixed(2)}${delta.padEnd(10)}` +
			` break-even $${floorPrice(cost).toFixed(2)}  70% margin $${floorPrice(cost, 0.7).toFixed(2)}`,
		);
		prev = t;
	}
}

// How low can it go. Ordered cheapest-to-dearest in what it costs the PRODUCT, not the
// bill — the last three rows each break something the design constitution calls load-bearing.
const STRIP = [
	['tuned, full product',   { cached: true, briefCareful: false, segments: 1 }],
	['+ trim find_tools',     { cached: true, briefCareful: false, segments: 1, tool: 1200 }],
	['+ shorter loop (3)',    { cached: true, briefCareful: false, segments: 1, tool: 1200, rounds: 3 }],
	['+ no proactive sends',  { cached: true, briefCareful: false, segments: 1, tool: 1200, rounds: 3, brief: false, night: false }],
	['+ Haiku only, no Sonnet',{ cached: true, briefCareful: false, segments: 1, tool: 1200, rounds: 3, brief: false, night: false, escalate: 0 }],
	['+ leave SMS for data',  { cached: true, briefCareful: false, segments: 1, tool: 1200, rounds: 3, brief: false, night: false, escalate: 0, dataChannel: true }],
	['+ local inference',     { cached: true, briefCareful: false, segments: 1, tool: 1200, rounds: 3, brief: false, night: false, escalate: 0, dataChannel: true, local: true }],
];

function strip(profile = PROFILES.typical, users = 1000) {
	console.log(`\nSTRIPPING TO THE FLOOR (typical user, ${profile.textsPerDay} texts/day)`);
	let prev = null;
	for (const [label, opts] of STRIP) {
		const v = monthlyVariable(profile, opts);
		const cost = v.total + fixedPerUser(users);
		const delta = prev === null ? '' : ` (-$${(prev - v.total).toFixed(2)})`;
		console.log(
			`  ${label.padEnd(26)} $${v.total.toFixed(2)}${delta.padEnd(10)}` +
			` [llm $${v.inference.toFixed(2)} / msg $${v.sms.toFixed(2)}]` +
			` break-even $${floorPrice(cost).toFixed(2)}`,
		);
		prev = v.total;
	}
}

// ── Tier pricing ─────────────────────────────────────────────────────────────
// SHIPPABLE is the config with every free lever pulled and nothing user-visible removed:
// caching on the loop, brief on the fast tier, replies inside one segment, a trimmed
// find_tools payload, and the loop capped near its real length. Local inference is OFF —
// it isn't available to us, so no row here may assume it.
const SHIPPABLE = { cached: true, briefCareful: false, segments: 1, tool: 1200, rounds: 5 };

// Haiku-only: the careful tier never fires (escalate: 0), so no Sonnet drafting or synthesis.
// The brief still runs — it's just a long Haiku loop now — because the proactive send is the
// product, and Haiku over a ledger is fine. This trades draft quality for a real margin at $20.
// Haiku-only, replies capped to one segment by construction. `out` caps the tokens Alfy
// generates per round — cheaper inference and no chance of a 2-segment reply.
const HAIKU_ONLY = { ...SHIPPABLE, escalate: 0, out: OUT_TOKENS_CAPPED };
const CONFIG = HAIKU_ONLY;

const STRIPE_PCT = 0.029, STRIPE_FLAT = 0.30;
const net = (price) => price - (price * STRIPE_PCT + STRIPE_FLAT);

function margin(price, textsPerDay, users = 1000, opts = CONFIG) {
	const cost = monthlyVariable({ textsPerDay, carefulShare: 0.30 }, opts).total + fixedPerUser(users);
	const gross = net(price) - cost;
	return { cost, gross, pct: gross / price };
}

// Highest texts/day this price still clears the margin target. Cost is monotonic in
// usage, so walk it — a solve would need re-deriving every time a knob changes.
function sustainable(price, target = 0, opts = CONFIG) {
	let best = 0;
	for (let t = 0.5; t <= 60; t += 0.5) {
		if (margin(price, t, 1000, opts).pct >= target) best = t; else break;
	}
	return best;
}

// Allowances chosen so margin at the cap — the worst case, every included text used —
// still clears ~40%. Most users land well under, which is where the real margin comes from.
// DAILY caps (texts/day), hard-enforced. A daily cap means worst-case = the design point:
// the user literally cannot exceed it, so margin@cap is a floor, not an average. The $20
// tier is capped at the break-even usage from the cost-benefit — 10/day = 44% worst case.
// Higher tiers lift the cap for power users; enforcement is the same guard, a bigger number.
const LADDER = [
	['Alfy',      20, 10],
	['Alfy Plus', 39, 20],
	['Alfy Pro',  79, 40],
];

function tiers() {
	// Blended (Sonnet escalation on) vs Haiku-only, same price, so the trade is legible.
	console.log('\n=== BLENDED vs HAIKU-ONLY at $20 (margin %, by usage) ===');
	console.log('  texts/day   blended   haiku-only');
	for (const t of [5, 10, 15, 20, 25]) {
		const b = margin(20, t, 1000, SHIPPABLE), h = margin(20, t, 1000, HAIKU_ONLY);
		console.log(`  ${String(t).padStart(6)}      ${(b.pct * 100).toFixed(0).padStart(4)}%      ${(h.pct * 100).toFixed(0).padStart(4)}%`);
	}
	console.log(`  break-even usage at $20:  blended ${sustainable(20, 0, SHIPPABLE)}/day   haiku-only ${sustainable(20, 0, HAIKU_ONLY)}/day`);

	const PRICE = 20;
	console.log(`\n=== AT $${PRICE}/mo (Haiku-only, no local inference) ===`);
	console.log('  texts/day   cost    gross   margin');
	for (const t of [3, 5, 8, 10, 12, 15, 20, 25]) {
		const m = margin(PRICE, t);
		const flag = m.gross < 0 ? '  <-- LOSS' : m.pct < 0.4 ? '  <-- thin' : '';
		console.log(
			`  ${String(t).padStart(6)}     $${m.cost.toFixed(2).padStart(6)}` +
			`  $${m.gross.toFixed(2).padStart(6)}  ${(m.pct * 100).toFixed(0).padStart(4)}%${flag}`,
		);
	}
	console.log(`\n  break-even usage at $${PRICE}: ${sustainable(PRICE, 0)} texts/day`);
	console.log(`  50% margin holds to:       ${sustainable(PRICE, 0.5)} texts/day`);
	console.log(`  60% margin holds to:       ${sustainable(PRICE, 0.6)} texts/day`);

	// Hard DAILY caps. Worst case = the cap itself (the user can't exceed it), so margin@cap
	// is a guaranteed floor. "typical" = 60% of the cap, the realistic average.
	console.log('\n=== TIER LADDER (hard daily cap) ===');
	console.log('  tier        price  texts/day  cost@cap  margin@cap   at 60% use  margin');
	for (const [name, price, capDay] of LADDER) {
		const atCap = margin(price, capDay);
		const typical = margin(price, capDay * 0.6);
		console.log(
			`  ${name.padEnd(11)} $${String(price).padStart(3)}` +
			`  ${String(capDay).padStart(8)}` +
			`   $${atCap.cost.toFixed(2).padStart(6)}  ${(atCap.pct * 100).toFixed(0).padStart(4)}%` +
			`      $${typical.cost.toFixed(2).padStart(6)}  ${(typical.pct * 100).toFixed(0).padStart(4)}%`,
		);
	}
	// Marginal cost of one more text — sets the overage price floor.
	const per = (margin(20, 20).cost - margin(20, 10).cost) / (10 * DAYS);
	console.log(`\n  marginal cost per text: $${per.toFixed(3)}  -> overage / next-tier nudge at $0.15`);
	console.log('  $20 cap = 10/day HARD: guarantees 44% margin even if maxed every day.');

	// Flat $20 with no cap: does the blended book survive a realistic usage mix?
	console.log('\n=== FLAT $20, NO CAP — BLENDED BOOK ===');
	for (const [label, mix] of [
		['gentle  (60/30/10 light/typical/heavy)', { light: 0.6, typical: 0.3, heavy: 0.1 }],
		['even    (40/40/20)',                     { light: 0.4, typical: 0.4, heavy: 0.2 }],
		['power   (25/45/30)',                     { light: 0.25, typical: 0.45, heavy: 0.3 }],
	]) {
		const blended = Object.entries(mix).reduce(
			(sum, [name, share]) => sum + share * margin(20, PROFILES[name].textsPerDay).gross, 0);
		console.log(`  ${label.padEnd(40)} $${blended.toFixed(2)}/user  ${blended < 0 ? '<-- UNDERWATER' : ''}`);
	}
}

// ── Irreducible floor ────────────────────────────────────────────────────────
// What is left when every optional thing is gone but it is STILL Alfy: a phone number you
// text that reads across your apps and asks before it acts. No local inference (we can't),
// so the model floor is Haiku, not zero. Four line items survive; none reaches zero.
//
// Priced at the LIGHTEST usage that is still a real product — one meaningful exchange a day.
// Below this it isn't cheaper, it's just not being used.
const FLOOR_TEXTS_PER_DAY = 1;

function irreducible() {
	const p = { textsPerDay: FLOOR_TEXTS_PER_DAY, carefulShare: 0.30 };
	const turns = p.textsPerDay * DAYS;

	// Every optional thing OFF: no brief, no night note, no Sonnet escalation, caching on,
	// one-segment replies, trimmed tool payload, short loop. Haiku is the floor model.
	const bare = { cached: true, segments: 1, tool: 1200, rounds: 5, brief: false, night: false, escalate: 0 };
	const v = monthlyVariable(p, bare);

	// Inference can't leave — but why: even one Haiku turn a day is a real API bill.
	const inference = v.inference;
	// Messaging can't leave — design law #1, the product IS a phone number.
	const messaging = v.sms;
	// Reading across apps can't leave — that IS the product; Composio meters every call.
	const tools = v.composio;
	// Fixed infra can't leave — a cron host, a real phone number, an A2P campaign.
	const fixedAt = (n) => FIXED_MONTHLY / n;

	console.log('\n=== THE IRREDUCIBLE FLOOR (still Alfy, 1 text/day, no local inference) ===');
	console.log('  line item              $/user/mo   why it cannot be removed');
	console.log(`  inference (Haiku)        $${inference.toFixed(2).padStart(5)}     a texted assistant must run a model; no local means paid API`);
	console.log(`  SMS carrier toll         $${messaging.toFixed(2).padStart(5)}     design law #1 — the product is a phone number`);
	console.log(`  tool calls (Composio)    $${tools.toFixed(2).padStart(5)}     reading across your apps IS the product`);
	const variable = inference + messaging + tools;
	console.log(`  ---------------------------------`);
	console.log(`  variable floor           $${variable.toFixed(2).padStart(5)}     per user, before fixed infra`);

	console.log('\n  + fixed infra (Supabase Pro + number + A2P campaign), amortised:');
	for (const n of [100, 1000, 10000]) {
		const total = variable + fixedAt(n);
		console.log(`    @${String(n).padStart(5)} users   +$${fixedAt(n).toFixed(2)}  =>  $${total.toFixed(2)}/user   break-even price $${floorPrice(total).toFixed(2)}`);
	}

	console.log('\n  The floor for a REAL (typical, 10/day) user, everything optional stripped:');
	const real = monthlyVariable({ textsPerDay: 10, carefulShare: 0 }, bare);
	console.log(`    Haiku-only, no proactive, no Sonnet: $${real.total.toFixed(2)}/mo  [llm $${real.inference.toFixed(2)} / msg $${real.sms.toFixed(2)}]`);
	console.log(`    break-even $${floorPrice(real.total + fixedAt(1000)).toFixed(2)}  — this is the lowest price that isn't a loss on a used product`);
}

// ── Loss vectors ─────────────────────────────────────────────────────────────
// A capped tier only guarantees no loss if revenue arrives BEFORE cost is incurred and the
// cap is enforced by code. Everything below is a way a user goes negative anyway.
const CHARGEBACK_FEE = 15.00;   // Stripe dispute fee, charged win or lose
const PER_TEXT = 0.058;         // marginal cost, from tiers()

// A pathological turn: the agent loops to MAX_TURNS instead of the usual 3-6. One user
// hitting this repeatedly is the fastest way to blow a monthly allowance.
function worstTurn() {
	return {
		capped: cachedTurnCost({ careful: true, rounds: 5, tool: 1200 }),
		runaway: cachedTurnCost({ careful: true, rounds: 14, tool: 1200 }),
	};
}

function lossVectors() {
	const w = worstTurn();
	console.log('\n=== LOSS VECTORS (what a cap alone does NOT protect) ===');

	console.log(`  runaway loop     normal turn $${w.capped.toFixed(4)} vs MAX_TURNS=14 $${w.runaway.toFixed(4)}` +
		`  (${(w.runaway / w.capped).toFixed(1)}x)`);

	// Time-based free trial: unbounded usage, zero revenue. Priced at each profile.
	console.log('\n  14-day free trial, never converts:');
	for (const [name, p] of Object.entries(PROFILES)) {
		const cost = monthlyVariable(p, SHIPPABLE).total * (14 / 30);
		console.log(`    ${name.padEnd(8)} -$${cost.toFixed(2)}  (${p.textsPerDay * 14} texts)`);
	}
	const metered = 20 * PER_TEXT;
	console.log(`    metered trial (20 texts, no clock)  -$${metered.toFixed(2)}  <-- bounded by construction`);

	// Chargeback: lose the revenue, pay the fee, keep the cost already incurred.
	for (const [name, price, capDay] of LADDER) {
		const cost = margin(price, capDay).cost;
		console.log(`\n  chargeback on ${name} ($${price}): -$${(price + CHARGEBACK_FEE + cost).toFixed(2)}` +
			`  (revenue $${price} + fee $${CHARGEBACK_FEE} + cost $${cost.toFixed(2)})`);
	}

	// Card fails mid-month — cost already spent, revenue never arrives.
	const failed = margin(20, LADDER[0][2]).cost;
	console.log(`\n  failed renewal, full month served: -$${failed.toFixed(2)}`);
	console.log(`  => bill FIRST, serve after. Suspend on decline, do not grace-period into a second month.`);
}

// ── Conversational memory: the margin trade ──────────────────────────────────
// Feeding the last ~8 messages into every turn costs input tokens. This prices it at the
// $20/10-cap tier so the trade is explicit: how much margin does memory cost?
// The history tokens sit in the cached prompt prefix: written once (1.25x), read every
// subsequent round (0.1x). Priced directly — the full-recompute path is sensitive to the
// model's coarse cache-threshold step and can spuriously flip sign.
function historyCostPerTurn(rounds) {
	return (HISTORY_TOKENS / 1e6) * HAIKU_IN * (1.25 + 0.1 * Math.max(0, rounds - 1));
}
function monthlyHistoryCost({ textsPerDay }) {
	return textsPerDay * DAYS * historyCostPerTurn(ROUNDS_PER_TURN) + DAYS * historyCostPerTurn(BRIEF_ROUNDS);
}

function memory() {
	const p = PROFILES.typical;
	const off = margin(20, p.textsPerDay, 1000, CONFIG);
	const add = monthlyHistoryCost(p);
	const onCost = off.cost + add;
	const onPct = (net(20) - onCost) / 20;
	console.log('\n=== CONVERSATIONAL MEMORY at the $20 tier (10/day cap) ===');
	console.log(`  stateless (now):    cost $${off.cost.toFixed(2)}   margin ${(off.pct * 100).toFixed(0)}%`);
	console.log(`  with ~8-msg memory: cost $${onCost.toFixed(2)}   margin ${(onPct * 100).toFixed(0)}%`);
	console.log(`  the trade: +$${add.toFixed(2)}/user/mo, ${((off.pct - onPct) * 100).toFixed(1)} margin points`);
	console.log('  (history rides the cached prompt prefix: written once, read cheap each round)');
}

// ── SMS provider comparison ──────────────────────────────────────────────────
// The $20 tier (10/day cap, Haiku-only, word-capped) run through each carrier. Inference,
// Composio, and fixed cost don't move — only the SMS line — so this isolates the carrier
// decision. Margin@cap is the guaranteed floor (user maxes the cap every day).
function carriers() {
	console.log('\n=== SMS PROVIDER @ the $20 tier (10/day cap, all else equal) ===');
	console.log('  provider   $/seg out   cost@cap   margin@cap   vs Twilio');
	const net20 = net(20);
	const twilioCost = margin(20, 10, 1000, { ...CONFIG, carrier: 'twilio' }).cost;
	for (const name of ['telnyx', 'plivo', 'sinch', 'twilio']) {
		const m = margin(20, 10, 1000, { ...CONFIG, carrier: name });
		const saved = twilioCost - m.cost;
		console.log(
			`  ${name.padEnd(9)}  $${CARRIERS[name].out.toFixed(4)}` +
			`     $${m.cost.toFixed(2).padStart(6)}` +
			`     ${(m.pct * 100).toFixed(0).padStart(4)}%` +
			`       ${saved > 0 ? '+$' + saved.toFixed(2) + '/user' : '—'}`,
		);
	}
	const per = 10000; // users
	const saveVsTwilio = (twilioCost - margin(20, 10, 1000, CONFIG).cost) * per * 12;
	console.log(`\n  Telnyx vs Twilio at ${per} users: ~$${Math.round(saveVsTwilio).toLocaleString()}/year saved on carrier alone.`);
}

// ── Cost-benefit: dropping the price from $50+ ───────────────────────────────
// The cost side is margin. The benefit side is volume: a lower price converts more of the
// funnel and widens the addressable market. This weighs the two against a revenue target.
//
// Conversion lift is a MODELLED elasticity, not a measured one — the softest input here.
// visit->pay conversion assumed to roughly double from $50 to $20 (a common SaaS shape for
// a consumer impulse product). Flagged so it can be argued with.
const CONVERSION = { 50: 0.010, 39: 0.014, 29: 0.020, 20: 0.030, 15: 0.038, 9: 0.050 };
const MONTHLY_VISITORS = 20000; // top of funnel — the number both prices draw from
const CHURN = { 50: 0.08, 39: 0.07, 29: 0.06, 20: 0.05, 15: 0.055, 9: 0.07 }; // monthly

function costBenefit(usage = PROFILES.typical.textsPerDay) {
	console.log(`\n=== COST-BENEFIT: PRICE DROP (Haiku-only, ~$0.007 SMS, ${usage} texts/day) ===`);
	console.log('  price  cost   margin$  margin%   conv%   payers   MRR      LTV    LTV/cost');
	for (const price of [50, 39, 29, 20, 15, 9]) {
		const m = margin(price, usage);
		const conv = CONVERSION[price];
		const payers = MONTHLY_VISITORS * conv;
		const mrr = payers * price;
		const life = 1 / CHURN[price];          // months
		const ltv = m.gross * life;             // gross profit over a lifetime
		console.log(
			`  $${String(price).padStart(2)}` +
			`  $${m.cost.toFixed(2).padStart(5)}` +
			`  $${m.gross.toFixed(2).padStart(6)}` +
			`  ${(m.pct * 100).toFixed(0).padStart(4)}%` +
			`   ${(conv * 100).toFixed(1).padStart(4)}%` +
			`   ${String(Math.round(payers)).padStart(5)}` +
			`  $${String(Math.round(mrr)).padStart(6)}` +
			`  $${ltv.toFixed(0).padStart(4)}` +
			`   ${(ltv / m.cost).toFixed(0).padStart(3)}x` +
			(m.gross < 0 ? '  LOSS' : ''),
		);
	}
	console.log('\n  MRR = monthly recurring revenue from one month of new signups');
	console.log('  LTV = gross profit per payer over their lifetime (1/churn months)');
	console.log('  The winning row maximises MRR AND keeps LTV/cost healthy — not just margin%.');
}

// The two proactive sends priced independently — they are not the same trade.
function proactive() {
	console.log('\nDROPPING PROACTIVE SENDS ALONE (no other changes)');
	for (const [name, profile] of Object.entries(PROFILES)) {
		const base = monthlyVariable(profile).total;
		const noNight = monthlyVariable(profile, { night: false }).total;
		const noBrief = monthlyVariable(profile, { brief: false }).total;
		const neither = monthlyVariable(profile, { brief: false, night: false }).total;
		console.log(
			`  ${name.padEnd(8)} now $${base.toFixed(2)}` +
			`  -night $${noNight.toFixed(2)} (-$${(base - noNight).toFixed(2)})` +
			`  -brief $${noBrief.toFixed(2)} (-$${(base - noBrief).toFixed(2)})` +
			`  neither $${neither.toFixed(2)} (-$${(base - neither).toFixed(2)})`,
		);
	}
}

function report() {
	const users = [100, 1000, 10000];
	for (const [name, profile] of Object.entries(PROFILES)) {
		const v = monthlyVariable(profile);
		console.log(`\n${name.toUpperCase()}  (${profile.textsPerDay} texts/day, ${Math.round(profile.carefulShare * 100)}% escalate)`);
		console.log(`  inference  $${v.inference.toFixed(2)}`);
		console.log(`  sms        $${v.sms.toFixed(2)}`);
		console.log(`  composio   $${v.composio.toFixed(2)}`);
		console.log(`  variable   $${v.total.toFixed(2)}  / user / month`);
		for (const n of users) {
			const cost = v.total + fixedPerUser(n);
			console.log(
				`   @${String(n).padStart(5)} users  cost $${cost.toFixed(2)}` +
				`  break-even $${floorPrice(cost).toFixed(2)}` +
				`  70% margin $${floorPrice(cost, 0.7).toFixed(2)}`,
			);
		}
	}
	console.log(`\nfixed platform: $${FIXED_MONTHLY.toFixed(2)}/mo total (Supabase Pro + number + A2P campaign)`);
	levers();
	proactive();
	strip();
	tiers();
	irreducible();
	carriers();
	memory();
	costBenefit();
	lossVectors();
}

function check() {
	// The loop is quadratic in rounds, not linear — the whole point of the model.
	const one = turnTokens(1).input, four = turnTokens(4).input;
	console.assert(four > one * 4, 'input should grow faster than linearly in rounds');
	// Careful tier must cost meaningfully more, or the tiering in agent.ts is pointless.
	console.assert(turnCost({ careful: true }) > turnCost() * 2, 'careful tier should dominate');
	// Heavier use must cost more, and floors must clear cost.
	console.assert(monthlyVariable(PROFILES.heavy).total > monthlyVariable(PROFILES.light).total, 'heavy > light');
	const c = monthlyVariable(PROFILES.typical).total + fixedPerUser(1000);
	const p = floorPrice(c);
	console.assert(Math.abs(p - STRIPE(p) - c) < 0.01, 'break-even price must net exactly cost');
	console.assert(floorPrice(c, 0.7) > p, 'margin raises the floor');
	// Caching must be a real cut, and must not "help" a single-round turn (nothing reused).
	// Caching helps, but it is NOT the 90% cut the headline rate implies: each round writes
	// a fresh increment at 1.25x, so a short 4-round chat turn only comes down ~30%.
	// The win concentrates in long loops (the brief), where the reused prefix dominates.
	const ratio = cachedTurnCost() / turnCost();
	console.assert(ratio < 1 && ratio > 0.5, `expected a partial cut, got ${ratio.toFixed(2)}`);
	console.assert(cachedTurnCost({ careful: true, rounds: BRIEF_ROUNDS }) < turnCost({ careful: true, rounds: BRIEF_ROUNDS }) * 0.6, 'long loops should cache well');
	// Dropping the brief must save inference; dropping the night note must NOT (no model).
	const on = monthlyVariable(PROFILES.typical);
	console.assert(monthlyVariable(PROFILES.typical, { brief: false }).inference < on.inference, 'brief drop should cut inference');
	console.assert(monthlyVariable(PROFILES.typical, { night: false }).inference === on.inference, 'night note runs no model — inference must not move');
	console.assert(monthlyVariable(PROFILES.typical, { night: false }).sms < on.sms, 'night note still costs an SMS');
	// Both stacks must be monotonic — a lever that raises cost means the config is wrong.
	for (const rows of [STACK, STRIP]) {
		let last = Infinity;
		for (const [label, opts] of rows) {
			const t = monthlyVariable(PROFILES.typical, opts).total;
			console.assert(t <= last, `${label} increased cost — overlapping/incorrect config`);
			last = t;
		}
	}
	// The floor is not zero: Composio still meters per tool call even with local weights
	// and no SMS. Anything claiming $0.00 has dropped a real line item.
	const bone = monthlyVariable(PROFILES.typical, STRIP.at(-1)[1]);
	console.assert(bone.inference === 0 && bone.sms === 0, 'last row should zero llm and messaging');
	console.assert(bone.total > 0, 'floor must stay above zero — tool calls still meter');
	// Tier maths: margin must fall as usage rises, and each cap must actually be profitable.
	console.assert(margin(20, 20).gross < margin(20, 5).gross, 'heavier usage must earn less');
	console.assert(Math.abs(net(20) - 19.12) < 0.01, 'stripe fee drift');
	// Every tier must clear 40% even in the worst case: the user hits the daily cap every day.
	for (const [name, price, capDay] of LADDER) {
		const m = margin(price, capDay);
		console.assert(m.pct >= 0.40, `${name} only makes ${(m.pct * 100).toFixed(0)}% at its own cap`);
	}
	// Caps must bind at/below break-even usage, or they protect nothing.
	for (const [name, price, capDay] of LADDER) {
		console.assert(capDay <= sustainable(price, 0), `${name} cap sits above break-even`);
	}
	// No-loss guarantees. A runaway loop must be strictly worse than a normal turn, or
	// MAX_TURNS isn't worth capping; a metered trial must beat a time-based one outright.
	const w = worstTurn();
	console.assert(w.runaway > w.capped * 2, 'MAX_TURNS=14 should be materially worse than a real turn');
	const timed = monthlyVariable(PROFILES.heavy, SHIPPABLE).total * (14 / 30);
	console.assert(20 * PER_TEXT < timed, 'metered trial must bound exposure below a timed one');
	// Overage must price above marginal cost or the cap leaks money on every extra text.
	console.assert(0.15 > PER_TEXT, 'overage price must exceed marginal cost');
	// The irreducible floor: three variable line items, none of which can reach zero
	// without deleting the product or adopting local weights (which we can't).
	const bare = { cached: true, segments: 1, tool: 1200, rounds: 5, brief: false, night: false, escalate: 0 };
	const f = monthlyVariable({ textsPerDay: 1, carefulShare: 0 }, bare);
	console.assert(f.inference > 0 && f.sms > 0 && f.composio > 0, 'no line item can reach zero without local/no-SMS');
	// The word cap must actually cut inference, and a capped reply must fit one segment
	// (~160 chars ≈ 40 tokens) — 60 leaves headroom, 200 does not.
	console.assert(cachedTurnCost({ out: OUT_TOKENS_CAPPED }) < cachedTurnCost({ out: OUT_TOKENS_PER_ROUND }), 'word cap should lower inference');
	console.assert(OUT_TOKENS_CAPPED <= 60, 'capped reply must fit one SMS segment');
	// Cost-benefit: MRR must actually rise as we cut price (else the drop is pointless), and
	// the cheaper carrier must beat Twilio's old rate.
	const mrr = (p) => MONTHLY_VISITORS * CONVERSION[p] * p;
	console.assert(mrr(20) > mrr(50), 'if cutting to $20 lowers MRR, the elasticity does not justify it');
	console.assert(SMS_OUT < 0.0119, 'off-Twilio rate must be below Twilio');
	// Carrier choice must move cost the right way: Telnyx strictly cheaper than Twilio at cap.
	console.assert(
		margin(20, 10, 1000, { ...CONFIG, carrier: 'telnyx' }).cost < margin(20, 10, 1000, { ...CONFIG, carrier: 'twilio' }).cost,
		'Telnyx must undercut Twilio at the $20 cap',
	);
	console.assert(CARRIERS.telnyx.out < CARRIERS.plivo.out, 'Telnyx should be the cheap leader');
	// Memory costs tokens but must stay affordable: the direct history cost is positive, and
	// the $20 tier must still clear 40% at cap with memory on (or the window is too big).
	const memOff = margin(20, 10, 1000, CONFIG);
	const memAdd = monthlyHistoryCost(PROFILES.typical);
	console.assert(memAdd > 0, 'memory should cost tokens');
	console.assert((net(20) - memOff.cost - memAdd) / 20 >= 0.40, 'memory drops $20 tier below 40% — shrink the window');
	// Every price we would actually ship must clear cost at typical usage.
	for (const p of [50, 39, 29, 20]) console.assert(margin(p, PROFILES.typical.textsPerDay).gross > 0, `$${p} loses at typical usage`);
	// A one-round turn has nothing to reuse and sits under Haiku's 4096 floor: identical cost.
	console.assert(cachedTurnCost({ rounds: 1 }) === turnCost({ rounds: 1 }), 'single round cannot benefit from caching');
	console.log('unit-economics self-check ok');
}

process.argv.includes('--check') ? check() : report();
