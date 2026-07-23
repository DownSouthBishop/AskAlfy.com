// SMS provider: Telnyx. Send, inbound-signature verification, and inbound parsing.
//
// The signature check is the ONLY thing standing between the agent and anyone who knows a
// user's number — do not make it optional. Telnyx signs with Ed25519 (public-key), NOT an
// HMAC shared secret: it signs `${timestamp}|${rawBody}` with its private key, and we verify
// with the account's public key (TELNYX_PUBLIC_KEY, base64, from the Telnyx portal). So the
// caller must hand us the RAW request body text — reparsing to JSON first changes the bytes
// and breaks the check.
//
// Why Telnyx over Twilio: own carrier network, ~$0.004 base vs Twilio's ~$0.008 (the A2P
// 10DLC carrier surcharge ~$0.003 is unavoidable on any provider). See scripts/unit-economics.mjs.

import { requireEnv } from './env.ts';

const TELNYX_API_KEY = requireEnv('TELNYX_API_KEY');
const TELNYX_PUBLIC_KEY = requireEnv('TELNYX_PUBLIC_KEY'); // base64 Ed25519 public key
export const SMS_FROM = requireEnv('TELNYX_PHONE_NUMBER'); // E.164, the Alfy number

// Reject signatures older than this — a valid signature replayed later must not pass.
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;

// Return type pinned to ArrayBuffer (not the wider ArrayBufferLike) so it satisfies
// WebCrypto's BufferSource parameter under Deno's strict lib.
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const out = new Uint8Array(new ArrayBuffer(bin.length));
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// Ed25519 verification of `${timestamp}|${rawBody}` against Telnyx's public key. Deno's
// WebCrypto supports Ed25519 natively.
export async function verifyInboundSignature(
	rawBody: string,
	signature: string | null,
	timestamp: string | null,
): Promise<boolean> {
	if (!signature || !timestamp) return false;

	// Replay guard: the timestamp is part of the signed payload, so a tampered timestamp
	// fails the signature — but a genuine old one still verifies, hence this freshness gate.
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_SEC) return false;

	try {
		const key = await crypto.subtle.importKey(
			'raw',
			b64ToBytes(TELNYX_PUBLIC_KEY),
			{ name: 'Ed25519' },
			false,
			['verify'],
		);
		const enc = new TextEncoder().encode(`${timestamp}|${rawBody}`);
		const signed = new Uint8Array(new ArrayBuffer(enc.length));
		signed.set(enc);
		return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(signature), signed);
	} catch {
		return false;
	}
}

export interface Inbound {
	kind: 'message' | 'other';
	from: string;
	body: string;
	sid: string;
}

// Telnyx delivers JSON. The same webhook also receives delivery receipts
// (message.sent / message.finalized) — those are NOT inbound texts and must not run the
// agent, so anything but message.received comes back as kind:'other'.
export function parseInbound(rawBody: string): Inbound {
	let evt: {
		data?: {
			event_type?: string;
			payload?: { id?: string; text?: string; from?: { phone_number?: string } };
		};
	};
	try {
		evt = JSON.parse(rawBody);
	} catch {
		return { kind: 'other', from: '', body: '', sid: '' };
	}
	const data = evt.data;
	if (data?.event_type !== 'message.received') return { kind: 'other', from: '', body: '', sid: '' };
	const p = data.payload ?? {};
	return {
		kind: 'message',
		from: p.from?.phone_number ?? '',
		body: p.text ?? '',
		sid: p.id ?? '',
	};
}

// Returns the number of segments Telnyx billed, or 0 on failure — callers log it to
// messages.segments for cost metering.
export async function sendSms(to: string, body: string): Promise<number> {
	const res = await fetch('https://api.telnyx.com/v2/messages', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${TELNYX_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ from: SMS_FROM, to, text: body }),
	});
	if (!res.ok) return 0;
	const sent = await res.json().catch(() => null);
	// data.parts is Telnyx's segment count.
	return Number(sent?.data?.parts ?? 1) || 1;
}
