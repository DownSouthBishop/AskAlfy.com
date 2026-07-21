// Placeholder until a real number is provisioned — update here once and every
// CTA (hero, footer, QR code) picks it up.
export const ALFY_PHONE = '+10000000000';
export const SMS_URI = `sms:${ALFY_PHONE}`;

// Google OAuth client ID is public (not a secret) — the matching GOOGLE_CLIENT_SECRET
// lives only as an edge-function secret. Placeholder until a real GCP OAuth client is
// created (see docs/alfy-handoff.md); the redirect URI to register there is
// `${PUBLIC_APP_URL}/auth/google-callback`.
export const GOOGLE_CLIENT_ID = 'REPLACE_WITH_REAL_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

export const GOOGLE_SCOPES: Record<string, string[]> = {
	gmail: [
		'https://www.googleapis.com/auth/gmail.modify',
		'https://www.googleapis.com/auth/gmail.send',
		'https://www.googleapis.com/auth/gmail.settings.basic',
	],
	googlecalendar: ['https://www.googleapis.com/auth/calendar'],
};
