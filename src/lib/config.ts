// The product IS this number — every CTA (hero, footer, QR code) reads it from here.
// Set it once to the provisioned Telnyx number in E.164.
//
// PLACEHOLDER_PHONE is what `npm run doctor` and the prebuild check look for: shipping
// the placeholder puts a dead sms: link on every call to action, and the site would
// otherwise build perfectly happily.
export const PLACEHOLDER_PHONE = '+10000000000';

export const ALFY_PHONE = '+10000000000';
export const SMS_URI = `sms:${ALFY_PHONE}`;
