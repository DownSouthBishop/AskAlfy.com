// The provisioned Alfy number (Telnyx) — every CTA (hero, footer, QR code) picks it up.
export const ALFY_PHONE = '+15618137525';
export const SMS_URI = `sms:${ALFY_PHONE}`;

// Every outside app — including Google — connects through Composio now (see
// supabase/functions/_shared/composio.ts and the connect_app agent tool), texted to the
// person as a link rather than a client-side OAuth redirect built from a public client ID.
// No frontend Google config needed anymore.
