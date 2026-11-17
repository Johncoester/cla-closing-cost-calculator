// Local tests for the invite-clients-bulk Edge Function handler (Node 18+, no network, no Supabase, no email):
//   node supabase/functions/invite-clients-bulk/test-handler.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const src = readFileSync(new URL('./handler.js', import.meta.url), 'utf8')
const { handle } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-test', PORTAL_ORIGIN: 'https://quotes.clatitle.com' }
const env = (k) => ENV[k]
const JANE = '00000000-0000-4000-8000-0000000000b1'
const previewRow = (over) => Object.assign({
  index: 1, email: 'maya.chen@example.com', first_name: 'Maya', last_name: 'Chen',
  company_name: 'Chen Realty', cell_phone: '+12405550142', rep_email: 'sample.rep.jane@clatitle.com',
  rep_id: JANE, status: 'invite', reason: null,
}, over)
function stub({ preview, remaining = 50, create = { data: { id: 'inv1' }, error: null }, invite = { error: null }, record = { data: 49, error: null } } = {}) {
  const classified = preview ?? [previewRow()]
  const log = { clients: [], rpc: [], invite: [] }
  const make = (url, key, opts) => {
    log.clients.push({ key, auth: opts?.global?.headers?.Authorization ?? null })
    return {
      rpc: async (name, args) => {
        log.rpc.push({ name, args, key })
        if (name === 'admin_preview_bulk_clients') return { data: typeof classified === 'function' ? classified() : classified, error: null }
        if (name === 'admin_bulk_invite_remaining') return { data: remaining, error: null }
        if (name === 'create_invitation') return typeof create === 'function' ? create(args) : create
        if (name === 'admin_bulk_invite_record') return typeof record === 'function' ? record(args) : record
        return { data: null, error: { message: 'unexpected rpc ' + name } }
      },
      auth: { admin: { inviteUserByEmail: async (email, o) => { log.invite.push({ email, o, key }); return typeof invite === 'function' ? invite(email) : invite } } },
    }
  }
  return { make, log }
}
const req = (body, { method = 'POST', auth = 'Bearer caller-jwt' } = {}) =>
  new Request('https://x.supabase.co/functions/v1/invite-clients-bulk', { method, headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: auth } : {}), body: method === 'POST' ? JSON.stringify(body) : undefined })
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok', name) }
const R = '/portal/set-password.html?invite=1'

await ok('OPTIONS answers CORS with the portal origin', async () => {
  const r = await handle(req(null, { method: 'OPTIONS' }), stub().make, env)
  assert.equal(r.status, 200); assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://quotes.clatitle.com')
})
await ok('GET is refused (405)', async () => { assert.equal((await handle(req(null, { method: 'GET' }), stub().make, env)).status, 405) })
await ok('no Authorization header: 401, nothing called', async () => {
  const s = stub(); const r = await handle(req({ rows: [{}] }, { auth: null }), s.make, env)
  assert.equal(r.status, 401); assert.equal(s.log.clients.length, 0)
})
await ok('missing rows: 400, nothing called', async () => {
  const s = stub(); assert.equal((await handle(req({}), s.make, env)).status, 400); assert.equal(s.log.rpc.length, 0)
})
await ok('empty rows: 400', async () => {
  const s = stub(); const r = await handle(req({ rows: [] }), s.make, env)
  assert.equal(r.status, 400); assert.match((await r.json()).error, /at least one/i)
})
await ok('more than 50 rows: 400, nothing called', async () => {
  const s = stub(); const rows = Array.from({ length: 51 }, (_, i) => ({ email: 'a' + i + '@example.com', rep_email: 'sample.rep.jane@clatitle.com' }))
  const r = await handle(req({ rows }), s.make, env)
  assert.equal(r.status, 400); assert.match((await r.json()).error, /at most 50/); assert.equal(s.log.rpc.length, 0)
})
await ok('preview runs AS THE CALLER (anon key + caller JWT) before any service-role client exists', async () => {
  const s = stub(); await handle(req({ rows: [{ email: 'maya.chen@example.com', first_name: 'Maya', last_name: 'Chen', cell_phone: '(240) 555-0142', company: 'Chen Realty', rep_email: 'sample.rep.jane@clatitle.com' }], redirectTo: R }), s.make, env)
  assert.deepEqual(s.log.clients[0], { key: 'anon-test', auth: 'Bearer caller-jwt' })
  assert.equal(s.log.rpc[0].name, 'admin_preview_bulk_clients'); assert.equal(s.log.rpc[0].key, 'anon-test')
  assert.equal(s.log.rpc[1].name, 'admin_bulk_invite_remaining')
  assert.ok(s.log.clients.some((c) => c.key === 'service-test'))
})
await ok('database refusal 42501 (not an admin) -> 403; no email', async () => {
  const make = (url, key, opts) => ({
    rpc: async () => ({ data: null, error: { code: '42501', message: 'Admins only.' } }),
    auth: { admin: { inviteUserByEmail: async () => { throw new Error('should not send') } } },
  })
  const r = await handle(req({ rows: [{ email: 'a@b.com', rep_email: 'r@clatitle.com' }] }), make, env)
  assert.equal(r.status, 403); assert.equal((await r.json()).error, 'Admins only.')
})
await ok('a ready row is invited as role client, with the DATABASE rep id and the set-password redirect', async () => {
  const s = stub(); const r = await handle(req({ rows: [{ email: 'maya.chen@example.com', first_name: 'Maya', role: 'super_admin', rep_id: 'attacker', rep_email: 'sample.rep.jane@clatitle.com' }], redirectTo: R }), s.make, env)
  const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.invited, 1); assert.equal(j.rows[0].status, 'invited')
  const inv = s.log.rpc.find((x) => x.name === 'create_invitation')
  assert.equal(inv.args.p_role, 'client'); assert.equal(inv.args.p_rep_id, JANE); assert.equal(inv.args.p_as_rep, false); assert.equal(inv.args.p_is_rep, false)
  assert.equal(inv.args.p_first_name, 'Maya'); assert.deepEqual(s.log.invite, [{ email: 'maya.chen@example.com', o: { redirectTo: R }, key: 'service-test' }])
  assert.ok(s.log.rpc.some((x) => x.name === 'admin_bulk_invite_record'))
})
await ok('existing accounts are skipped and no email is sent for them', async () => {
  const s = stub({ preview: [previewRow({ status: 'skip', reason: 'This email already has an account.', email: 'sam.agent@example.com', rep_id: null })] })
  const j = await (await handle(req({ rows: [{ email: 'sam.agent@example.com', rep_email: 'sample.rep.jane@clatitle.com' }] }), s.make, env)).json()
  assert.equal(j.skipped, 1); assert.equal(j.invited, 0); assert.equal(s.log.invite.length, 0)
  assert.ok(!s.log.rpc.some((x) => x.name === 'create_invitation'))
})
await ok('rejected rows (blank or unknown rep) are reported and not invited', async () => {
  const s = stub({ preview: [previewRow({ status: 'reject', reason: 'A sales rep email is required.', email: 'x@y.com', rep_id: null, rep_email: '' })] })
  const j = await (await handle(req({ rows: [{ email: 'x@y.com' }] }), s.make, env)).json()
  assert.equal(j.rejected, 1); assert.equal(j.invited, 0); assert.equal(s.log.invite.length, 0)
})
await ok('hourly cap already 0: ready rows are held, no email', async () => {
  const s = stub({ remaining: 0 })
  const j = await (await handle(req({ rows: [{ email: 'maya.chen@example.com', rep_email: 'sample.rep.jane@clatitle.com' }] }), s.make, env)).json()
  assert.equal(j.held, 1); assert.equal(j.invited, 0); assert.equal(j.stoppedReason, 'hourly_cap'); assert.equal(s.log.invite.length, 0)
})
await ok('Auth email rate limit mid-batch: first succeeds, later ready rows are held', async () => {
  const preview = [previewRow({ index: 1, email: 'one@example.com' }), previewRow({ index: 2, email: 'two@example.com' }), previewRow({ index: 3, email: 'three@example.com' })]
  let nInvite = 0
  const s = stub({ preview, invite: () => { nInvite++; return nInvite === 1 ? { error: null } : { error: { message: 'email rate limit exceeded' } } } })
  const j = await (await handle(req({ rows: preview.map((p) => ({ email: p.email, rep_email: p.rep_email })), redirectTo: R }), s.make, env)).json()
  assert.equal(j.invited, 1); assert.equal(j.held, 2); assert.equal(j.stoppedReason, 'auth_rate_limit')
  assert.equal(j.rows[0].status, 'invited'); assert.equal(j.rows[1].status, 'held'); assert.equal(j.rows[2].status, 'held')
  assert.equal(s.log.invite.length, 2) // second attempt hits the limit; third is not attempted
})
await ok('a non-rate-limit email error is failed and the batch continues', async () => {
  const preview = [previewRow({ index: 1, email: 'bad@example.com' }), previewRow({ index: 2, email: 'ok@example.com' })]
  const s = stub({ preview, invite: (email) => email.startsWith('bad') ? { error: { message: 'Error sending invite email' } } : { error: null } })
  const j = await (await handle(req({ rows: preview.map((p) => ({ email: p.email, rep_email: p.rep_email })), redirectTo: R }), s.make, env)).json()
  assert.equal(j.failed, 1); assert.equal(j.invited, 1); assert.equal(j.stoppedReason, null)
  assert.equal(j.rows[0].status, 'failed'); assert.equal(j.rows[1].status, 'invited')
})
await ok('create_invitation racing to an existing account is reported as skipped', async () => {
  const s = stub({ create: { data: null, error: { code: '23505', message: 'that email already has an account' } } })
  const j = await (await handle(req({ rows: [{ email: 'maya.chen@example.com', rep_email: 'sample.rep.jane@clatitle.com' }] }), s.make, env)).json()
  assert.equal(j.skipped, 1); assert.equal(s.log.invite.length, 0)
})
await ok('no redirectTo given: Supabase default (no options)', async () => {
  const s = stub(); await handle(req({ rows: [{ email: 'maya.chen@example.com', rep_email: 'j@clatitle.com' }] }), s.make, env)
  assert.equal(s.log.invite[0].o, undefined)
})
console.log(`ALL PASS (${n} checks)`)
