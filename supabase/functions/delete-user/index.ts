// Supabase Edge Function: delete-user   (UNTESTED against a live project; NOT deployed)
// Permanently delete a DISABLED user. The database function public.admin_delete_user() (migration 18) decides who may and does ALL the data work
// in one transaction: only a disabled person; admins and super admins by the same reach as disabling (an admin never a super admin, nobody themselves);
// the typed email must match; a rep with active clients needs a successor; it removes the profile (and with it the quotes the person owned and the
// photo row), moves the clients, keeps feedback / quotes of others without a name, and writes the 'user_deleted' audit row.
// Only AFTER the database accepted it does this function remove the photo FILE and the Supabase Auth user (the sign-in record), so a refused
// request never deletes anything. Needs the service-role key (server side only).
//
// If the Auth deletion fails after the database part succeeded, the person is already gone from the portal and cannot sign in (banned, no profile).
// Pressing Delete again is not possible (the row is gone), so this function also finishes a half-done delete: when the database says "no such user"
// (that answer only reaches an admin) and an Auth user with that id AND the typed email still exists, is banned, and has no profile, it deletes it.
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
  const { userId, confirmEmail, reassignTo } = await req.json().catch(() => ({}))
  if (typeof userId !== 'string' || typeof confirmEmail !== 'string') return json({ error: 'userId and confirmEmail required' }, 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data, error } = await asCaller.rpc('admin_delete_user', {
    p_user: userId, p_confirm_email: confirmEmail, p_reassign_to: typeof reassignTo === 'string' && reassignTo ? reassignTo : null,
  })
  if (error) {
    if (error.code === 'P0002') {
      // no profile: maybe a half-done earlier delete. Finish it only for a banned Auth user whose email is the one just typed.
      const { data: au } = await admin.auth.admin.getUserById(userId)
      const u = au?.user
      if (u && (u.email ?? '').toLowerCase() === confirmEmail.trim().toLowerCase() && u.banned_until && new Date(u.banned_until) > new Date()) {
        const { error: delErr } = await admin.auth.admin.deleteUser(userId)
        if (delErr) return json({ error: delErr.message }, 500)
        return json({ ok: true, finished: true })
      }
    }
    return json({ error: error.message }, error.code === '42501' ? 403 : 400)
  }

  // the database part is done: now the files and the sign-in record (best effort for the photo, retried once for the Auth user)
  await admin.storage.from('avatars').remove([`${userId}/avatar`]).catch(() => {})
  let { error: delErr } = await admin.auth.admin.deleteUser(userId)
  if (delErr) ({ error: delErr } = await admin.auth.admin.deleteUser(userId))
  if (delErr) return json({ error: 'The person was removed from the portal, but their sign-in record could not be deleted: ' + delErr.message + ' (they cannot sign in). Try Delete again later.', partial: true, summary: data }, 500)
  return json({ ok: true, summary: data })
})
