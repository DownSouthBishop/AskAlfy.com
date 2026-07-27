-- The SMS provider moved from Twilio to Telnyx — rename the dedupe column so it isn't a
-- landmine for future readers.
alter table messages rename column twilio_sid to provider_msg_id;
comment on column messages.provider_msg_id is 'Dedupe key for inbound webhook retries (Telnyx message id).';
