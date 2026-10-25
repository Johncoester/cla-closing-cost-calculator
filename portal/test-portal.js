// Contract tests for the portal adapters (no browser, no network). Run:  node portal/test-portal.js
// Loads the real scripts into a jsdom window: the MOCK adapter against sample data, and the SUPABASE adapter
// against a fake supabase-js client (checks which tables/functions it calls and how rows map).
const fs = require("fs"), path = require("path"), assert = require("assert");
const { JSDOM } = require("jsdom");
const dir = path.join(__dirname, "js");
function boot() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/portal/", runScripts: "outside-only" });
  const w = dom.window; w.crypto.randomUUID = require("crypto").randomUUID;
  for (const f of ["mock-data", "mock-adapter", "supabase-adapter", "auth-adapter", "portal-ui"]) w.eval(fs.readFileSync(path.join(dir, f + ".js"), "utf8"));
  return w;
}
let pass = 0; const ok = (n) => { pass++; console.log("ok " + n); };
const fakeFile = (type, size, bytes) => ({ type, size, slice: () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }) });
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0], PNG = [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10];

(async () => {
  const w = boot(), CLA = w.CLA, id = (k) => "00000000-0000-4000-8000-0000000000" + k;
  const A = CLA.createMockAdapter({}), as = async (email) => { w.localStorage.removeItem("cla_portal_mock_session"); await A.signIn(email, "x"); };
  const reject = async (p, re, name) => { try { await p; assert.fail("should have thrown: " + name); } catch (e) { assert.ok(re.test(e.message), name + " -> " + e.message); ok(name); } };

  // photo rules
  assert.strictEqual(await CLA.validatePhoto(fakeFile("image/jpeg", 50000, JPG)), ""); ok("jpeg accepted");
  assert.strictEqual(await CLA.validatePhoto(fakeFile("image/png", 50000, PNG)), ""); ok("png accepted");
  assert.match(await CLA.validatePhoto(fakeFile("image/gif", 5000, JPG)), /JPEG or PNG/); ok("gif refused");
  assert.match(await CLA.validatePhoto(fakeFile("image/jpeg", 2 * 1048576 + 1, JPG)), /2 MB/); ok("over 2 MB refused");
  assert.strictEqual(await CLA.validatePhoto(fakeFile("image/jpeg", 2 * 1048576, JPG)), ""); ok("exactly 2 MB accepted");
  assert.match(await CLA.validatePhoto(fakeFile("image/jpeg", 5000, [0x4d, 0x5a, 0, 0, 0, 0, 0, 0])), /not really/); ok("renamed non-image refused");
  assert.match(await CLA.validatePhoto(fakeFile("image/png", 5000, JPG)), /not really/); ok("png label on jpeg bytes refused");
  assert.match(CLA.passwordProblems("short").join(), /12/); assert.strictEqual(CLA.passwordProblems("Abcdefghijk1").length, 0); ok("password rules");
  assert.strictEqual(CLA.safeNext("//evil.com/x.html"), null); assert.strictEqual(CLA.safeNext("https://evil.com"), null); assert.strictEqual(CLA.safeNext("rep.html"), "rep.html"); ok("next-redirect is same-folder only");

  // auth
  await reject(A.signIn("nobody@example.com", "x"), /Invalid email or password/, "unknown email");
  await reject(A.signIn("dee.disabled@example.com", "x"), /Invalid email or password/, "disabled user cannot sign in (same message)");
  await reject(A.signIn("sam.agent@example.com", ""), /password/i, "empty password refused");
  w.localStorage.clear(); await reject(A.listMyQuotes(), /sign in/i, "signed out reads nothing");

  // rep isolation
  await as("sample.rep.jane@clatitle.com");
  let cl = await A.listMyClients(); assert.strictEqual(cl.length, 2); assert.strictEqual(cl.map((c) => c.quoteCount).sort().join(), "1,3"); ok("Jane sees her 2 clients with 3 + 1 quotes");
  assert.strictEqual((await A.listQuotesForClient(id("c5"))).length, 0); ok("Jane cannot read Omar's quotes (other rep)");
  assert.strictEqual((await A.listQuotesForClient(id("c3"))).length, 0); ok("Jane cannot read unassigned Pat's quotes");
  await reject(A.adminListUsers(), /Admins only/, "rep cannot list all users");
  assert.strictEqual(await A.getAvatarUrl({ id: id("c5"), avatarPath: "x" }), null); ok("rep gets no photo for another rep's client");
  assert.ok(await A.getAvatarUrl({ id: id("c1"), avatarPath: id("c1") + "/avatar" })); ok("rep sees assigned client's photo");
  await reject(A.inviteClient("nina.newagent@example.com"), /another rep/, "rep cannot invite another rep's client");
  await A.inviteClient("fresh@example.com"); assert.ok((await A.listMyClients()).some((c) => c.email === "fresh@example.com" && c.pending)); ok("rep invites a client (pending, assigned to rep)");
  await reject(A.inviteClient("sam.agent@example.com"), /already has an account/, "cannot invite existing account");

  // client
  await as("sam.agent@example.com");
  let qs = await A.listMyQuotes(); assert.strictEqual(qs.length, 3); ok("Sam sees her 3 live quotes");
  const rep = await A.getMyRep(); assert.strictEqual(rep.firstName, "Jane"); assert.ok(!("companyName" in rep)); ok("client's rep: name/phone/email/photo only");
  const snap = { quoteType: "buyer", label: "t", state: "MD", county: "Howard", propertyAddress: "1 A St", price: 400000, inputs: { a: 1 }, results: { headline: { value: 1 } }, feeVersion: "x" };
  const q = await A.saveQuote(snap);
  assert.strictEqual(q.ownerId, id("c1")); assert.strictEqual(q.repId, id("b1")); ok("saved quote: owner = me, rep set server-side");
  const days = (new Date(q.expiresAt) - new Date(q.createdAt)) / 86400000; assert.ok(Math.abs(days - 30) < 0.001); ok("expires 30 days after creation");
  const q2 = await A.updateQuote(q.id, Object.assign({}, snap, { label: "t2" })); assert.strictEqual(q2.expiresAt, q.expiresAt); assert.strictEqual(q2.label, "t2"); ok("update keeps the original expiry");
  await A.deleteQuote(q.id); assert.strictEqual((await A.listMyQuotes()).length, 3); ok("client delete hides the quote");
  assert.strictEqual(await A.getQuote(id("f04")), null); ok("other/expired quote id returns nothing");
  await reject(A.listMyClients(), /Reps only/, "client cannot list clients");
  // expiry: age a quote past 30 days in storage
  const st = JSON.parse(w.localStorage.getItem("cla_portal_mock_v1")); st.quotes.find((x) => x.id === id("f01")).expiresAt = new Date(Date.now() - 1000).toISOString(); w.localStorage.setItem("cla_portal_mock_v1", JSON.stringify(st));
  assert.strictEqual((await A.listMyQuotes()).length, 2); ok("quote past its 30 days disappears at once");
  await reject(A.uploadAvatar(fakeFile("image/gif", 5000, JPG)), /JPEG or PNG/, "adapter re-checks the photo rules on upload");

  // pat: no rep
  await as("pat.homes@example.com"); assert.strictEqual(await A.getMyRep(), null); ok("unassigned client has no rep");

  // admin
  await as("sample.admin@clatitle.com");
  assert.strictEqual((await A.adminListUsers()).length, 8); ok("admin lists all users");
  const aq = await A.adminListQuotes(); assert.ok(aq.length >= 7); ok("admin sees all live quotes");
  await reject(A.adminSetRole(id("a1"), "client"), /own role/, "admin cannot change own role");
  await reject(A.adminInvite({ email: "r@gmail.com", role: "rep" }), /clatitle/, "rep invite needs CLA email");
  await A.adminInvite({ email: "new.rep@clatitle.com", role: "rep" }); ok("admin invites a rep");
  await A.adminReassign("pat.homes@example.com", id("b2")); await as("sample.rep.marcus@clatitle.com"); assert.ok((await A.listMyClients()).some((c) => c.email === "pat.homes@example.com")); ok("reassign moves the client to the new rep");
  await as("sample.admin@clatitle.com"); await A.adminSetStatus(id("c1"), "disabled"); await reject(A.signIn("sam.agent@example.com", "x"), /Invalid/, "disabled user locked out");
  const log = await A.adminAuditLog(50); assert.ok(log.some((r) => r.action === "user_disabled") && log.some((r) => r.action === "invite_sent")); ok("admin actions land in the audit log");

  // ---- Supabase adapter against a fake client ----
  const calls = [];
  const chain = (table, rows) => { const o = { _t: table };
    for (const m of ["select", "eq", "in", "order", "limit", "insert", "update", "delete", "upsert"]) o[m] = (...a) => { calls.push([table, m, a]); return o; };
    o.maybeSingle = o.single = async () => ({ data: Array.isArray(rows) ? rows[0] : rows, error: null });
    o.then = (res) => res({ data: rows, error: null }); return o; };
  const fake = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: id("c1"), email: "sam.agent@example.com" } } } }) },
    from: (t) => chain(t, t === "quotes" ? [{ id: "q1", owner_id: id("c1"), rep_id: id("b1"), quote_type: "buyer", price: "525000.00", created_at: "x", expires_at: "y", inputs: {}, results: {}, deleted_at: null }] : [{ id: id("c1"), role: "client", status: "active", email: "e", first_name: "Sam", last_name: "A", company_name: "Acme", is_complete: true }]),
    rpc: async (n, a) => { calls.push(["rpc", n, a]); return { data: n === "get_my_rep" ? [{ id: id("b1"), first_name: "Jane", last_name: "R", phone: "1", email: "j@clatitle.com", avatar_path: "p" }] : null, error: null }; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }) }) },
    functions: { invoke: async (n, o) => { calls.push(["fn", n, o]); return { data: { ok: true }, error: null }; } } }) };
  const S = CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, fake);
  const mine = await S.listMyQuotes(); assert.strictEqual(mine[0].price, 525000); assert.strictEqual(mine[0].quoteType, "buyer"); ok("supabase: quote rows map to DTOs");
  await S.saveQuote(snap); const ins = calls.find((c) => c[0] === "quotes" && c[1] === "insert")[2][0];
  assert.ok(!("expires_at" in ins) && !("rep_id" in ins) && !("created_at" in ins) && ins.owner_id === id("c1")); ok("supabase: save sends no expiry/rep/created_at (server sets them)");
  await S.updateQuote("q1", snap); const upd = calls.find((c) => c[0] === "quotes" && c[1] === "update")[2][0]; assert.ok(!("expires_at" in upd) && !("deleted_at" in upd) && !("owner_id" in upd)); ok("supabase: update cannot touch expiry/owner/deleted_at");
  assert.strictEqual((await S.getMyRep()).firstName, "Jane"); ok("supabase: get_my_rep RPC maps");
  await S.deleteQuote("q1"); assert.ok(calls.some((c) => c[0] === "rpc" && c[1] === "delete_my_quote")); ok("supabase: delete goes through delete_my_quote RPC");
  await S.adminInvite({ email: "a@b.com", role: "client", repId: "r" }); assert.ok(calls.some((c) => c[0] === "fn" && c[1] === "invite-user")); ok("supabase: invites go through the Edge Function (no service key in the browser)");
  await S.adminSetStatus("u", "disabled"); assert.ok(calls.some((c) => c[0] === "fn" && c[1] === "set-user-status")); ok("supabase: disable goes through the Edge Function");
  assert.strictEqual(await S.getAvatarUrl({ id: id("b1"), avatarPath: "p" }), "https://signed"); ok("supabase: photos via signed URLs");
  assert.ok(!/service_role|SERVICE_ROLE/.test(fs.readFileSync(path.join(dir, "supabase-adapter.js"), "utf8").replace(/\/\*[\s\S]*?\*\//, ""))); ok("no service-role key referenced in browser code");
  console.log("\nALL PASS (" + pass + " checks)");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
