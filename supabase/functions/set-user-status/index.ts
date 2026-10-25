// Supabase Edge Function: set-user-status   (UNTESTED against a live project)
// Disable / re-enable a user. The database function public.admin_set_status() (migration 10) decides who may:
//   super admin  anyone except themselves, and never the last active super admin
//   admin        reps and clients only (an admin or super admin target is refused with 42501 -> HTTP 403)
// and writes the audit row. Only AFTER the database accepted it does this function ban (or unban) the
// Auth user so existing sessions stop refreshing, so a refused request never bans anyone.
// Needs the service-role key (server side only).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('PORTAL_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'not signed in' }, 401)
  const { userId, status } = await req.json().catch(() => ({}))
  if (typeof userId !== 'string' || !['active', 'disabled'].includes(status)) return json({ error: 'userId and status required' }, 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
  const { error } = await asCaller.rpc('admin_set_status', { p_user: userId, p_status: status })
  if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400)

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: banError } = await admin.auth.admin.updateUserById(userId, { ban_duration: status === 'disabled' ? '876000h' : 'none' })
  if (banError) return json({ error: banError.message }, 500)
  return json({ ok: true })
})
