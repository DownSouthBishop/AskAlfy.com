// Telnyx signature validation + send. Replaces _shared/twilio.ts — AskAlfy's number is
// provisioned on Telnyx, not Twilio.
//
// Telnyx signs webhooks with Ed25519 (compatible with the Standard Webhooks spec): headers
// telnyx-timestamp and telnyx-signature-ed25519 (base64) over the string
// `${timestamp}|${rawBody}`, verified against the account's public key from Mission Control
// Portal -> Keys & Credentials -> Public Key. Using @noble/ed25519 rather than
// crypto.subtle.verify since native Ed25519 support isn't reliably available across Deno/edge
// runtime versions.
import { verifyAsync } from 'npm:@noble/ed25519@2';

const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY')!;
const TELNYX_PHONE_NUMBER = Deno.env.get('TELNYX_PHONE_NUMBER')!;
const TELNYX_PUBLIC_KEY = Deno.env.get('TELNYX_PUBLIC_KEY')!;

export const TELNYX_FROM_NUMBER = TELNYX_PHONE_NUMBER;

function base64ToBytes(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// A stale timestamp (>5 min) is rejected too, so a captured payload can't be replayed forever.
export async function validateTelnyxSignature(req: Request, rawBody: string): Promise<boolean> {
	const signature = req.headers.get('telnyx-signature-ed25519');
	const timestamp = req.headers.get('telnyx-timestamp');
	if (!signature || !timestamp || !TELNYX_PUBLIC_KEY) return false;

	const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

	const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
	try {
		return await verifyAsync(base64ToBytes(signature), message, base64ToBytes(TELNYX_PUBLIC_KEY));
	} catch {
		return false;
	}
}

const MAX_SEGMENT_CHARS = 1500;
const MAX_SEGMENTS = 3;

function chunkBody(body: string): string[] {
	if (body.length <= MAX_SEGMENT_CHARS) return [body];
	const chunks: string[] = [];
	for (let i = 0; i < body.length && chunks.length < MAX_SEGMENTS; i += MAX_SEGMENT_CHARS) {
		chunks.push(body.slice(i, i + MAX_SEGMENT_CHARS));
	}
	return chunks;
}

// Splits long replies into up to 3 SMS segments as a safety net — the system prompt
// already asks Alfy to keep replies to 5 lines, so this should rarely trigger.
export async function sendSms(to: string, body: string): Promise<boolean> {
	for (const chunk of chunkBody(body)) {
		const res = await fetch('https://api.telnyx.com/v2/messages', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TELNYX_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ from: TELNYX_PHONE_NUMBER, to, text: chunk }),
		});
		if (!res.ok) return false;
	}
	return true;
}
