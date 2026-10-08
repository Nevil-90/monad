/**
 * scripts/lib/supabase_store.js
 * The relay's one connection to Supabase, the shared central store behind the event index and the
 * Dashboard's paginated queries (replaces data/*.json). Needs SUPABASE_URL and SUPABASE_SERVICE_KEY
 * (the service_role secret key, never the anon key: it bypasses RLS, which denies every other role).
 * Nothing else in the app talks to Supabase; the browser only ever talks to this relay.
 */
import { createClient } from '@supabase/supabase-js';

let client = null;

export function supabase() {
  if (client) return client;
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!rawUrl || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (see .env.example and supabase/schema.sql)');
  // supabase-js wants the bare project URL and appends /rest/v1 itself; strip it off in case it was
  // copied from the Data API page's "REST URL" field (which already includes it) instead of the
  // plain Project URL field.
  const url = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
