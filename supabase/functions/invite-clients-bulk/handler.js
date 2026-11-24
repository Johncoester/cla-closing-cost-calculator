// invite-clients-bulk request handler (plain JavaScript so it is tested locally with Node:
// supabase/functions/invite-clients-bulk/test-handler.mjs).
// index.ts wires it to Deno.serve with the real supabase-js createClient.
const cors = (env) => ({
  'Access-Control-Allow-Origin': env('PORTAL_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
})
const STATUS = { '42501': 403, 'PT429': 429 }
const rateLimited = (m) => /rate limit|too many|over_email_send_rate_limit|email rate limit exceeded/i.test(String(m || ''))
const alreadyHasAccount = (m) => /already has an account/i.test(String(m || ''))
const MAX = 50

function slim(row) {
  const t = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  return {
    first_name: t(row.first_name ?? row.firstName).slice(0, 120),
    last_name: t(row.last_name ?? row.lastName).slice(0, 120),
    email: t(row.email).slice(0, 200),
    cell_phone: t(row.cell_phone ?? row.cellPhone ?? row.phone).slice(0, 40),
    company: t(row.company ?? row.company_name ?? row.companyName).slice(0, 200),
    rep_email: t(row.rep_email ?? row.repEmail).slice(0, 200),
  }
}

function resultRow(p, extra) {
  return Object.assign({
    index: p.index,
    email: p.email || '',
    firstName: p.first_name || '',
    lastName: p.last_name || '',
    company: p.company_name || '',
    cellPhone: p.cell_phone || null,
    repEmail: p.rep_email || '',
    status: p.status,
    reason: p.reason || null,
  }, extra || {})
}

// make = supabase-js createClient; env = (name) => value (Deno.env.get in production)
export async function handle(req, make, env) {
  const h = cors(env)
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'not signed in' }, 401)

  const body = await req.json().catch(() => ({}))
  const incoming = Array.isArray(body.rows) ? body.rows : null
  if (!incoming) return json({ error: 'rows must be an array' }, 400)
  if (!incoming.length) return json({ error: 'Add at least one client row.' }, 400)
  if (incoming.length > MAX) return json({ error: 'Upload at most 50 clients at a time.' }, 400)
  const rows = incoming.map(slim)
  const redirectTo = typeof body.redirectTo === 'string' && body.redirectTo ? body.redirectTo : undefined

  const url = env('SUPABASE_URL')
  const asCaller = make(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } } })

  const preview = await asCaller.rpc('admin_preview_bulk_clients', { p_rows: rows })
  if (preview.error) return json({ error: preview.error.message }, STATUS[preview.error.code ?? ''] ?? 400)
  const classified = Array.isArray(preview.data) ? preview.data : []

  const rem = await asCaller.rpc('admin_bulk_invite_remaining')
  if (rem.error) return json({ error: rem.error.message }, STATUS[rem.error.code ?? ''] ?? 400)
  let remaining = Number(rem.data)
  if (!Number.isFinite(remaining)) remaining = 0

  const admin = make(url, env('SUPABASE_SERVICE_ROLE_KEY'))
  const opts = redirectTo ? { redirectTo } : undefined
  const out = []
  let invited = 0, skipped = 0, rejected = 0, held = 0, failed = 0
  let stoppedReason = null

  for (const p of classified) {
    if (p.status === 'skip') { skipped++; out.push(resultRow(p)); continue }
    if (p.status !== 'invite') { rejected++; out.push(resultRow(p)); continue }
    if (stoppedReason || remaining <= 0) {
      held++
      out.push(resultRow(p, { status: 'held', reason: remaining <= 0 && !stoppedReason
        ? 'Hourly invite limit reached. Wait before sending more.'
        : 'Stopped because the email limit was reached. Try again later.' }))
      if (!stoppedReason) stoppedReason = 'hourly_cap'
      continue
    }

    const created = await asCaller.rpc('create_invitation', {
      p_email: p.email, p_role: 'client', p_rep_id: p.rep_id,
      p_cell_phone: p.cell_phone || null, p_is_rep: false, p_as_rep: false,
      p_first_name: p.first_name || null, p_last_name: p.last_name || null, p_company_name: p.company_name || null,
    })
    if (created.error) {
      if (alreadyHasAccount(created.error.message)) {
        skipped++; out.push(resultRow(p, { status: 'skip', reason: 'This email already has an account.' })); continue
      }
      failed++; out.push(resultRow(p, { status: 'failed', reason: created.error.message })); continue
    }

    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(p.email, opts)
    if (inviteError) {
      if (rateLimited(inviteError.message)) {
        held++; stoppedReason = 'auth_rate_limit'
        out.push(resultRow(p, { status: 'held', reason: 'The email service rate limit was reached. This invite was recorded; use Resend invite, or try again later.' }))
        continue
      }
      failed++; out.push(resultRow(p, { status: 'failed', reason: inviteError.message })); continue
    }

    const rec = await asCaller.rpc('admin_bulk_invite_record', { p_email: p.email })
    if (rec.error && rec.error.code === 'PT429') {
      // Email went out, but the hourly cap raced us. Count it as invited (the person did get the email).
      remaining = 0
      invited++
      out.push(resultRow(p, { status: 'invited', reason: null }))
      stoppedReason = stoppedReason || 'hourly_cap'
      continue
    }
    if (typeof rec.data === 'number') remaining = rec.data
    else remaining = Math.max(0, remaining - 1)
    invited++
    out.push(resultRow(p, { status: 'invited', reason: null }))
  }

  return json({
    ok: true,
    invited, skipped, rejected, held, failed,
    remainingHour: remaining,
    stoppedReason,
    rows: out,
  })
}
