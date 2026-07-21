import { createClient } from '@supabase/supabase-js';

// ponytail: one browser client, env-driven. Stays null until the Alfy Supabase
// project exists, so the site still builds and renders before backend is wired.
const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const anon = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

export const supabase = url && anon ? createClient(url, anon) : null;
