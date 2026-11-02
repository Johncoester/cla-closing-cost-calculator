// resend-invite request handler (plain JavaScript so it is tested locally with Node: supabase/functions/resend-invite/test-handler.js).
// index.ts wires it to Deno.serve with the real supabase-js createClient. See index.ts for what it does and why.
const cors = (env) => ({
  'Access-Control-Allow-Origin': env('PORTAL_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
})
// database refusal -> HTTP status: not allowed 403, no such user 404, signed in / disabled 409, too soon 429
export const STATUS = { '42501': 403, 'P0002': 404, '55000': 409, 'PT429': 429 }
const alreadyRegistered = (m) => /already (been )?registered|email_exists|already exists/i.test(String(m || ''))

// make = supabase-js createClient; env = (name) => value (Deno.env.get in production)
export async function handle(req, make, env) {
  const h = cors(env)
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'not signed in' }, 401)
  const { userId, redirectTo } = await req.json().catch(() => ({}))
  if (typeof userId !== 'string' || !userId) return json({ error: 'userId is required' }, 400)

  const url = env('SUPABASE_URL')
  // 1. permission + bookkeeping AS THE CALLER (migration 20): the database checks the caller's role and, for a rep, the ACTIVE assignment
  const asCaller = make(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } } })
  const { data, error } = await asCaller.rpc('admin_resend_invite', { p_user: userId })
  if (error) return json({ error: error.message }, STATUS[error.code ?? ''] ?? 400)
  const email = String((data && data.email) || '')
  if (!email) return json({ error: 'no email for this person' }, 400)

  // 2. only now the service-role client sends the email (to the address the database returned, never one from the browser)
  const admin = make(url, env('SUPABASE_SERVICE_ROLE_KEY'))
  const opts = typeof redirectTo === 'string' && redirectTo ? { redirectTo } : undefined
  if (!data.confirmed) {
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, opts)
    if (!inviteError) return json({ ok: true, via: 'invite', sentAt: new Date().toISOString() })
    if (!alreadyRegistered(inviteError.message)) return json({ error: inviteError.message }, 502)
  }
  const { error: resetError } = await admin.auth.resetPasswordForEmail(email, opts)
  if (resetError) return json({ error: resetError.message }, 502)
  return json({ ok: true, via: 'recovery', sentAt: new Date().toISOString() })
}
