import { useState } from 'react';
import { supabase } from '../lib/supabase';

// The Jobs cut: one field, one button. The link Alfy texts is the primary path;
// the code is the fallback; texting Alfy is the escape hatch. See design notes.

function formatUS(raw: string): string {
	const d = raw.replace(/\D/g, '').slice(0, 10);
	if (d.length <= 3) return d;
	if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
	return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function toE164(display: string): string | null {
	const d = display.replace(/\D/g, '');
	if (d.length === 10) return `+1${d}`;
	if (d.length === 11 && d.startsWith('1')) return `+${d}`;
	return null;
}

type Step = 'phone' | 'code';

export default function LoginForm() {
	// ?step=code renders the second screen directly (used for design review).
	const initial: Step =
		typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('step') === 'code'
			? 'code'
			: 'phone';

	const [step, setStep] = useState<Step>(initial);
	const [display, setDisplay] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const e164 = toE164(display);

	async function sendCode() {
		setError(null);
		if (!e164) {
			setError('That number looks off — mind checking it?');
			return;
		}
		if (!supabase) {
			setError("Sign-in isn't switched on yet.");
			return;
		}
		setBusy(true);
		const { error } = await supabase.auth.signInWithOtp({ phone: e164 });
		setBusy(false);
		if (error) setError("Couldn't reach that number. Try again, or just text Alfy “sign in.”");
		else setStep('code');
	}

	async function verify() {
		setError(null);
		if (!supabase || !e164) return;
		setBusy(true);
		const { error } = await supabase.auth.verifyOtp({ phone: e164, token: code.trim(), type: 'sms' });
		setBusy(false);
		if (error) setError("That code didn't match. Check it, or tap Resend.");
		else window.location.href = '/app';
	}

	return (
		<div className="flex min-h-dvh items-center justify-center px-6 py-16">
			<div className="w-full max-w-sm">
				<a href="/" className="font-display text-h1 font-semibold text-espresso">
					Alfy
				</a>

				{step === 'phone' ? (
					<div className="mt-8 rounded-3xl border border-hairline bg-card p-7 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)]">
						<h1 className="font-display text-h2 font-medium text-espresso">What's your number?</h1>
						<p className="mt-2 text-body text-secondary">
							Alfy will text you a link to tap. No password.
						</p>

						<div className="mt-5 flex items-center gap-2 rounded-2xl border border-hairline bg-linen px-4 py-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-espresso">
							<span className="text-body text-muted">+1</span>
							<input
								type="tel"
								inputMode="numeric"
								autoComplete="tel-national"
								autoFocus
								value={display}
								onChange={(e) => setDisplay(formatUS(e.target.value))}
								onKeyDown={(e) => e.key === 'Enter' && sendCode()}
								placeholder="(555) 867-5309"
								className="w-full bg-transparent text-body text-espresso placeholder:text-muted focus:outline-none"
							/>
						</div>

						{e164 && (
							<p className="mt-2 text-small text-muted">We'll text {display}.</p>
						)}

						<button
							type="button"
							onClick={sendCode}
							disabled={busy}
							className="mt-5 min-h-11 w-full cursor-pointer rounded-full bg-marigold px-5 text-small font-medium text-on-marigold transition-colors hover:bg-[#C97923] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:opacity-60"
						>
							{busy ? 'Sending…' : 'Text me'}
						</button>

						{error && <p className="mt-3 text-small text-espresso">{error}</p>}
					</div>
				) : (
					<div className="mt-8 rounded-3xl border border-hairline bg-card p-7 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)]">
						<h1 className="font-display text-h2 font-medium text-espresso">Check your phone.</h1>
						<p className="mt-2 text-body text-secondary">
							Tap the link Alfy sent — or type the code here.
						</p>

						<input
							type="text"
							inputMode="numeric"
							autoComplete="one-time-code"
							autoFocus
							value={code}
							onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
							onKeyDown={(e) => e.key === 'Enter' && verify()}
							placeholder="123456"
							className="mt-5 w-full rounded-2xl border border-hairline bg-linen px-4 py-3 text-center font-display text-h1 tracking-[0.4em] text-espresso placeholder:tracking-[0.4em] placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso"
						/>

						<button
							type="button"
							onClick={verify}
							disabled={busy || code.length < 6}
							className="mt-5 min-h-11 w-full cursor-pointer rounded-full bg-marigold px-5 text-small font-medium text-on-marigold transition-colors hover:bg-[#C97923] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:opacity-60"
						>
							{busy ? 'Checking…' : 'Sign in'}
						</button>

						{error && <p className="mt-3 text-small text-espresso">{error}</p>}

						<p className="mt-5 text-small text-muted">
							Didn't get it?{' '}
							<button
								type="button"
								onClick={sendCode}
								className="cursor-pointer font-medium text-fern underline decoration-fern/40 underline-offset-4 hover:text-espresso"
							>
								Resend
							</button>{' '}
							— or just text Alfy “sign in” and it'll send you a link.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
