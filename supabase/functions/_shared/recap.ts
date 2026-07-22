// The night note — assembled, not written by the model.
//
// This is a receipt. A receipt that can invent a line it never did is worth less than no
// receipt at all, and "Alfy asks first" is exactly the claim it exists to prove. So it is
// string assembly over rows Alfy already owns: it cannot hallucinate an action, it costs
// nothing per person per night, and it has no latency or timeout to design around.

export interface RecapRow {
	summary: string;
	status: string;
	standing_permission_id: string | null;
}

// ponytail: summaries go out verbatim — they are the same labels the Handled cards show
// ("Send Email — dana@example.com"). Rewriting them into past-tense prose needs a verb table
// that would drift from actionPhrase(), and the person has already read these exact strings
// on the cards they approved.
const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function composeRecap(rows: RecapRow[], link: string | null): string | null {
	const executed = rows.filter((r) => r.status === 'executed');
	const own = executed.filter((r) => r.standing_permission_id);
	const failed = rows.filter((r) => r.status === 'failed');
	const pending = rows.filter((r) => r.status === 'pending');

	// A note on a day where nothing happened is spam, and it teaches people to ignore the
	// channel — which costs the morning brief too. Silence is the feature.
	if (!executed.length && !failed.length && !pending.length) return null;

	const lines: string[] = [];

	if (executed.length === 1) {
		lines.push(`Did one thing today: ${clip(executed[0].summary)}.`);
	} else if (executed.length > 1) {
		lines.push(`Did ${executed.length} things today. Latest: ${clip(executed[executed.length - 1].summary)}.`);
	}

	// Autonomy is attributed out loud. Acting without being asked is the thing people are
	// most nervous about, so it gets named every time rather than folded into the count.
	if (own.length === 1) {
		lines.push(`One of those without asking — you'd okayed that one.`);
	} else if (own.length > 1) {
		lines.push(`${own.length} of those without asking — you'd okayed those.`);
	}

	// Failures surface, always. Hiding a miss is the one thing that would make this text
	// worse than sending nothing.
	if (failed.length === 1) {
		lines.push(`One didn't go through: ${clip(failed[0].summary)}.`);
	} else if (failed.length > 1) {
		lines.push(`${failed.length} didn't go through, including ${clip(failed[0].summary)}.`);
	}

	// Un-windowed on purpose (see the query in alfy-recap): a three-day-old approval nobody
	// tapped is the most useful thing this text can say.
	if (pending.length) {
		const more = pending.length > 1 ? `, and ${pending.length - 1} more` : '';
		const open = link ? ` Open: ${link}` : '';
		lines.push(`Still waiting on you: ${clip(pending[0].summary)}${more}.${open}`);
	}

	lines.push('— A');
	return lines.join('\n');
}
