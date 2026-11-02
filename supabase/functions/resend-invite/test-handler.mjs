// Local tests for the resend-invite Edge Function handler (Node 18+, no network, no Supabase, no email):  node supabase/functions/resend-invite/test-handler.mjs
// A stub stands in for supabase-js: it records which client (caller / service role) was made, the RPC call, and every email call.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const src = readFileSync(new URL('./handler.js', import.meta.url), 'utf8')
const { handle } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-test', PORTAL_ORIGIN: 'https://quotes.clatitle.com' }
const env = (k) => ENV[k]
function stub({ rpc = { data: { email: 'db.person@example.com', role: 'client', confirmed: false, resend_count: 1 }, error: null }, invite = { error: null }, reset = { error: null } } = {}) {
  const log = { clients: [], rpc: [], invite: [], reset: [] }
  const make = (url, key, opts) => {
    log.clients.push({ key, auth: opts?.global?.headers?.Authorization ?? null })
    return {
      rpc: async (name, args) => { log.rpc.push({ name, args, key }); return rpc },
      auth: {
        admin: { inviteUserByEmail: async (email, o) => { log.invite.push({ email, o, key }); return invite } },
        resetPasswordForEmail: async (email, o) => { log.reset.push({ email, o, key }); return reset },
      },
    }
  }
  return { make, log }
}
const req = (body, { method = 'POST', auth = 'Bearer caller-jwt' } = {}) =>
  new Request('https://x.supabase.co/functions/v1/resend-invite', { method, headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: auth } : {}), body: method === 'POST' ? JSON.stringify(body) : undefined })
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok', name) }
const R = '/portal/set-password.html?invite=1'

await ok('OPTIONS answers CORS with the portal origin', async () => { const r = await handle(req(null, { method: 'OPTIONS' }), stub().make, env); assert.equal(r.status, 200); assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://quotes.clatitle.com') })
await ok('GET is refused (405)', async () => { assert.equal((await handle(req(null, { method: 'GET' }), stub().make, env)).status, 405) })
await ok('no Authorization header: 401, nothing called', async () => { const s = stub(); const r = await handle(req({ userId: 'u1' }, { auth: null }), s.make, env); assert.equal(r.status, 401); assert.equal(s.log.clients.length, 0) })
await ok('missing userId: 400, nothing called', async () => { const s = stub(); assert.equal((await handle(req({}), s.make, env)).status, 400); assert.equal(s.log.rpc.length, 0) })
await ok('permission check runs AS THE CALLER (anon key + caller JWT), before any service-role client exists', async () => {
  const s = stub(); await handle(req({ userId: 'u1', redirectTo: R }), s.make, env)
  assert.deepEqual(s.log.clients[0], { key: 'anon-test', auth: 'Bearer caller-jwt' }); assert.deepEqual(s.log.rpc, [{ name: 'admin_resend_invite', args: { p_user: 'u1' }, key: 'anon-test' }])
  assert.equal(s.log.clients[1].key, 'service-test') })
for (const [code, status, what] of [['42501', 403, "not allowed (a rep: not their client; another rep's client; staff; unassigned)"], ['P0002', 404, 'no such user'], ['55000', 409, 'already signed in / disabled'], ['PT429', 429, 'sent less than 60 seconds ago'], ['XX000', 400, 'anything else']]) {
  await ok(`database refusal ${code} (${what}) -> ${status}; no service-role client, no email`, async () => {
    const s = stub({ rpc: { data: null, error: { code, message: 'refused ' + code } } }); const r = await handle(req({ userId: 'u1' }), s.make, env)
    assert.equal(r.status, status); assert.equal((await r.json()).error, 'refused ' + code); assert.equal(s.log.clients.length, 1); assert.equal(s.log.invite.length + s.log.reset.length, 0) })
}
await ok('never confirmed: the same invite email again (inviteUserByEmail), to the DATABASE email (not one sent by the browser), with the set-password redirect', async () => {
  const s = stub(); const r = await handle(req({ userId: 'u1', email: 'attacker@example.com', redirectTo: R }), s.make, env); const j = await r.json()
  assert.equal(r.status, 200); assert.equal(j.via, 'invite'); assert.ok(j.sentAt); assert.deepEqual(s.log.invite, [{ email: 'db.person@example.com', o: { redirectTo: R }, key: 'service-test' }]); assert.equal(s.log.reset.length, 0) })
await ok('confirmed but never signed in: a set-password (reset) email instead, same redirect', async () => {
  const s = stub({ rpc: { data: { email: 'db.person@example.com', confirmed: true }, error: null } }); const j = await (await handle(req({ userId: 'u1', redirectTo: R }), s.make, env)).json()
  assert.equal(j.via, 'recovery'); assert.equal(s.log.invite.length, 0); assert.deepEqual(s.log.reset, [{ email: 'db.person@example.com', o: { redirectTo: R }, key: 'service-test' }]) })
await ok('invite refused as already registered (confirmed in the meantime): falls back to the reset email', async () => {
  const s = stub({ invite: { error: { message: 'A user with this email address has already been registered' } } }); const j = await (await handle(req({ userId: 'u1', redirectTo: R }), s.make, env)).json()
  assert.equal(j.via, 'recovery'); assert.equal(s.log.invite.length, 1); assert.equal(s.log.reset.length, 1) })
await ok('any other email error: 502 with the message, no fallback', async () => {
  const s = stub({ invite: { error: { message: 'Error sending invite email' } } }); const r = await handle(req({ userId: 'u1' }), s.make, env)
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Error sending invite email'); assert.equal(s.log.reset.length, 0) })
await ok('reset email failure: 502', async () => {
  const s = stub({ rpc: { data: { email: 'db.person@example.com', confirmed: true }, error: null }, reset: { error: { message: 'smtp down' } } }); assert.equal((await handle(req({ userId: 'u1' }), s.make, env)).status, 502) })
await ok('no redirectTo given: Supabase default (no options)', async () => { const s = stub(); await handle(req({ userId: 'u1' }), s.make, env); assert.equal(s.log.invite[0].o, undefined) })
console.log(`ALL PASS (${n} checks)`)
