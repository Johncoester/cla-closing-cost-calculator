// Supabase Edge Function: invite-user   (UNTESTED against a live project; written to the documented APIs)
//
// The browser calls this with the signed-in user's JWT. The function:
//   1. calls public.create_invitation() AS THE CALLER (so the database decides who may invite whom),
//   2. only then uses the service-role key to have Supabase Auth email the invite.
// The service-role key lives only in this function's secrets (SUPABASE_SERVICE_ROLE_KEY is
// provided automatically to Edge Functions). Never put it in the page or the repo.
//
// Deploy later (John, after the Supabase project exists):  supabase functions deploy invite-user
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('PORTAL_ORIGIN') ?? '*',   // set PORTAL_ORIGIN=https://quote.clatitle.com
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'not signed in' }, 401)

  const { email, role, repId, cellPhone, isRep, asRep, redirectTo } = await req.json().catch(() => ({}))
  if (typeof email !== 'string' || !['rep', 'client', 'super_admin'].includes(role)) {
    return json({ error: 'email and role are required' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })

  // 1. database rules decide (admin: any role; rep: clients only, assigned to themselves).
  //    isRep: an admin inviting another super admin who ALSO works as a rep. asRep: an admin+rep inviting from the rep
  //    dashboard (rep rules apply; it can only reduce privileges). Both are re-checked by create_invitation().
  const { error: rpcError } = await asCaller.rpc('create_invitation', {
    p_email: email, p_role: role, p_rep_id: repId ?? null,
    p_is_rep: isRep === true, p_as_rep: asRep === true,
    p_cell_phone: typeof cellPhone === 'string' && cellPhone.trim() ? cellPhone : null,   // optional; the database validates and normalizes to +1XXXXXXXXXX
  })
  if (rpcError) return json({ error: rpcError.message }, rpcError.code === '42501' ? 403 : 400)

  // 2. send the invite email through Supabase Auth (custom SMTP must be configured)
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), { redirectTo })
  if (inviteError) return json({ error: inviteError.message }, 400)

  return json({ ok: true })
})
