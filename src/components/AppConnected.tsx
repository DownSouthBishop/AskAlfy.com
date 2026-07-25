import { useEffect, useState } from 'react';

// The /auth/app-connected landing — Composio redirects here once the person finishes
// authorizing a connected app (Slack, Notion, GitHub, Outlook). Composio already ties the
// connection to the right person server-side (initiateComposioConnection was called with
// their userId before they ever left the text thread), so this page needs no session and
// does no exchange — it's purely "you're done, go back to texting."

const APP_NAMES: Record<string, string> = {
	slack: 'Slack',
	notion: 'Notion',
	github: 'GitHub',
	outlook: 'Outlook',
};

export default function AppConnected() {
	const [app, setApp] = useState<string | null>(null);

	useEffect(() => {
		setApp(new URLSearchParams(window.location.search).get('app'));
	}, []);

	const name = (app && APP_NAMES[app]) || 'That app';

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
			<span className="font-display text-h1 font-semibold text-espresso">Alfy</span>
			<span
				className="flex h-10 w-10 items-center justify-center rounded-full bg-fern-tint text-fern"
				aria-hidden="true"
			>
				<svg className="h-5 w-5" viewBox="0 0 16 16" fill="none">
					<path
						d="M3 8.5 6.5 12 13 4.5"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</span>
			<p className="max-w-xs text-body text-secondary">
				{name} is connected. Head back to your texts — Alfy can use it now.
			</p>
		</div>
	);
}
