// Fail at boot with the secret's name, not deep inside a fetch with "undefined".
// Every missing secret should read like a doctor line: what's missing, how to set it.

export function requireEnv(name: string): string {
	const v = Deno.env.get(name);
	if (!v) throw new Error(`Missing secret: ${name} — set it with: supabase secrets set ${name}=...`);
	return v;
}

// For values with a sane default (APP_URL). Still named so a typo is visible.
export function optionalEnv(name: string, fallback: string): string {
	return Deno.env.get(name) ?? fallback;
}
