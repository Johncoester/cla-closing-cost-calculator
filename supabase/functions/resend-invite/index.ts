// Supabase Edge Function: resend-invite   (NOT DEPLOYED; written 11/02/26 to the documented APIs, tested locally with a stubbed client)
//
// "Resend invite" button: admin Users tab (admins / super admins: anyone) and the rep's client list (reps: their own active clients). The browser sends only { userId, redirectTo } with the signed-in user's JWT. The function:
//   1. calls public.admin_resend_invite() AS THE CALLER (migration 20). The database checks the caller's role and, for a rep, that the person is
//      their own client through an ACTIVE assignment (admins / super admins: anyone; reps: only their own clients; clients: nobody), refuses a person who has already signed in or is disabled, enforces the 60-second limit, writes the 'invite_resent' audit row, and returns
//      the email address to use (never taken from the browser);
//   2. only then uses the service-role key to have Supabase Auth email the person again:
//        not confirmed yet (the usual case: invited, link never opened)  -> auth.admin.inviteUserByEmail() again. Supabase Auth allows this for an
//          existing user whose email is not confirmed: it issues a NEW invite token (the old link stops working) and sends the SAME branded
//          "Invite user" template through the custom SMTP, with the same redirect to set-password.html?invite=1. It only refuses CONFIRMED users.
//        confirmed but never signed in (rare: e.g. confirmed some other way) -> auth.resetPasswordForEmail() with the same redirect: the
//          "Reset password" template, which also lands on set-password.html. inviteUserByEmail would refuse this person ("already registered").
//      If the invite call is refused as "already registered" (the person confirmed in the meantime), it falls back to the reset email too.
// The service-role key lives only in this function's secrets. Never put it in the page or the repo.
//
// Deploy (go-live):  supabase functions deploy resend-invite   (verify_jwt on, like the other functions; set PORTAL_ORIGIN like invite-user)
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handle } from './handler.js'

Deno.serve((req) => handle(req, createClient, (k) => Deno.env.get(k)))
