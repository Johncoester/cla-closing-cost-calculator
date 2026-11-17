// Supabase Edge Function: invite-clients-bulk
//
// "Upload clients" on the admin Users page. The browser sends { rows, redirectTo } with the
// signed-in admin's JWT. The function:
//   1. calls public.admin_preview_bulk_clients() AS THE CALLER (migration 21). The database
//      checks the caller is an admin / super admin, classifies each row (invite / skip existing
//      account / reject), and looks up the sales rep. Role is always client. The browser's
//      classification is not trusted.
//   2. checks public.admin_bulk_invite_remaining() (rolling cap of 50 emails per hour).
//   3. for each "invite" row, calls public.create_invitation() (stores name, cell, company and
//      the assignment) then uses the service-role key to send the invite through
//      auth.admin.inviteUserByEmail, same template and set-password.html?invite=1 redirect as
//      invite-user. A successful send is recorded with admin_bulk_invite_record().
//   4. stops cleanly if the hourly cap is reached or Supabase Auth returns a rate-limit error.
//      Already-sent rows stay sent; the rest are returned as "held".
//
// Caps: 50 rows per request, 50 sent emails per rolling hour. The service-role key lives only
// in this function's secrets. Never put it in the page or the repo.
//
// Deploy later (John, after screenshots and approval):  supabase functions deploy invite-clients-bulk
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handle } from './handler.js'

Deno.serve((req) => handle(req, createClient, (k) => Deno.env.get(k)))
