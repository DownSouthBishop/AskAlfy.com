import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// The /a?t=<token> landing. Exchanges the one-time SMS token for a real session, then
// deep-links to the pending approval. No taps here — the deliberate tap is Approve, next.

export default function AuthHandoff() {
	const [msg, setMsg] = useState('Signing you in…');

	useEffect(() => {
		(async () => {
			const t = new URLSearchParams(window.location.search).get('t');
			if (!t) return void window.location.replace('/login');
			if (!supabase) return setMsg("Sign-in isn't switched on yet.");

			const { data, error } = await supabase.functions.invoke('alfy-link', { body: { token: t } });
			if (error || !data?.token_hash) return void window.location.replace('/login?expired=1');

			const { error: vErr } = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: 'email' });
			if (vErr) return void window.location.replace('/login?expired=1');

			window.location.replace(data.item ? `/app?item=${data.item}` : '/app');
		})();
	}, []);

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6">
			<span className="font-display text-h1 font-semibold text-espresso">Alfy</span>
			<p className="text-body text-secondary">{msg}</p>
		</div>
	);
}
