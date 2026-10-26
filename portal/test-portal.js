// Contract tests for the portal adapters (no browser, no network). Run:  node portal/test-portal.js
// Loads the real scripts into a jsdom window: the MOCK adapter against sample data, and the SUPABASE adapter
// against a fake supabase-js client (checks which tables/functions it calls and how rows map).
const fs = require("fs"), path = require("path"), assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
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

  // ---- cell phone ----
  // helpers (shared by the screens and both adapters)
  for (const [i, o] of [["(240) 555-0142", "+12405550142"], ["240.555.0142", "+12405550142"], ["240 555 0142", "+12405550142"], ["1 (240) 555-0142", "+12405550142"],
    ["+1 240-555-0142", "+12405550142"], ["+12405550142", "+12405550142"], ["12405550142", "+12405550142"], ["  ", ""], [null, ""], ["", ""]])
    assert.strictEqual(CLA.normalizePhone(i), o, "normalize " + i);
  for (const bad of ["555-0142", "240-555-014", "040-555-0142", "140-555-0142", "240-155-0142", "240-555-0142 x5", "call 2405550142", "+44 20 7946 0958", "1 1240 555 0142", "abc"])
    assert.strictEqual(CLA.normalizePhone(bad), null, "should be invalid: " + bad);
  ok("cell rules: normalize to +1XXXXXXXXXX, blank = none, bad numbers = null (same rules as the database)");
  let typed = ""; for (const ch of "2405550142") typed = CLA.formatPhoneInput(typed + ch);
  assert.strictEqual(typed, "(240) 555-0142"); assert.strictEqual(CLA.formatPhoneInput("24"), "24"); assert.strictEqual(CLA.formatPhoneInput("2405"), "(240) 5");
  assert.strictEqual(CLA.formatPhoneInput("240555"), "(240) 555"); assert.strictEqual(CLA.formatPhoneInput("+1 240 555 0142 999"), "(240) 555-0142"); assert.strictEqual(CLA.formatPhoneInput("abc"), "");
  ok("cell input formats as you type: (240) 555-0142, drops +1, ignores letters, caps at 10 digits");
  assert.strictEqual(CLA.displayPhone("+12405550142"), "(240) 555-0142"); assert.strictEqual(CLA.displayPhone("240-555-9999"), "240-555-9999"); assert.strictEqual(CLA.displayPhone(null), "");
  assert.strictEqual(CLA.telHref("(240) 555-0142"), "tel:+12405550142"); assert.strictEqual(CLA.telHref("nope"), null);
  assert.strictEqual(CLA.telLink("+12405550142"), '<a class="tel" href="tel:+12405550142">(240) 555-0142</a>'); assert.strictEqual(CLA.telLink(null), ""); assert.strictEqual(CLA.telLink("x"), "");
  ok("tel: links are built from the stored number; nothing for empty/invalid");

  await as("sam.agent@example.com");
  assert.strictEqual((await A.getMyProfile()).cellPhone, "+12405550132"); ok("client profile carries cellPhone (E.164)");
  assert.strictEqual((await A.getMyRep()).cellPhone, "+13015550112"); ok("client sees their rep's cell (Jane)");
  assert.strictEqual((await A.updateMyProfile({ cellPhone: "(240) 555-0199" })).cellPhone, "+12405550199"); ok("client saves own cell typed as (240) 555-0199 -> +12405550199");
  await reject(A.updateMyProfile({ cellPhone: "12345" }), /valid 10-digit US cell/, "invalid cell refused with a message");
  assert.strictEqual((await A.getMyProfile()).cellPhone, "+12405550199"); ok("a refused edit keeps the old cell");
  assert.strictEqual((await A.updateMyProfile({ firstName: "Sam" })).cellPhone, "+12405550199"); ok("editing other fields leaves the cell alone");
  assert.strictEqual((await A.updateMyProfile({ cellPhone: "" })).cellPhone, null); ok("clearing the cell stores nothing (optional for clients)");
  await A.updateMyProfile({ cellPhone: "240.555.0132" });
  await as("pat.homes@example.com"); assert.strictEqual((await A.getMyProfile()).cellPhone, null); ok("a client without a cell is valid (Pat)");
  await as("sample.rep.jane@clatitle.com");
  assert.strictEqual((await A.updateMyProfile({ cellPhone: "301 555 0112" })).cellPhone, "+13015550112");
  assert.strictEqual((await A.listMyClients()).find((c) => c.email === "sam.agent@example.com").profile.cellPhone, "+12405550132"); ok("a rep's own edit never touches a client's cell");
  cl = await A.listMyClients(); assert.strictEqual(cl.find((c) => c.email === "sam.agent@example.com").cellPhone, "+12405550132"); assert.strictEqual(cl.find((c) => c.email === "lee.lender@example.com").cellPhone, "+12025550142"); ok("rep's client list carries each client's cell");
  await reject(A.inviteClient("badcell@example.com", { cellPhone: "555" }), /valid 10-digit US cell/, "invite with an invalid cell is refused");
  assert.ok(!(await A.listMyClients()).some((c) => c.email === "badcell@example.com")); ok("...and nothing was created");
  await A.inviteClient("withcell@example.com", { cellPhone: "(703) 555-0150" });
  assert.strictEqual((await A.listMyClients()).find((c) => c.email === "withcell@example.com").cellPhone, "+17035550150"); ok("rep invites with a cell: pending client shows +17035550150");
  await A.inviteClient("nocell@example.com"); assert.strictEqual((await A.listMyClients()).find((c) => c.email === "nocell@example.com").cellPhone, null); ok("invite without a cell still works");
  await as("sample.rep.marcus@clatitle.com");
  assert.strictEqual((await A.listMyClients()).find((c) => c.email === "nina.newagent@example.com").cellPhone, "+17035550181"); ok("pending client's cell comes from the invitation (Nina)");
  assert.ok(!(await A.listMyClients()).some((c) => c.email === "withcell@example.com")); ok("another rep does not see Jane's pending client");
  await as("sample.admin@clatitle.com");
  assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("b1")).cellPhone, "+13015550112"); ok("admin users list carries cells");
  await A.adminInvite({ email: "cell.rep@clatitle.com", role: "rep", cellPhone: "703-555-0155" });
  await reject(A.adminInvite({ email: "cell.bad@example.com", role: "client", cellPhone: "12" }), /valid 10-digit US cell/, "admin invite with an invalid cell is refused");
  await A.adminInvite({ email: "admin.sent@example.com", role: "client", repId: id("b1"), cellPhone: "202-555-0188" });
  await as("sample.rep.jane@clatitle.com");
  assert.strictEqual((await A.listMyClients()).find((c) => c.email === "admin.sent@example.com").cellPhone, "+12025550188"); ok("admin-invited client's cell is visible to the assigned rep");

  // admin
  await as("sample.admin@clatitle.com");
  assert.strictEqual((await A.adminListUsers()).length, 13); ok("admin lists all users (incl. the sample Admin)");
  const aq = await A.adminListQuotes(); assert.ok(aq.length >= 7); ok("admin sees all live quotes");
  await reject(A.adminSetRole(id("a1"), "client"), /own role/, "admin cannot change own role");
  await reject(A.adminInvite({ email: "r@gmail.com", role: "rep" }), /clatitle/, "rep invite needs CLA email");
  await A.adminInvite({ email: "new.rep@clatitle.com", role: "rep" }); ok("admin invites a rep");
  await A.adminReassign("pat.homes@example.com", id("b2")); await as("sample.rep.marcus@clatitle.com"); assert.ok((await A.listMyClients()).some((c) => c.email === "pat.homes@example.com")); ok("reassign moves the client to the new rep");
  await as("sample.admin@clatitle.com"); await A.adminSetStatus(id("c1"), "disabled"); await reject(A.signIn("sam.agent@example.com", "x"), /Invalid/, "disabled user locked out");
  const log = await A.adminAuditLog(50); assert.ok(log.some((r) => r.action === "user_disabled") && log.some((r) => r.action === "invite_sent")); ok("admin actions land in the audit log");

  // ---- super admin who ALSO works as a rep (profiles.is_rep) ----
  await A._reset(); w.localStorage.clear();
  assert.ok(CLA.isRep({ role: "rep" }) && CLA.isRep({ role: "super_admin", isRep: true }) && !CLA.isRep({ role: "super_admin" }) && !CLA.isRep({ role: "client", isRep: true }) && !CLA.isRep(null)); ok("CLA.isRep: rep, admin+rep yes; plain admin, client (even if flagged), nobody no");
  assert.strictEqual(CLA.roleLabel("super_admin", { isRep: true }), "Super admin + rep"); assert.strictEqual(CLA.roleLabel("super_admin"), "Super admin");
  assert.strictEqual(CLA.quotesHome({ role: "super_admin", isRep: true }), "rep.html"); assert.strictEqual(CLA.quotesHome({ role: "super_admin" }), "admin.html"); assert.strictEqual(CLA.quotesHome({ role: "client" }), "client.html"); ok("labels and 'my quotes' home follow isRep");
  await as("sample.admin@clatitle.com");
  const alex = await A.getMyProfile(); assert.strictEqual(alex.role, "super_admin"); assert.strictEqual(alex.isRep, true); assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("b1")).isRep, true); assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("c1")).isRep, false); ok("profiles carry isRep: Alex (admin) yes, reps yes, clients no");
  let acl = await A.listMyClients(); assert.strictEqual(acl.map((c) => c.email).sort().join(), "quinn.buyer@example.com,rae.pending@example.com"); ok("admin+rep's client list is ONLY her own 2 clients (not every assignment)");
  assert.strictEqual(acl.find((c) => c.email === "quinn.buyer@example.com").quoteCount, 1); assert.strictEqual(acl.find((c) => c.email === "rae.pending@example.com").cellPhone, "+15715550191"); assert.ok(acl.find((c) => c.email === "rae.pending@example.com").pending); ok("...Quinn has 1 quote; pending Rae's cell comes from her invitation");
  assert.strictEqual((await A.listQuotesForClient(id("c6"))).length, 1); assert.strictEqual((await A.adminListQuotes()).length >= 9, true); ok("she reads her client's quotes, and as admin still sees every quote");
  assert.ok((await A.listMyQuotes()).every((q) => q.ownerId === id("a1")) && (await A.listMyQuotes()).length === 1); ok("her own quotes are listed separately (1)");
  const aq1 = await A.saveQuote(snap); assert.strictEqual(aq1.ownerId, id("a1")); assert.strictEqual(aq1.repId, id("a1")); ok("a quote she saves carries herself as rep (co-branding like a rep)");
  await A.inviteClient("alex.new@example.com", { cellPhone: "(703) 555-0140" });
  acl = await A.listMyClients(); assert.ok(acl.some((c) => c.email === "alex.new@example.com" && c.pending && c.cellPhone === "+17035550140")); ok("inviteClient from the rep dashboard assigns the new client to her");
  await reject(A.inviteClient("nina.newagent@example.com"), /another rep/, "as a rep she cannot take over Marcus's client");
  await A.adminInvite({ email: "nina.newagent@example.com", role: "client", repId: id("a1") });
  assert.ok((await A.listMyClients()).some((c) => c.email === "nina.newagent@example.com")); ok("as admin (explicit rep) she can reassign it");
  await A.adminReassign("pat.homes@example.com", id("a1")); assert.ok((await A.listMyClients()).some((c) => c.email === "pat.homes@example.com")); ok("admin assignment picker accepts an admin+rep (reassign Pat to Alex)");
  await A.adminInvite({ email: "new.admin.rep@clatitle.com", role: "super_admin", isRep: true }); ok("admin invites a new super admin who also works as a rep");
  await reject(A.adminInvite({ email: "new.admin.rep2@gmail.com", role: "super_admin", isRep: true }), /clatitle/, "flagged admin needs a CLA email");
  await reject(A.adminSetIsRep(id("a1"), false), /Reassign this person's \d+ active client/, "cannot switch rep access off while she has clients");
  await reject(A.adminSetIsRep(id("b1"), false), /Only an admin or super admin/, "reps are always reps (cannot be switched)");
  await reject(A.adminSetIsRep(id("c1"), true), /Only an admin or super admin/, "clients cannot be switched on");
  const upd0 = await A.updateMyProfile({ phone: "" }); assert.strictEqual(upd0.isComplete, false); assert.strictEqual((await A.updateMyProfile({ phone: "301-555-0100" })).isComplete, true); ok("an admin+rep needs a phone to count as a complete profile");
  // the client's view of her
  await as("quinn.buyer@example.com");
  const qr = await A.getMyRep(); assert.strictEqual(qr.firstName, "Alex"); assert.strictEqual(qr.cellPhone, "+13015550101"); ok("client Quinn's rep is Alex (name, cell)");
  assert.ok(await A.getAvatarUrl({ id: id("a1"), avatarPath: id("a1") + "/avatar" })); ok("Quinn sees Alex's photo");
  assert.strictEqual((await A.saveQuote(snap)).repId, id("a1")); ok("Quinn's new quote carries Alex as rep");
  await as("pat.homes@example.com"); assert.strictEqual((await A.getMyRep()).firstName, "Alex"); await as("lee.lender@example.com"); assert.strictEqual(await A.getAvatarUrl({ id: id("a1"), avatarPath: "x" }), null); ok("an unrelated client gets no photo of Alex");
  // non-admins cannot use the switch; reps still cannot reach admin things
  await as("sample.rep.jane@clatitle.com"); await reject(A.adminSetIsRep(id("a1"), false), /Admins only/, "a rep cannot call adminSetIsRep"); assert.strictEqual((await A.listMyClients()).length, 2); ok("Jane's list is unchanged by all of this (2 clients)");
  // role changes keep isRep in step (same as the database trigger)
  await as("sample.admin@clatitle.com");
  await A.adminSetRole(id("b1"), "super_admin"); let jp = (await A.adminListUsers()).find((u) => u.id === id("b1")); assert.ok(jp.role === "super_admin" && jp.isRep === true); ok("a rep promoted to super admin keeps rep access");
  await A.adminReassign("sam.agent@example.com", id("b2")); await A.adminReassign("lee.lender@example.com", id("b2"));
  await A.adminSetIsRep(id("b1"), false); jp = (await A.adminListUsers()).find((u) => u.id === id("b1")); assert.strictEqual(jp.isRep, false); ok("with her clients moved, rep access can be switched off");
  await reject(A.adminReassign("pat.homes@example.com", id("b1")), /Pick a rep/, "a super admin who is not a rep is not in the assignment picker");
  await A.adminSetIsRep(id("b1"), true); assert.ok((await A.adminListUsers()).find((u) => u.id === id("b1")).isRep); ok("...and back on");
  await A.adminSetRole(id("b1"), "client"); assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("b1")).isRep, false); ok("demoting to client clears isRep");
  assert.ok((await A.adminAuditLog(50)).some((r) => r.action === "rep_flag_changed")); ok("the switch is written to the audit log");

  // ---- the "admin" role: full dashboard, but only over reps and clients (migration 10) ----
  await A._reset(); w.localStorage.clear();
  const Adm = { id: "x", role: "admin" }, Sup = { id: "y", role: "super_admin" };
  assert.ok(CLA.isAdmin({ role: "admin" }) && CLA.isAdmin({ role: "super_admin" }) && !CLA.isAdmin({ role: "rep" }) && !CLA.isAdmin({ role: "client" }) && !CLA.isAdmin(null));
  assert.ok(CLA.isSuperAdmin({ role: "super_admin" }) && !CLA.isSuperAdmin({ role: "admin" })); ok("CLA.isAdmin: super admin and admin yes; CLA.isSuperAdmin: super admin only");
  assert.ok(CLA.isRep({ role: "admin", isRep: true }) && !CLA.isRep({ role: "admin" }) && !CLA.isRep({ role: "admin", isRep: false })); ok("CLA.isRep: an admin is a rep only with the also-a-rep switch");
  assert.strictEqual(CLA.roleLabel("admin"), "Admin"); assert.strictEqual(CLA.roleLabel("admin", { isRep: true }), "Admin + rep"); assert.strictEqual(CLA.roleLabel("super_admin"), "Super admin"); assert.strictEqual(CLA.roleLabel("rep"), "CLA rep"); ok("roleLabel: Admin / Admin + rep / Super admin / CLA rep");
  assert.strictEqual(CLA.homeFor("admin"), "admin.html"); assert.strictEqual(CLA.quotesHome({ role: "admin" }), "admin.html"); assert.strictEqual(CLA.quotesHome({ role: "admin", isRep: true }), "rep.html"); ok("route helpers: admins land on admin.html; admin+rep quotes live on rep.html");
  const T = (role) => ({ id: "t", role });
  assert.deepStrictEqual(["rep", "client", "admin", "super_admin"].map((r) => CLA.canManage(Adm, T(r))), [true, true, true, false]);
  assert.deepStrictEqual(["rep", "client", "admin", "super_admin"].map((r) => CLA.canManage(Sup, T(r))), [true, true, true, true]);
  assert.ok(!CLA.canManage(Adm, { id: "x", role: "client" }) && !CLA.canManage(Sup, { id: "y", role: "rep" }) && !CLA.canManage(null, T("rep")) && !CLA.canManage({ role: "rep", id: "r" }, T("client")));
  assert.strictEqual(CLA.manageBlock(Adm, T("super_admin")), "Only a super admin can change a super admin."); assert.strictEqual(CLA.manageBlock(Adm, T("admin")), "");
  assert.strictEqual(CLA.manageBlock(Adm, T("rep")), ""); assert.strictEqual(CLA.manageBlock(Sup, T("admin")), ""); ok("CLA.canManage / manageBlock: admin -> reps, clients and other admins (never a super admin); super admin -> anyone; nobody -> themselves; tooltips");

  await as("sample.robin.admin@clatitle.com");
  const robin = await A.getMyProfile(); assert.ok(robin.role === "admin" && robin.isRep === false && robin.isComplete === true); ok("demo Admin Robin: role admin, not a rep");
  assert.strictEqual((await A.adminListUsers()).length, 13); assert.ok((await A.adminListQuotes()).length >= 9); assert.ok((await A.adminAuditLog(10)).length > 0); assert.ok((await A.adminListAssignments()).length >= 7); ok("admin sees all users, quotes, assignments and the audit log");
  await A.adminInvite({ email: "robin.rep@clatitle.com", role: "rep" }); await A.adminInvite({ email: "robin.client@example.com", role: "client", repId: id("b1") }); ok("admin invites a rep and a client (assigned to Jane)");
  await reject(A.adminInvite({ email: "no.sa@clatitle.com", role: "super_admin" }), /Only a super admin can invite an admin or super admin/, "admin cannot invite a super admin");
  await reject(A.adminInvite({ email: "no.admin@clatitle.com", role: "admin" }), /Only a super admin can invite an admin or super admin/, "admin cannot invite an admin");
  await reject(A.adminInvite({ email: "no.admin@clatitle.com", role: "admin", isRep: true }), /Only a super admin can invite/, "admin cannot invite a flagged admin");
  await reject(A.adminInvite({ email: "no.rep@clatitle.com", role: "rep", isRep: true }), /Only a super admin can invite an admin or super admin who also works as a rep/, "admin cannot use the rep flag on a rep invitation");
  await A.adminSetStatus(id("c1"), "disabled"); await A.adminSetStatus(id("c1"), "active"); await A.adminSetStatus(id("b1"), "disabled"); await A.adminSetStatus(id("b1"), "active"); ok("admin disables and re-enables a client and a rep");
  await reject(A.adminSetStatus(id("a1"), "disabled"), /Only a super admin can disable or re-enable a super admin/, "admin cannot disable a super admin");
  await reject(A.adminSetStatus(id("a2"), "disabled"), /cannot disable yourself/, "admin cannot disable themselves");
  await reject(A.adminSetRole(id("a1"), "client"), /Only a super admin can change the role of a super admin/, "admin cannot demote a super admin");
  await reject(A.adminSetRole(id("a2"), "client"), /own role/, "admin cannot demote themselves");
  await reject(A.adminSetRole(id("c3"), "admin"), /Only a super admin can make someone an admin or super admin/, "admin cannot promote a client to admin");
  await reject(A.adminSetRole(id("b1"), "super_admin"), /Only a super admin can make someone/, "admin cannot promote a rep to super admin");
  await reject(A.adminSetIsRep(id("a1"), false), /Only a super admin can do that/, "admin cannot switch rep access on a super admin");
  await reject(A.adminSetIsRep(id("a2"), true), /Only a super admin can do that/, "admin cannot switch their own rep access");
  assert.ok((await A.adminListUsers()).find((u) => u.id === id("a1")).status === "active" && (await A.adminListUsers()).find((u) => u.id === id("a1")).role === "super_admin"); ok("...and nothing changed on the super admin");
  // migration 12: a rep with ACTIVE clients cannot be made a client without a successor; the clients move in the same step
  const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));   // arrays come from the sandboxed adapter: compare by value
  const clientsOf = async (rid) => (await A.adminListAssignments()).filter((a) => a.active && a.repId === rid).map((a) => a.clientEmail).sort();
  const marcusBefore = await clientsOf(id("b2")); assert.ok(marcusBefore.length >= 2);
  await reject(A.adminSetRole(id("b2"), "client"), /This person has \d+ active client\(s\): choose another rep/, "admin cannot make a rep with clients a client without a successor");
  for (const bad of [id("b2"), id("c1"), id("c4"), id("a2"), "nobody"]) await reject(A.adminSetRole(id("b2"), "client", bad), /different rep|must be an active rep/, "...invalid successor refused: " + (bad === id("b2") ? "same person" : bad === id("c1") ? "a client" : bad === id("c4") ? "a disabled client" : bad === id("a2") ? "a plain admin" : "unknown"));
  same(await clientsOf(id("b2")), marcusBefore); assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("b2")).role, "rep"); ok("...and every refusal changed nothing (role and clients as before)");
  const histBefore = (await A.adminListAssignments()).length, janeBefore = await clientsOf(id("b1"));
  await A.adminSetRole(id("b2"), "client", id("b1"));
  const m2 = (await A.adminListUsers()).find((u) => u.id === id("b2")); assert.ok(m2.role === "client" && m2.isRep === false); same(await clientsOf(id("b2")), []);
  same(await clientsOf(id("b1")), [...janeBefore, ...marcusBefore].sort()); ok("admin makes Marcus a client with Jane as successor: all his active clients move to Jane");
  const asgAll = await A.adminListAssignments(); assert.strictEqual(asgAll.length, histBefore + marcusBefore.length); assert.ok(asgAll.filter((a) => a.repId === id("b2")).every((a) => !a.active)); ok("...history kept: Marcus's old rows are inactive, new rows were added for Jane");
  assert.ok((await A.adminAuditLog(100)).some((r) => r.action === "role_changed" && r.details.clients_moved === marcusBefore.length && r.details.moved_to === id("b1"))); ok("...audit records who took over and how many");
  await A.adminSetRole(id("b2"), "rep"); assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("b2")).isRep, true); ok("admin changes a client back to a rep (is_rep follows)");
  await A.adminSetRole(id("b2"), "client"); await A.adminSetRole(id("b2"), "rep"); ok("a rep with NO active clients is changed to client and back without any successor");
  await reject(A.adminSetRole(id("a1"), "client", id("b1")), /Only a super admin can change the role of a super admin/, "admin cannot do it to a super admin even with a successor");
  for (const row of [marcusBefore]) for (const e of row) await A.adminReassign(e, id("b2"));   // put Marcus's clients back for the rest of the tests
  same(await clientsOf(id("b2")), marcusBefore);
  await A.adminReassign("pat.homes@example.com", id("b1")); await reject(A.adminReassign("pat.homes@example.com", id("a2")), /Pick a rep/, "a plain admin is not in the rep picker (not rep-capable)"); ok("admin reassigns a client to a rep");
  // migration 11: an admin may also manage ANOTHER admin (Casey), but never a super admin, and never promote
  await A.adminSetStatus(id("a3"), "disabled"); assert.strictEqual((await A.adminListUsers()).find((u) => u.id === id("a3")).status, "disabled"); await A.adminSetStatus(id("a3"), "active"); ok("admin disables and re-enables another admin (Casey)");
  await reject(A.adminSetRole(id("a3"), "super_admin"), /Only a super admin can make someone an admin or super admin/, "admin cannot promote another admin to super admin");
  await reject(A.adminSetRole(id("a3"), "admin"), /Only a super admin can make someone/, "...nor 'promote' an admin to admin");
  await A.adminSetRole(id("a3"), "client"); const cas = (await A.adminListUsers()).find((u) => u.id === id("a3")); assert.ok(cas.role === "client" && cas.isRep === false); ok("admin demotes another admin to client (is_rep cleared)");
  await reject(A.adminSetRole(id("a3"), "admin"), /Only a super admin can make someone/, "...and cannot promote Casey back");
  await as("sample.admin@clatitle.com"); await A.adminSetRole(id("a3"), "admin"); await as("sample.robin.admin@clatitle.com"); ok("a super admin puts Casey back to admin");
  await as("sample.casey.admin@clatitle.com"); await A.adminSetStatus(id("a2"), "disabled"); await reject(A.signIn("sample.robin.admin@clatitle.com", "x"), /Invalid/, "a disabled admin cannot sign in (Casey disabled Robin)");
  await A.adminSetStatus(id("a2"), "active"); await reject(A.adminSetStatus(id("a3"), "disabled"), /cannot disable yourself/, "an admin cannot disable themselves"); ok("admin Casey disables and re-enables admin Robin, not herself");
  await reject(A.adminSetStatus(id("a1"), "disabled"), /Only a super admin can disable or re-enable a super admin/, "Casey cannot disable a super admin"); await reject(A.adminSetIsRep(id("a2"), true), /Only a super admin can do that/, "...nor switch another admin's rep access");
  await reject(A.adminInvite({ email: "casey.invites.admin@clatitle.com", role: "admin" }), /Only a super admin can invite/, "...nor invite an admin"); await as("sample.robin.admin@clatitle.com");
  // as a rep, an admin never gains admin power over others
  await as("sample.admin@clatitle.com");
  await A.adminInvite({ email: "new.admin@clatitle.com", role: "admin" }); await A.adminInvite({ email: "new.admin.rep@clatitle.com", role: "admin", isRep: true }); ok("super admin invites an admin, and an admin who also works as a rep");
  await reject(A.adminInvite({ email: "new.admin.rep2@gmail.com", role: "admin", isRep: true }), /clatitle/, "flagged admin needs a CLA email");
  await A.adminSetRole(id("a2"), "super_admin"); await A.adminSetRole(id("a2"), "admin"); await A.adminSetRole(id("a2"), "rep"); await A.adminSetRole(id("a2"), "client"); await A.adminSetRole(id("a2"), "admin"); ok("super admin moves Robin between every role (the only role changer for admins)");
  await A.adminSetIsRep(id("a2"), true); let rb = (await A.adminListUsers()).find((u) => u.id === id("a2")); assert.ok(rb.role === "admin" && rb.isRep === true && CLA.isRep(rb)); ok("super admin switches rep access on for an admin (Robin)");
  await A.adminReassign("pat.homes@example.com", id("a2")); await as("sample.robin.admin@clatitle.com");
  assert.ok((await A.listMyClients()).some((c) => c.email === "pat.homes@example.com")); const rq = await A.saveQuote(snap); assert.strictEqual(rq.repId, id("a2")); ok("an admin who is a rep gets clients and co-branded quotes like a rep (rep_id = themselves)");
  await A.inviteClient("robin.own@example.com"); assert.ok((await A.listMyClients()).some((c) => c.email === "robin.own@example.com")); ok("...and invites clients from the rep dashboard (rep rules)");
  await reject(A.inviteClient("nina.newagent@example.com"), /another rep/, "...without taking over another rep's client");
  await reject(A.adminSetIsRep(id("a2"), false), /Only a super admin can do that/, "...and still cannot switch their own flag off");
  await as("sample.admin@clatitle.com"); await reject(A.adminSetIsRep(id("a2"), false), /Reassign this person's \d+ active client/, "switching off is refused while the admin has clients");
  const robinClients = await clientsOf(id("a2")); assert.ok(robinClients.length >= 1);
  await reject(A.adminSetIsRep(id("a2"), false, id("a2")), /different rep/, "...and the successor cannot be the same person"); await reject(A.adminSetIsRep(id("a2"), false, id("c1")), /must be an active rep/, "...nor a client");
  await reject(A.adminSetRole(id("a2"), "client"), /choose another rep/, "an admin + rep with clients cannot be made a client without a successor either");
  await A.adminSetRole(id("a2"), "rep"); await A.adminSetRole(id("a2"), "admin"); same(await clientsOf(id("a2")), robinClients); ok("...but rep / admin changes that keep rep capability need no successor and keep the clients");
  await A.adminSetIsRep(id("a2"), false, id("b1")); const rb2 = (await A.adminListUsers()).find((u) => u.id === id("a2")); assert.ok(rb2.isRep === false && (await clientsOf(id("a2"))).length === 0); assert.ok((await clientsOf(id("b1"))).includes(robinClients[0])); ok("super admin switches rep access off with Jane as successor: Robin's clients move to Jane");
  await A.adminSetIsRep(id("a2"), true);
  await A.adminSetStatus(id("a2"), "disabled"); await reject(A.signIn("sample.robin.admin@clatitle.com", "x"), /Invalid/, "a disabled admin cannot sign in"); await A.adminSetStatus(id("a2"), "active"); ok("super admin disables and re-enables an admin");
  // super admin keeps everything: demote a super admin to admin, never themselves
  await A.adminSetRole(id("a2"), "super_admin"); await as("sample.robin.admin@clatitle.com");
  await A.adminSetStatus(id("a1"), "disabled"); await A.adminSetStatus(id("a1"), "active"); await A.adminSetRole(id("a1"), "admin"); await reject(A.adminSetStatus(id("a2"), "disabled"), /cannot disable yourself/, "a super admin cannot disable themselves");
  await reject(A.adminSetRole(id("a2"), "client"), /own role/, "a super admin cannot demote themselves"); ok("a (promoted) super admin disables / demotes another super admin, never themselves");
  // the rule table the screens use
  await A._reset(); w.localStorage.clear();
  await as("sample.admin@clatitle.com"); assert.ok((await A.adminListUsers()).filter((u) => u.role === "admin").length === 2); ok("sample data: two Admins (Robin, Casey) next to the super admin");

  // ---- admin.html itself (jsdom): what an Admin vs a Super admin sees and can click ----
  const pdir = __dirname;
  // jsdom cannot lazy-load scripts, so the staff feedback widget is inlined right after portal-ui.js (the real pages load it on demand)
  const WIDGET = "<script>" + fs.readFileSync(path.join(__dirname, "js", "feedback-widget.js"), "utf8") + "</script>";
  const TOURJS = "<script>" + fs.readFileSync(path.join(__dirname, "js", "tour.js"), "utf8") + "</script>";
  const renderAdmin = async (email, expectBlocked, prep) => {
    // first load seeds + signs in (the page redirects to login when signed out), so seed the session first in a throwaway window
    const w0 = boot(), A0 = w0.CLA.createMockAdapter({}); if (prep) { await A0.signIn("sample.admin@clatitle.com", "x"); await prep(A0); } await A0.signIn(email, "x");
    const store = { cla_portal_mock_v1: w0.localStorage.getItem("cla_portal_mock_v1"), cla_portal_mock_session: w0.localStorage.getItem("cla_portal_mock_session") };
    const html = fs.readFileSync(path.join(pdir, "admin.html"), "utf8")
      .replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script src="config\.js"><\/script>/, "<script>window.CLA_PORTAL_CONFIG={mode:'mock'}</script>")
      .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (m, f) => "<script>" + fs.readFileSync(path.join(pdir, f), "utf8") + "</script>" + (f === "js/portal-ui.js" ? WIDGET + TOURJS : ""));
    const errs = [];
    const dom = new JSDOM(html, { url: "http://localhost/portal/admin.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(win) { win.crypto.randomUUID = require("crypto").randomUUID; win.confirm = () => true; win.addEventListener("error", (e) => errs.push(e.message));
        for (const k in store) win.localStorage.setItem(k, store[k]); } });
    const d = dom.window.document;
    for (let i = 0; i < (expectBlocked ? 15 : 100) && d.querySelectorAll("#users tr").length < 13; i++) await new Promise((r) => setTimeout(r, 20));
    return { dom, d, errs, row: (uid) => [...d.querySelectorAll("#users tr")].find((tr) => tr.innerHTML.includes('data-av="{&quot;id&quot;:&quot;' + uid + '&quot;') || tr.innerHTML.includes(uid)) };
  };
  {
    const R = await renderAdmin("sample.robin.admin@clatitle.com"), d = R.d;
    assert.strictEqual(R.errs.length, 0, R.errs.join()); assert.strictEqual(d.querySelectorAll("#users tr").length, 13); ok("admin.html renders for an Admin (13 users, no script errors)");
    assert.match(d.getElementById("roleNote").textContent, /You are an Admin: you can manage reps, clients and other admins\. Only a super admin can promote admins or touch a super admin/); ok("admin.html: an Admin sees what they may do");
    assert.deepStrictEqual([...d.querySelectorAll("#iRole option")].map((o) => o.value), ["rep", "client"]); assert.match(d.getElementById("iRoleNote").textContent, /Only a super admin can invite admins and super admins/); ok("admin.html: an Admin can only pick Rep or Client in the invite form");
    const rowA = R.row(id("a1")), rowJ = R.row(id("b1")), rowMe = R.row(id("a2")), rowC = R.row(id("c1"));
    assert.ok(!rowA.querySelector("select[data-role]") && /Super admin/.test(rowA.textContent)); ok("admin.html: an Admin cannot change a super admin's role (no dropdown)");
    const btnA = rowA.querySelector("button[data-st]"); assert.ok(btnA.disabled); assert.match(btnA.parentElement.getAttribute("data-tip"), /Only a super admin can change a super admin/); ok("admin.html: Disable is greyed out for a super admin, with a tooltip saying why");
    assert.ok(rowA.querySelector("input[data-also]").disabled && /Only a super admin can switch this/.test(rowA.querySelector("label.also").getAttribute("data-tip"))); ok("admin.html: the 'also works as a rep' switch is locked for an Admin, with a tooltip");
    assert.deepStrictEqual([...rowJ.querySelectorAll("select[data-role] option")].map((o) => o.value), ["rep", "client"]); assert.ok(!rowJ.querySelector("button[data-st]").disabled); assert.ok(!rowC.querySelector("button[data-st]").disabled); ok("admin.html: an Admin can change / disable a rep and a client (role list: rep, client only)");
    const rowK = R.row(id("a3")); assert.deepStrictEqual([...rowK.querySelectorAll("select[data-role] option")].map((o) => o.value), ["admin", "rep", "client"]); assert.strictEqual(rowK.querySelector("select[data-role]").value, "admin");
    assert.ok(!rowK.querySelector("button[data-st]").disabled && !rowK.querySelector("[data-tip] button[data-st]")); assert.ok(rowK.querySelector("input[data-also]").disabled && /Only a super admin can switch this/.test(rowK.querySelector("label.also").getAttribute("data-tip"))); ok("admin.html: an Admin can disable / demote ANOTHER admin (role list: admin, rep, client: no way up), but the rep switch stays locked");
    assert.ok(/Admin \(you\)/.test(rowMe.textContent) && !rowMe.querySelector("button[data-st]") && !rowMe.querySelector("select[data-role]")); assert.ok(rowMe.querySelector("input[data-also]").disabled); ok("admin.html: an Admin's own row has no role dropdown and no disable button");
    assert.strictEqual(d.getElementById("uCount").textContent, "13 users · 3 reps · 1 super admin · 2 admins · 7 clients · 1 admin also works as rep"); ok("admin.html: the user count line names super admins and admins separately");
    assert.match(d.querySelector("header .chip small").textContent, /^Admin$/); ok("admin.html: the header says Admin");
    // "Move N realtors to...": changing a rep who has clients to Client opens the picker; cancel changes nothing; confirm moves the clients
    const change2 = (dd, el, v) => { el.value = v; el.dispatchEvent(new dd.defaultView.Event("change", { bubbles: true })); };
    const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));
    const change = (el, v) => { el.value = v; el.dispatchEvent(new d.defaultView.Event("change", { bubbles: true })); };
    let selM = R.row(id("b2")).querySelector("select[data-role]"); change(selM, "client"); await tick();
    let dlg = d.querySelector(".dlg"); assert.ok(dlg && /Move 3 realtors to…/.test(dlg.querySelector("h2").textContent)); assert.match(dlg.textContent, /make Marcus Rep a client, Marcus Rep must first hand over their 3 realtors \(Dee Disabled, Omar Broker, nina\.newagent@example\.com\)/);
    assert.deepStrictEqual([...dlg.querySelectorAll("#dlgRep option")].map((o) => o.textContent.split(" · ")[0]), ["Alex Admin (admin + rep)", "Jane Rep", "Riley Rookie"]); ok("picker: changing a rep with 2 realtors to Client asks 'Move 3 realtors to…' (2 with accounts + 1 pending invitation) and lists the OTHER eligible reps (never the person, never a client or a plain admin)");
    dlg.querySelector("#dlgNo").click(); await tick(); assert.ok(!d.querySelector(".dlg")); assert.strictEqual(R.row(id("b2")).querySelector("select[data-role]").value, "rep"); ok("picker: Cancel changes nothing (the role dropdown snaps back to CLA rep)");
    change(R.row(id("b2")).querySelector("select[data-role]"), "client"); await tick(); d.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Escape" })); await tick(); assert.ok(!d.querySelector(".dlg")); ok("picker: Escape cancels too");
    change(R.row(id("b2")).querySelector("select[data-role]"), "client"); await tick(); d.querySelector("#dlgRep").value = id("b1"); d.querySelector("#dlgOk").click(); await tick(100);
    assert.ok(!d.querySelector(".dlg")); const rowM2 = R.row(id("b2")); assert.strictEqual(rowM2.querySelector("select[data-role]").value, "client"); ok("picker: confirming makes Marcus a client");
    assert.match([...d.querySelectorAll("#users tr")].find((tr) => tr.textContent.includes("Omar Broker")).textContent, /Marcus Rep|Jane Rep/); const om = [...d.querySelectorAll("#users tr")].find((tr) => tr.textContent.includes("Omar Broker")); assert.ok(/Jane Rep/.test(om.textContent) && !/Marcus Rep/.test(om.textContent)); ok("picker: his realtors now show Jane as their rep in the Users table");
    // a rep with no active clients: no picker, the plain confirmation
    d.defaultView.confirm = () => true; change(R.row(id("b2")).querySelector("select[data-role]"), "rep"); await tick(100); assert.ok(!d.querySelector(".dlg")); assert.strictEqual(R.row(id("b2")).querySelector("select[data-role]").value, "rep"); ok("picker: changing someone with no active clients (Marcus, now client -> rep) shows no picker, only the usual confirmation");
    change(R.row(id("b2")).querySelector("select[data-role]"), "client"); await tick(100); assert.ok(!d.querySelector(".dlg")); assert.strictEqual(R.row(id("b2")).querySelector("select[data-role]").value, "client"); ok("...and rep -> client with no clients also needs no picker");
    R.dom.window.close();
    // no other eligible rep at all: a clear message, no way to continue
    const N = await renderAdmin("sample.robin.admin@clatitle.com", false, async (A0) => { await A0.adminSetIsRep(id("a1"), false, id("b1")); await A0.adminSetStatus(id("b1"), "disabled"); await A0.adminSetStatus(id("b3"), "disabled"); }), nd = N.d;
    change2(nd, N.row(id("b2")).querySelector("select[data-role]"), "client"); await tick(); const nl = nd.querySelector(".dlg");
    assert.ok(nl && nl.querySelector("#dlgNone") && /no other active rep/.test(nl.textContent) && !nl.querySelector("#dlgOk") && nl.querySelector("#dlgNo")); nl.querySelector("#dlgNo").click(); await tick(); assert.strictEqual(N.row(id("b2")).querySelector("select[data-role]").value, "rep");
    ok("picker: with no other active rep (Jane and Riley disabled, Alex's rep switch off) it says so, offers only Cancel, and nothing changes");
    N.dom.window.close();
    const S = await renderAdmin("sample.admin@clatitle.com"), sd = S.d;
    assert.strictEqual(S.errs.length, 0, S.errs.join()); assert.match(sd.getElementById("roleNote").textContent, /You are a Super admin: you can manage everyone/); ok("admin.html renders for a Super admin");
    assert.deepStrictEqual([...sd.querySelectorAll("#iRole option")].map((o) => o.value), ["rep", "client", "admin", "super_admin"]); ok("admin.html: a Super admin can invite Rep, Client, Admin, Super admin");
    const rowR = S.row(id("a2")); assert.deepStrictEqual([...rowR.querySelectorAll("select[data-role] option")].map((o) => o.textContent), ["Super admin", "Admin", "CLA rep", "Client / agent"]); assert.strictEqual(rowR.querySelector("select[data-role]").value, "admin"); ok("admin.html: a Super admin sees all four roles for an Admin, labelled Super admin / Admin / CLA rep / Client / agent");
    assert.ok(!rowR.querySelector("button[data-st]").disabled && !rowR.querySelector("input[data-also]").disabled); assert.strictEqual(sd.querySelectorAll("#users button[disabled]").length, 0); ok("admin.html: nothing is greyed out for a Super admin");
    assert.ok(/Super admin \(you\)/.test(S.row(id("a1")).textContent) && S.row(id("a1")).querySelector("input[data-also]").checked); assert.match(sd.querySelector("header .chip small").textContent, /^Super admin \+ rep$/); ok("admin.html: a Super admin's own row says (you) with the rep switch on; the header says Super admin + rep");
    sd.getElementById("iRole").value = "admin"; sd.getElementById("iRole").onchange(); assert.ok(!sd.getElementById("iAlsoRow").hidden && sd.getElementById("iRepRow").hidden); sd.getElementById("iRole").value = "client"; sd.getElementById("iRole").onchange(); assert.ok(sd.getElementById("iAlsoRow").hidden && !sd.getElementById("iRepRow").hidden); ok("admin.html: the 'also works as a rep' choice shows for the Admin role and hides for Client");
    S.dom.window.close();
    // route guard: a client or a plain rep who opens admin.html is sent home and never sees the admin UI
    const swallow = (e) => { if (!(e && e.message === "redirect")) throw e; };   // boot() throws "redirect" after location.replace (jsdom cannot navigate)
    process.on("unhandledRejection", swallow);
    for (const who of ["sam.agent@example.com", "sample.rep.jane@clatitle.com"]) {
      const G = await renderAdmin(who, true); assert.strictEqual(G.d.querySelectorAll("#users tr").length, 0); assert.ok(!G.d.querySelector("header.top")); G.dom.window.close();
    }
    await new Promise((r) => setTimeout(r, 30)); process.removeListener("unhandledRejection", swallow);
    ok("admin.html: clients and plain reps are redirected (no users table, no header)");
  }

  // ---- staff feedback (migration 13): mock adapter rules ----
  {
    const GREET = "Hey! I am John Coester here to help you. Give me some feedback.";
    // sample rows exist for the admin panel
    await as("sample.admin@clatitle.com"); assert.strictEqual((await A.adminListFeedback()).length, 3); ok("feedback: the demo data has 3 sample submissions");
    // clients and signed-out visitors can neither send nor read
    await as("sam.agent@example.com");
    await reject(A.submitFeedback({ category: "bug", message: "hi", page: "/x" }), /Not allowed/, "feedback: a client cannot submit");
    assert.strictEqual((await A.listMyFeedback()).length, 0); await reject(A.adminListFeedback(), /Admins only/, "feedback: a client cannot read the admin list");
    await reject(A.adminSetFeedbackStatus("fb1", "approved"), /Admins only/, "feedback: a client cannot decide");
    w.localStorage.removeItem("cla_portal_mock_session");
    await reject(A.submitFeedback({ category: "bug", message: "hi" }), /./, "feedback: a guest cannot submit"); await reject(A.listMyFeedback(), /./, "feedback: a guest cannot read");
    // a rep: sends, reads only their own, cannot read others or decide
    await as("sample.rep.jane@clatitle.com");
    const r1 = await A.submitFeedback({ category: " IDEA ", message: "  Please add a dark mode.  ", page: "/portal/rep.html?client=secret#top" });
    const mine = await A.listMyFeedback(); assert.strictEqual(mine.length, 2); const row = mine.find((f) => f.id === r1.id);
    assert.deepStrictEqual([row.category, row.message, row.pagePath, row.status, row.roleAtSubmit, row.userId], ["idea", "Please add a dark mode.", "/portal/rep.html", "new", "rep", id("b1")]); ok("feedback: a rep submits (trimmed, category normalised, page = path only, status new, role stamped)");
    assert.ok(mine.every((f) => f.userId === id("b1"))); ok("feedback: a rep sees only their own submissions");
    await reject(A.adminListFeedback(), /Admins only/, "feedback: a rep cannot read everyone's feedback");
    await reject(A.adminSetFeedbackStatus(r1.id, "approved"), /Admins only/, "feedback: a rep cannot decide");
    // validation
    await reject(A.submitFeedback({ category: "bug", message: "   \n\t " }), /Message is required/, "feedback: an empty message is refused");
    await reject(A.submitFeedback({ category: "urgent", message: "x" }), /Category must be/, "feedback: an unknown category (no urgency field) is refused");
    await reject(A.submitFeedback({ category: "bug", message: "x".repeat(2001) }), /too long/, "feedback: 2001 characters refused");
    await A.submitFeedback({ category: "bug", message: "x".repeat(2000) }); ok("feedback: exactly 2000 characters accepted");
    assert.strictEqual((await A.listMyFeedback())[0].pagePath, null); ok("feedback: no page given -> none stored");
    // rate limit: 10 per hour (2 so far this hour; her sample row is days old)
    for (let i = 0; i < 8; i++) await A.submitFeedback({ category: "other", message: "n" + i });
    await reject(A.submitFeedback({ category: "other", message: "one too many" }), /a lot of feedback/, "feedback: the 11th in an hour is refused");
    await as("sample.rep.marcus@clatitle.com"); await A.submitFeedback({ category: "other", message: "me too" }); ok("feedback: someone else is not affected by Jane's limit");
    // admin / super admin read everything; only a super admin decides
    await as("sample.robin.admin@clatitle.com"); const all = await A.adminListFeedback(); assert.ok(all.length >= 12 && all.some((f) => f.userId === id("b1")) && all.some((f) => f.userId === id("b2"))); ok("feedback: an Admin reads everyone's feedback");
    await reject(A.adminSetFeedbackStatus("fb1", "approved"), /Only a super admin/, "feedback: an Admin cannot approve or dismiss");
    await A.submitFeedback({ category: "idea", message: "Admin idea" }); assert.strictEqual((await A.listMyFeedback()).length, 2); ok("feedback: an Admin can send feedback too (their own: sample + new)");
    await as("sample.admin@clatitle.com");
    await reject(A.adminSetFeedbackStatus("fb1", "notified"), /approved or dismissed/, "feedback: notified is not settable from the app");
    await reject(A.adminSetFeedbackStatus("nope", "approved"), /No such feedback/, "feedback: an unknown id is refused");
    await reject(A.adminSetFeedbackStatus("fb1", "approved", "n".repeat(1001)), /too long/, "feedback: a 1001-character note is refused");
    await A.adminSetFeedbackStatus("fb1", "approved", "  Fixed in the next release  ");
    let f1 = (await A.adminListFeedback()).find((f) => f.id === "fb1"); assert.deepStrictEqual([f1.status, f1.decidedNote, !!f1.decidedAt], ["approved", "Fixed in the next release", true]); ok("feedback: a super admin approves with a trimmed note");
    await A.adminSetFeedbackStatus("fb1", "dismissed", "   "); f1 = (await A.adminListFeedback()).find((f) => f.id === "fb1"); assert.deepStrictEqual([f1.status, f1.decidedNote], ["dismissed", null]); ok("feedback: a decision can be changed; a blank note is stored as none");
    const au = await A.adminAuditLog(50); assert.ok(au.some((x) => x.action === "feedback_decided") && au.some((x) => x.action === "feedback_submitted")); assert.ok(!JSON.stringify(au.filter((x) => x.action === "feedback_submitted")).includes("dark mode")); ok("feedback: audited (the message itself is not copied into the audit log)");
    await as("sample.rep.jane@clatitle.com"); assert.strictEqual((await A.listMyFeedback()).every((f) => f.userId === id("b1")), true);
  }

  // ---- staff feedback: the widget on real pages (jsdom) ----
  {
    const GREET = "Hey! I am John Coester here to help you. Give me some feedback.";
    const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));
    const renderPage = async (file, email, waitFor, prep, mod, qs) => {
      const w0 = boot(), A0 = w0.CLA.createMockAdapter({}); if (prep) { await A0.signIn("sample.admin@clatitle.com", "x"); await prep(A0); } if (email) await A0.signIn(email, "x");
      const store = { cla_portal_mock_v1: w0.localStorage.getItem("cla_portal_mock_v1"), cla_portal_mock_session: w0.localStorage.getItem("cla_portal_mock_session") };
      if (mod) { const st = JSON.parse(store.cla_portal_mock_v1); mod(st); store.cla_portal_mock_v1 = JSON.stringify(st); }
      const html = fs.readFileSync(path.join(pdir, file), "utf8").replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script src="config\.js"><\/script>/, "<script>window.CLA_PORTAL_CONFIG={mode:'mock'}</script>")
        .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (m, f) => "<script>" + fs.readFileSync(path.join(pdir, f), "utf8") + "</script>" + (f === "js/portal-ui.js" ? WIDGET + TOURJS : ""));
      const errs = [], dom = new JSDOM(html, { url: "http://localhost/portal/" + file + (qs || "?secret=1") + "#frag", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(win) { win.crypto.randomUUID = require("crypto").randomUUID; win.confirm = () => true; win.addEventListener("error", (e) => errs.push(e.message)); for (const k in store) win.localStorage.setItem(k, store[k]); } });
      for (let i = 0; i < 60 && !dom.window.document.querySelector(waitFor); i++) await tick(20);
      await tick(60); return { dom, d: dom.window.document, win: dom.window, errs };
    };
    const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    // staff see the button; the greeting heads the dialog
    const R = await renderPage("rep.html", "sample.rep.jane@clatitle.com", "#claFeedbackLink"), d = R.d;
    assert.strictEqual(R.errs.length, 0, R.errs.join()); const fab = d.getElementById("claFeedbackLink"); assert.ok(fab && fab.parentNode === d.body && !d.querySelector("header #claFeedbackLink") && fab.classList.contains("claFbFab")); assert.strictEqual(fab.getAttribute("aria-label"), "Send feedback"); assert.strictEqual(fab.getAttribute("aria-expanded"), "false"); ok("feedback widget: a rep sees a floating chat bubble (bottom-right launcher, labelled 'Send feedback', not in the header)");
    assert.ok(d.getElementById("claFb").hidden); d.getElementById("claFeedbackLink").click(); assert.ok(!d.getElementById("claFb").hidden); assert.strictEqual(d.getElementById("claFeedbackLink").getAttribute("aria-expanded"), "true"); ok("feedback widget: the bubble opens the panel (aria-expanded true)");
    assert.strictEqual(d.getElementById("claFbHi").textContent, GREET); assert.ok(d.getElementById("claFb").textContent.includes(GREET)); assert.ok(d.getElementById("claFb").querySelector(".claFbBody").firstElementChild === d.getElementById("claFbHi")); ok("feedback widget: John's greeting is at the top of the dialog (exact text)");
    assert.strictEqual(R.win.CLA.FEEDBACK_GREETING, GREET);
    assert.deepStrictEqual([...d.querySelectorAll("#claFbCat option")].map((o) => o.value), ["bug", "idea", "question", "other"]); assert.ok(!/urgen|priority/i.test(d.getElementById("claFb").textContent)); ok("feedback widget: categories Bug / Idea / Question / Other, no urgency");
    { const radios = [...d.querySelectorAll("#claFb [role=radiogroup] input[type=radio]")]; assert.deepStrictEqual(radios.map((r) => r.value), ["bug", "idea", "question", "other"]); assert.ok(radios[0].checked);
      radios[2].checked = true; fire(R.win, radios[2], "change"); assert.strictEqual(d.getElementById("claFbCat").value, "question"); radios[0].checked = true; fire(R.win, radios[0], "change"); assert.strictEqual(d.getElementById("claFbCat").value, "bug"); assert.ok(d.getElementById("claFbCat").getAttribute("aria-hidden") === "true" && d.getElementById("claFbX").getAttribute("aria-label")); ok("feedback widget: category chips (radiogroup) drive the category; the select is hidden from assistive tech"); }
    assert.strictEqual(d.getElementById("claFbPage").textContent, "Page: /portal/rep.html"); ok("feedback widget: the page is captured automatically, path only (no query or hash)");
    // empty message refused, nothing sent
    fire(R.win, d.getElementById("claFbForm"), "submit"); assert.match(d.getElementById("claFbErr").textContent, /write a message/); assert.ok(d.getElementById("claFbDone").hidden); ok("feedback widget: an empty message is refused");
    // counter + max
    const ta = d.getElementById("claFbMsg"); assert.strictEqual(ta.maxLength, 2000); ta.value = "abc"; fire(R.win, ta, "input"); assert.strictEqual(d.getElementById("claFbCount").textContent, "3 / 2000"); ok("feedback widget: 2000-character limit and a live counter");
    // send (hostile text is shown as text)
    const evil = '<img src=x onerror="window.pwned=1"> & <b>bold</b>';
    d.getElementById("claFbCat").value = "idea"; ta.value = evil; fire(R.win, d.getElementById("claFbForm"), "submit"); await tick(60);
    assert.ok(!d.getElementById("claFbDone").hidden && d.getElementById("claFbForm").hidden); assert.strictEqual(d.getElementById("claFbDone").querySelector(".claFbThanks").textContent, "Thanks, I read every note."); assert.ok(d.querySelector("#claFbDone .claFbOk svg")); ok("feedback widget: confirmation 'Thanks, I read every note.' with the checkmark");
    assert.ok(!d.querySelector("#claFb img")); assert.ok(!d.querySelector("#claFbMine img")); assert.ok(d.getElementById("claFbMine").textContent.includes(evil)); assert.ok(!R.win.pwned); ok("feedback widget: the message is escaped (shown as text, nothing runs)");
    assert.match(d.getElementById("claFbMine").textContent, /Idea.*Received/); ok("feedback widget: staff see their own submission and its status in the dialog");
    const stored = JSON.parse(R.win.localStorage.getItem("cla_portal_mock_v1")).feedback[0]; assert.deepStrictEqual([stored.pagePath, stored.category, stored.status], ["/portal/rep.html", "idea", "new"]); ok("feedback widget: stored with the page path and category");
    d.getElementById("claFbClose").click(); assert.ok(d.getElementById("claFb").hidden); R.dom.window.close();
    // Esc closes
    const R2 = await renderPage("profile.html", "sample.rep.jane@clatitle.com", "#claFeedbackLink"); R2.d.getElementById("claFeedbackLink").click(); R2.d.dispatchEvent(new R2.win.KeyboardEvent("keydown", { key: "Escape" })); assert.ok(R2.d.getElementById("claFb").hidden); ok("feedback widget: also on other portal pages, and Escape closes it"); await tick(60); R2.dom.window.close();
    // not staff: no button, no dialog (client, realtor-like client, signed-out login page)
    const swallow = (e) => { if (!(e && e.message === "redirect")) throw e; }; process.on("unhandledRejection", swallow);
    const C = await renderPage("client.html", "sam.agent@example.com", "header"); assert.ok(C.d.querySelector("header") && !C.d.getElementById("claFeedbackLink") && !C.d.getElementById("claFb") && !/Feedback/.test(C.d.querySelector("header").textContent)); ok("feedback widget: hidden for a client"); C.dom.window.close();
    const Cp = await renderPage("profile.html", "sam.agent@example.com", "header"); assert.ok(!Cp.d.getElementById("claFeedbackLink") && !Cp.d.getElementById("claFb")); ok("feedback widget: hidden for a client on the profile page"); Cp.dom.window.close();
    const L = await renderPage("login.html", null, "header"); assert.ok(!L.d.getElementById("claFeedbackLink")); ok("feedback widget: hidden for guests (signed out)"); L.dom.window.close();
    await tick(30); process.removeListener("unhandledRejection", swallow);
    // direct calls cannot bypass the role rule
    const w2 = boot(), CL = w2.CLA, A2 = CL.createMockAdapter({}); await A2.signIn("sam.agent@example.com", "x"); const me2 = await A2.getMyProfile();
    assert.strictEqual(await CL.startFeedback(A2, me2, { base: "" }), null); assert.strictEqual(await CL.startFeedback(A2, null, {}), null); assert.ok(!CL.isStaff(me2) && !CL.isStaff(null) && !CL.isStaff({ role: "rep", status: "disabled" }) && CL.isStaff({ role: "rep", status: "active" }) && CL.isStaff({ role: "admin" }) && CL.isStaff({ role: "super_admin" })); ok("feedback widget: startFeedback / isStaff refuse clients, guests and disabled reps");
    // admin pages: an Admin reads everything but cannot decide; a Super admin can
    const RA = await renderPage("admin.html", "sample.robin.admin@clatitle.com", "#users tr", async (A0) => { await A0.submitFeedback({ category: "bug", message: evil, page: "/portal/admin.html" }); });
    assert.ok(RA.d.getElementById("claFeedbackLink")); const tabs = [...RA.d.querySelectorAll("#tabs button")]; assert.strictEqual(tabs[4].textContent, "Feedback"); tabs[4].click(); await tick(80);
    assert.ok(!RA.d.getElementById("pFeedback").hidden); assert.ok(RA.d.querySelectorAll("#fbRows tr").length >= 4); assert.strictEqual(RA.d.querySelectorAll("#fbRows [data-fb]").length, 0); assert.match(RA.d.getElementById("fNote").textContent, /Read only/); ok("feedback panel: an Admin lists everything but has no approve/dismiss buttons");
    assert.ok(!RA.d.querySelector("#fbRows img") && RA.d.getElementById("fbRows").textContent.includes(evil)); assert.strictEqual(RA.errs.length, 0, RA.errs.join()); ok("feedback panel: messages are escaped");
    RA.d.getElementById("fStatus").value = "approved"; fire(RA.win, RA.d.getElementById("fStatus"), "change"); assert.strictEqual(RA.d.querySelectorAll("#fbRows tr").length, 1); assert.match(RA.d.getElementById("fbRows").textContent, /Where do I change my cell/); RA.d.getElementById("fStatus").value = "";
    RA.d.getElementById("fCat").value = "idea"; fire(RA.win, RA.d.getElementById("fCat"), "change"); assert.ok([...RA.d.querySelectorAll("#fbRows tr")].every((tr) => /Idea/.test(tr.children[2].textContent))); RA.d.getElementById("fCat").value = "";
    RA.d.getElementById("fFilter").value = "dark"; fire(RA.win, RA.d.getElementById("fFilter"), "input"); assert.match(RA.d.getElementById("fbRows").textContent, /No feedback matches/); ok("feedback panel: filters by status, category and text"); RA.dom.window.close();
    const RS = await renderPage("admin.html", "sample.admin@clatitle.com", "#users tr"); [...RS.d.querySelectorAll("#tabs button")][4].click(); await tick(80);
    assert.match(RS.d.getElementById("fNote").textContent, /approve or dismiss/); const btn = RS.d.querySelector('#fbRows button[data-fb="fb1"][data-to="approved"]'); assert.ok(btn && RS.d.querySelector('#fbRows button[data-fb="fb1"][data-to="dismissed"]'));
    RS.d.querySelector('#fbRows input[data-note="fb1"]').value = "Thanks, fixed"; btn.click(); await tick(80);
    const st = JSON.parse(RS.win.localStorage.getItem("cla_portal_mock_v1")).feedback.find((f) => f.id === "fb1"); assert.deepStrictEqual([st.status, st.decidedNote], ["approved", "Thanks, fixed"]); assert.match(RS.d.querySelector('#fbRows input[data-note="fb1"]').closest("tr").textContent, /Approved/); ok("feedback panel: a super admin approves with a note");
    assert.strictEqual(RS.errs.length, 0, RS.errs.join()); RS.dom.window.close();

    // ================= guided tour (migration 14) =================
    const seenOf = (R, uid) => JSON.parse(R.win.localStorage.getItem("cla_portal_mock_v1")).users.find((u) => u.id === uid).tourSeenAt;
    const boxTitle = (d) => d.getElementById("claTourTitle").textContent, boxCount = (d) => d.getElementById("claTourCount").textContent;
    const nextN = async (R, n) => { for (let k = 0; k < n; k++) { R.d.getElementById("claTourNext").click(); await tick(130); } };
    const newUser = (uid) => (st) => { st.users.find((u) => u.id === uid).tourSeenAt = null; };
    // -- adapter: markTourSeen, the seeded flags
    await as("sample.admin@clatitle.com"); const everyone = await A.adminListUsers();
    assert.ok(everyone.filter((u) => u.tourSeenAt === null).map((u) => u.firstName).sort().join() === "Nia,Riley" && everyone.filter((u) => u.tourSeenAt).length === 11); ok("tour (adapter): the sample people have seen the tour; only Nia (client) and Riley (rep) are new");
    await as("sample.new.client@example.com"); assert.strictEqual((await A.getMyProfile()).tourSeenAt, null); await A.markTourSeen(); const t1 = (await A.getMyProfile()).tourSeenAt; assert.ok(t1);
    await new Promise((r) => setTimeout(r, 15)); await A.markTourSeen(); assert.strictEqual((await A.getMyProfile()).tourSeenAt, t1); ok("tour (adapter): markTourSeen sets it for the caller only, and the first time wins");
    assert.strictEqual((await A.adminListUsers().catch(() => [])).length, 0); w.localStorage.removeItem("cla_portal_mock_session"); await reject(A.markTourSeen(), /sign in/i, "tour (adapter): a guest cannot mark the tour seen");
    await as("sample.rep.jane@clatitle.com"); await A.markTourSeen(); await as("sample.new.rep@clatitle.com"); assert.strictEqual((await A.getMyProfile()).tourSeenAt, null); ok("tour (adapter): one person marking it does not touch anybody else");
    // -- every role's tour: step counts, order, wording
    const wt = boot(); wt.eval(fs.readFileSync(path.join(__dirname, "js", "tour.js"), "utf8")); const R_steps = (kind, me) => wt.CLA.tourSteps(kind, me);
    const meOf = (role) => ({ role, isRep: false });
    const counts = { super: R_steps("admin", meOf("super_admin")).length, admin: R_steps("admin", meOf("admin")).length, rep: R_steps("rep", meOf("rep")).length, repAdmin: R_steps("rep", { role: "admin", isRep: true }).length, client: R_steps("client", meOf("client")).length };
    assert.deepStrictEqual(counts, { super: 7, admin: 6, rep: 6, repAdmin: 7, client: 7 }); ok("tour: 4-7 steps per role (super admin 7, admin 6, rep 6, admin who reps 7, client 7)");
    const all = [].concat(R_steps("admin", meOf("super_admin")), R_steps("rep", { role: "admin", isRep: true }), R_steps("client", meOf("client")));
    assert.ok(all.every((s) => s.title && s.text.length < 330 && s.title.length < 45)); assert.ok(!/<|&lt;/.test(JSON.stringify(all))); ok("tour: every step has a short title and short plain text");
    assert.ok(/Only a super admin can approve or dismiss/.test(R_steps("admin", meOf("admin")).pop().text) && /approve or dismiss each item/.test(R_steps("admin", meOf("super_admin")).pop().text) && /Only a super admin can invite admins/.test(R_steps("admin", meOf("admin")).find((s) => s.target === '[data-tour="a-invite"]').text) && /admins or super admins/.test(R_steps("admin", meOf("super_admin")).find((s) => s.target === '[data-tour="a-invite"]').text)); ok("tour: admins read feedback and cannot invite admins; super admins approve / dismiss and can invite anyone (wording)");
    const cs = R_steps("client", meOf("client")).map((s) => s.text).join(" "); assert.ok(/30 days/.test(cs) && /sign in/i.test(cs) && /placeholder/.test(cs) && /optional/.test(cs) && /estimates only/i.test(cs) && /rep/.test(cs)); ok("tour: the client tour covers sign-in, auto-save, 30 days, the photo placeholder, the rep and the estimates-only note");
    const rs = R_steps("rep", { role: "rep" }).map((s) => s.title + " " + s.text).join(" "); assert.ok(/Invite|invite/.test(rs) && /cell/.test(rs) && /30 days/.test(rs)); ok("tour: the rep tour covers clients, invites, quotes, the cell phone");
    // -- auto-start for a NEW client; Skip / Esc / Done mark it seen; a second visit does not start it
    const C1 = await renderPage("client.html", "sample.new.client@example.com", "#claTour"), cd = C1.d;
    assert.strictEqual(C1.errs.length, 0, C1.errs.join()); assert.ok(cd.getElementById("claTour")); assert.strictEqual(boxCount(cd), "Step 1 of 7"); assert.strictEqual(boxTitle(cd), "Welcome to your quotes"); ok("tour: starts by itself for a brand-new client (Step 1 of 7)");
    const pop = cd.querySelector(".claTourPop"); assert.strictEqual(pop.getAttribute("role"), "dialog"); assert.strictEqual(pop.getAttribute("aria-modal"), "true"); assert.strictEqual(cd.getElementById(pop.getAttribute("aria-labelledby")).textContent, "Welcome to your quotes"); assert.ok(cd.getElementById(pop.getAttribute("aria-describedby")).textContent.length > 20); assert.strictEqual(cd.activeElement, pop); ok("tour: the box is a labelled, described, modal dialog and takes focus");
    assert.ok(cd.getElementById("claTourBack").hidden && cd.getElementById("claTourNext").textContent === "Next" && cd.getElementById("claTourSkip")); ok("tour: Back is hidden on step 1; Next and Skip are there");
    cd.dispatchEvent(new C1.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await tick(100); assert.strictEqual(boxCount(cd), "Step 2 of 7"); assert.ok(!cd.getElementById("claTourBack").hidden); assert.ok(!cd.querySelector(".claTourSpot").hidden);
    cd.dispatchEvent(new C1.win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await tick(100); assert.strictEqual(boxCount(cd), "Step 1 of 7"); ok("tour: the arrow keys go forward and back");
    // Tab stays inside the box
    cd.getElementById("claTourNext").focus(); cd.dispatchEvent(new C1.win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); assert.strictEqual(cd.activeElement.id, "claTourSkip"); ok("tour: Tab wraps inside the box (focus trap)");
    await nextN(C1, 6); assert.strictEqual(boxCount(cd), "Step 7 of 7"); assert.strictEqual(cd.getElementById("claTourNext").textContent, "Done"); assert.ok(cd.querySelector(".claTourSpot").hidden && /estimates only/i.test(cd.getElementById("claTourText").textContent)); ok("tour: the last step is a centred note (estimates only) and the button says Done");
    assert.strictEqual(seenOf(C1, id("c7")), null); cd.getElementById("claTourNext").click(); await tick(60); assert.ok(!cd.getElementById("claTour")); assert.ok(seenOf(C1, id("c7"))); ok("tour: Done closes it and marks it seen (profiles.tour_seen_at)");
    C1.dom.window.close();
    const C2 = await renderPage("client.html", "sample.new.client@example.com", "header", null, (st) => { st.users.find((u) => u.id === id("c7")).tourSeenAt = "2026-10-20T10:00:00Z"; }); assert.ok(!C2.d.getElementById("claTour")); ok("tour: does not start for someone who has seen it"); C2.dom.window.close();
    const C3 = await renderPage("client.html", "sample.new.client@example.com", "#claTour"); C3.d.dispatchEvent(new C3.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(60); assert.ok(!C3.d.getElementById("claTour") && seenOf(C3, id("c7"))); ok("tour: Esc closes it and marks it seen");
    C3.dom.window.close();
    const C4 = await renderPage("client.html", "sample.new.client@example.com", "#claTour"); C4.d.getElementById("claTourSkip").click(); await tick(60); assert.ok(!C4.d.getElementById("claTour") && seenOf(C4, id("c7"))); ok("tour: Skip tour closes it and marks it seen"); C4.dom.window.close();
    // replay for someone who has seen it: the header link; the seen date does not move
    const C5 = await renderPage("client.html", "sam.agent@example.com", "#claTourLink"); assert.ok(!C5.d.getElementById("claTour")); const before = seenOf(C5, id("c1"));
    C5.d.getElementById("claTourLink").click(); await tick(100); assert.ok(C5.d.getElementById("claTour") && boxCount(C5.d) === "Step 1 of 7"); C5.d.getElementById("claTourSkip").click(); await tick(50); assert.strictEqual(seenOf(C5, id("c1")), before); assert.strictEqual(C5.d.activeElement.id, "claTourLink"); ok("tour: 'Take the tour' replays it for someone who has seen it; the seen date is unchanged; focus returns to the link"); C5.dom.window.close();
    // ?tour=1 (what the link does from another page) replays and cleans the address
    const C6 = await renderPage("client.html", "sam.agent@example.com", "#claTour", null, null, "?tour=1&x=2"); assert.ok(C6.d.getElementById("claTour")); assert.strictEqual(C6.win.location.search, "?x=2"); ok("tour: ?tour=1 replays it and is removed from the address"); C6.dom.window.close();
    // not complete yet (no last name), or the column does not exist (database without migration 14): no auto-start
    const C7 = await renderPage("client.html", "sample.new.client@example.com", "header", null, (st) => { st.users.find((u) => u.id === id("c7")).lastName = ""; }); assert.ok(!C7.d.getElementById("claTour")); ok("tour: does not auto-start before the profile is complete"); C7.dom.window.close();
    const C8 = await renderPage("client.html", "sample.new.client@example.com", "header", null, (st) => { delete st.users.find((u) => u.id === id("c7")).tourSeenAt; }); assert.ok(!C8.d.getElementById("claTour")); assert.ok(C8.d.getElementById("claTourLink")); ok("tour: an unknown flag (migration 14 not applied) never auto-starts, the link still works"); C8.dom.window.close();
    // saving 'seen' fails: nothing breaks, and it does not start twice in the same tab
    const C9 = await renderPage("client.html", "sample.new.client@example.com", "#claTour"); const CA = C9.win.CLA; assert.ok(CA.startTour);
    // missing / hidden targets are skipped and counted out
    C9.d.getElementById("claTourSkip").click(); await tick(40);
    C9.d.querySelector('[data-tour="c-rep"]').remove(); C9.d.querySelector('[data-tour="c-quotes"]').hidden = true;
    const run = CA.runTour(CA.tourSteps("client", { role: "client" })); await tick(30); assert.strictEqual(boxCount(C9.d), "Step 1 of 5"); const seen = []; for (let k = 0; k < 5; k++) { seen.push(boxTitle(C9.d)); C9.d.getElementById("claTourNext").click(); await tick(30); } assert.ok(!seen.includes("Your saved quotes") && !seen.includes("Talk to your rep") && seen[4] === "One last thing"); ok("tour: a missing or hidden target is skipped, and the step counter only counts the steps shown");
    assert.strictEqual(CA.runTour([{ target: '[data-tour="nope"]', title: "x", text: "y" }]), null); ok("tour: a tour whose targets all vanished does not start");
    C9.dom.window.close();
    const CB = await renderPage("client.html", "sample.new.client@example.com", "#claTour"); CB.d.getElementById("claTourSkip").click(); await tick(60); assert.strictEqual(await CB.win.CLA.initTour({ markTourSeen: async () => { throw new Error("x"); } }, { id: id("c7"), role: "client", tourSeenAt: null, isComplete: true }), null); ok("tour: once per tab even if marking fails (session guard), and no error"); CB.dom.window.close();
    // narrow screens: a sheet at the bottom
    const CM = await renderPage("client.html", "sam.agent@example.com", "#claTourLink"); Object.defineProperty(CM.win, "innerWidth", { value: 390, configurable: true });
    CM.win.CLA.runTour(CM.win.CLA.tourSteps("client", { role: "client" })); await tick(30); assert.ok(CM.d.querySelector(".claTourPop").classList.contains("sheet")); ok("tour: on a phone-width screen the box becomes a bottom sheet"); CM.dom.window.close();
    // REP: new rep sees the rep tour, the Quotes tab is opened for its step and closed again
    const P1 = await renderPage("rep.html", "sample.new.rep@clatitle.com", "#claTour"); const pd = P1.d; assert.strictEqual(P1.errs.length, 0, P1.errs.join()); assert.strictEqual(boxCount(pd), "Step 1 of 6"); assert.strictEqual(boxTitle(pd), "Welcome to your dashboard"); ok("tour: starts by itself for a brand-new rep (Step 1 of 6)");
    await nextN(P1, 3); assert.strictEqual(boxTitle(pd), "All quotes in one place"); assert.ok(!pd.getElementById("pQuotes").hidden && pd.getElementById("pClients").hidden); await nextN(P1, 1); assert.ok(pd.getElementById("pQuotes").hidden && !pd.getElementById("pClients").hidden); ok("tour: the Quotes tab opens for its step and the Clients tab comes back when you move on");
    pd.dispatchEvent(new P1.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(40); assert.ok(seenOf(P1, id("b3"))); P1.dom.window.close();
    const P2 = await renderPage("rep.html", "sample.rep.jane@clatitle.com", "#claTourLink"); assert.ok(!P2.d.getElementById("claTour")); ok("tour: not for a rep who has seen it"); P2.dom.window.close();
    const P3 = await renderPage("rep.html", "sample.admin@clatitle.com", "#claTourLink", null, null, "?tour=1"); await tick(100); assert.strictEqual(boxCount(P3.d), "Step 1 of 7"); await nextN(P3, 6); assert.strictEqual(boxTitle(P3.d), "You are also an admin"); ok("tour: an admin who also reps gets the rep tour (7 steps) with a step about the two dashboards"); P3.dom.window.close();
    // ADMIN pages
    const SA = await renderPage("admin.html", "sample.admin@clatitle.com", "#claTour", null, newUser(id("a1"))), sd = SA.d; assert.strictEqual(SA.errs.length, 0, SA.errs.join()); assert.strictEqual(boxCount(sd), "Step 1 of 7"); assert.strictEqual(boxTitle(sd), "Welcome to the admin dashboard"); ok("tour: starts by itself for a new super admin (Step 1 of 7)");
    await nextN(SA, 2); assert.strictEqual(boxTitle(sd), "Change a role"); await nextN(SA, 1); assert.strictEqual(boxTitle(sd), "Also works as a rep"); assert.ok(sd.querySelector('[data-tour="u-also"]')); await nextN(SA, 1);
    assert.strictEqual(boxTitle(sd), "Invite someone"); assert.ok(!sd.getElementById("invCard").hidden); await nextN(SA, 1); assert.ok(sd.getElementById("invCard").hidden); assert.strictEqual(boxTitle(sd), "Assignments"); assert.ok(!sd.getElementById("pAssign").hidden && sd.getElementById("pUsers").hidden);
    await nextN(SA, 1); assert.strictEqual(boxTitle(sd), "Staff feedback"); assert.ok(!sd.getElementById("pFeedback").hidden && sd.getElementById("pAssign").hidden); assert.match(sd.getElementById("claTourText").textContent, /approve or dismiss/);
    sd.getElementById("claTourNext").click(); await tick(60); assert.ok(!sd.getElementById("claTour") && !sd.getElementById("pUsers").hidden && sd.getElementById("pFeedback").hidden && seenOf(SA, id("a1"))); ok("tour: super admin steps (roles, also-a-rep, invite form, assignments, feedback) open and close what they show; Done puts the Users tab back"); SA.dom.window.close();
    const AD = await renderPage("admin.html", "sample.robin.admin@clatitle.com", "#claTour", null, newUser(id("a2"))); assert.strictEqual(boxCount(AD.d), "Step 1 of 6"); const adTitles = []; for (let k = 0; k < 6; k++) { adTitles.push(boxTitle(AD.d)); await nextN(AD, 1); } assert.ok(!adTitles.includes("Also works as a rep") && adTitles.includes("Invite someone")); ok("tour: a new Admin gets 6 steps (no 'also works as a rep' switch: it is for super admins)"); AD.dom.window.close();
    // header link placement: Feedback, then Take the tour, then the profile chip (no collision); none for guests
    const H = await renderPage("rep.html", "sample.rep.jane@clatitle.com", "#claFeedbackLink"); const kids = [...H.d.querySelector("header .hr").children].map((c) => c.id || c.className.split(" ")[0]);
    assert.ok(H.d.querySelector("body > #claFeedbackLink") && kids.indexOf("claFeedbackLink") === -1 && kids.indexOf("claTourLink") > -1 && kids.indexOf("chip") > kids.indexOf("claTourLink")); ok("tour: the 'Take the tour' link sits before the profile chip in the header, and the Feedback bubble floats in the body without colliding"); H.dom.window.close();
    const G2 = await renderPage("login.html", null, "header"); assert.ok(!G2.d.getElementById("claTourLink")); ok("tour: no 'Take the tour' link for guests"); G2.dom.window.close();
    const PR = await renderPage("profile.html", "sample.new.client@example.com", "#claTourLink"); assert.ok(PR.d.getElementById("claTourLink") && !PR.d.getElementById("claTour") && PR.win.CLA.tourKind(await (async () => { const a = await PR.win.CLA.getAdapter(); return a.getMyProfile(); })()) === null); ok("tour: other pages (profile) have the link but never auto-start; the link sends you to your dashboard"); PR.dom.window.close();
    // files: no external libraries / CDN; motion respects prefers-reduced-motion
    const tj = fs.readFileSync(path.join(__dirname, "js", "tour.js"), "utf8"), tc = fs.readFileSync(path.join(__dirname, "tour.css"), "utf8");
    assert.ok(!/https?:\/\/|import\s|require\(/.test(tj) && !/https?:\/\/|@import/.test(tc)); assert.ok(/prefers-reduced-motion:no-preference/.test(tc) && !/(^|\})\s*\.[^{]*\{[^}]*transition/.test(tc.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})+\s*\}/g, ""))); ok("tour: no external libraries or CDN; animation only when the person has not asked for reduced motion");
    // supabase adapter mapping
    const tcalls = [];
    const mk = (row) => CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: id("c7"), email: "e" } } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }), rpc: async (n, a) => { tcalls.push(["rpc", n, a]); return { data: null, error: null }; } }) });
    const base = { id: id("c7"), role: "client", status: "active", email: "e", first_name: "N", last_name: "N", is_complete: true };
    assert.strictEqual((await mk({ ...base, tour_seen_at: null }).getMyProfile()).tourSeenAt, null); assert.strictEqual((await mk({ ...base, tour_seen_at: "2026-10-25T10:00:00Z" }).getMyProfile()).tourSeenAt, "2026-10-25T10:00:00Z"); assert.strictEqual((await mk({ ...base }).getMyProfile()).tourSeenAt, undefined); ok("supabase: tour_seen_at maps to tourSeenAt (null = new, a date = seen, missing column = unknown)");
    tcalls.length = 0; await mk(base).markTourSeen(); const mc = tcalls.find((c) => c[0] === "rpc"); assert.ok(mc && mc[1] === "mark_tour_seen" && (!mc[2] || Object.keys(mc[2]).length === 0)); ok("supabase: markTourSeen calls the mark_tour_seen RPC with no arguments (no table write)");
  }

  // ---- Supabase adapter against a fake client ----
  const calls = [];
  const chain = (table, rows) => { const o = { _t: table };
    for (const m of ["select", "eq", "in", "is", "order", "limit", "insert", "update", "delete", "upsert"]) o[m] = (...a) => { calls.push([table, m, a]); return o; };
    o.maybeSingle = o.single = async () => ({ data: Array.isArray(rows) ? rows[0] : rows, error: null });
    o.then = (res) => res({ data: rows, error: null }); return o; };
  const fake = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: id("c1"), email: "sam.agent@example.com" } } } }) },
    from: (t) => chain(t, t === "quotes" ? [{ id: "q1", owner_id: id("c1"), rep_id: id("b1"), quote_type: "buyer", price: "525000.00", created_at: "x", expires_at: "y", inputs: {}, results: {}, deleted_at: null }] : [{ id: id("c1"), role: "client", status: "active", email: "e", first_name: "Sam", last_name: "A", company_name: "Acme", is_complete: true }]),
    rpc: async (n, a) => { calls.push(["rpc", n, a]); return { data: n === "get_my_rep_contact" ? [{ id: id("b1"), first_name: "Jane", last_name: "R", phone: "1", cell_phone: "+13015550112", email: "j@clatitle.com", avatar_path: "p" }] : null, error: null }; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }) }) },
    functions: { invoke: async (n, o) => { calls.push(["fn", n, o]); return { data: { ok: true }, error: null }; } } }) };
  const S = CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, fake);
  const mine = await S.listMyQuotes(); assert.strictEqual(mine[0].price, 525000); assert.strictEqual(mine[0].quoteType, "buyer"); ok("supabase: quote rows map to DTOs");
  await S.saveQuote(snap); const ins = calls.find((c) => c[0] === "quotes" && c[1] === "insert")[2][0];
  assert.ok(!("expires_at" in ins) && !("rep_id" in ins) && !("created_at" in ins) && ins.owner_id === id("c1")); ok("supabase: save sends no expiry/rep/created_at (server sets them)");
  await S.updateQuote("q1", snap); const upd = calls.find((c) => c[0] === "quotes" && c[1] === "update")[2][0]; assert.ok(!("expires_at" in upd) && !("deleted_at" in upd) && !("owner_id" in upd)); ok("supabase: update cannot touch expiry/owner/deleted_at");
  const srep = await S.getMyRep(); assert.strictEqual(srep.firstName, "Jane"); assert.strictEqual(srep.cellPhone, "+13015550112");
  assert.ok(calls.some((c) => c[0] === "rpc" && c[1] === "get_my_rep_contact")); ok("supabase: get_my_rep_contact RPC maps (incl. cell)");
  await S.deleteQuote("q1"); assert.ok(calls.some((c) => c[0] === "rpc" && c[1] === "delete_my_quote")); ok("supabase: delete goes through delete_my_quote RPC");
  await S.adminInvite({ email: "a@b.com", role: "client", repId: "r" }); assert.ok(calls.some((c) => c[0] === "fn" && c[1] === "invite-user")); ok("supabase: invites go through the Edge Function (no service key in the browser)");
  calls.length = 0;
  await S.adminInvite({ email: "a@b.com", role: "client", repId: "r", cellPhone: "(240) 555-0142" });
  assert.strictEqual(calls.find((c) => c[0] === "fn" && c[1] === "invite-user")[2].body.cellPhone, "+12405550142"); ok("supabase: admin invite sends the cell normalized to the Edge Function");
  await S.adminInvite({ email: "a@b.com", role: "client" }); assert.strictEqual(calls.filter((c) => c[0] === "fn").pop()[2].body.cellPhone, null); ok("supabase: invite without a cell sends null");
  calls.length = 0; await S.adminSetRole("u1", "client", "r1"); await S.adminSetRole("u2", "rep"); await S.adminSetIsRep("u3", false, "r2"); await S.adminSetIsRep("u4", true);
  const rc = calls.filter((c) => c[0] === "rpc").map((c) => c[2]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rc)), [{ p_user: "u1", p_role: "client", p_reassign_to: "r1" }, { p_user: "u2", p_role: "rep" }, { p_user: "u3", p_is_rep: false, p_reassign_to: "r2" }, { p_user: "u4", p_is_rep: true }]); ok("supabase: role / rep-switch RPCs send p_reassign_to only when a successor is given (old call shape unchanged)");
  await S.inviteClient("c@d.com", { cellPhone: "240.555.0142" }); assert.strictEqual(calls.filter((c) => c[0] === "fn").pop()[2].body.cellPhone, "+12405550142"); ok("supabase: rep invite sends the cell");
  await reject(S.inviteClient("c@d.com", { cellPhone: "12" }), /valid 10-digit US cell/, "supabase: invalid invite cell refused before any call");
  calls.length = 0; await S.updateMyProfile({ cellPhone: "(240) 555-0142", firstName: "Sam" });
  assert.strictEqual(calls.find((c) => c[0] === "profiles" && c[1] === "update")[2][0].cell_phone, "+12405550142"); ok("supabase: profile update sends cell_phone as +1XXXXXXXXXX");
  await S.updateMyProfile({ cellPhone: "" }); assert.strictEqual(calls.filter((c) => c[0] === "profiles" && c[1] === "update").pop()[2][0].cell_phone, null); ok("supabase: clearing the cell sends null");
  const nUpd = calls.filter((c) => c[1] === "update").length; await reject(S.updateMyProfile({ cellPhone: "nope" }), /valid 10-digit US cell/, "supabase: invalid cell refused");
  assert.strictEqual(calls.filter((c) => c[1] === "update").length, nUpd); ok("supabase: ...without calling the database");
  await S.updateMyProfile({ firstName: "Sam" }); assert.ok(!("cell_phone" in calls.filter((c) => c[1] === "update").pop()[2][0])); ok("supabase: other edits do not touch cell_phone");
  const fake2 = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: id("b1") } } } }) },
    from: (t) => chain(t, t === "assignments" ? [{ id: "x1", client_email: "sam@e.com", client_user_id: id("c1"), rep_id: id("b1"), active: true }, { id: "x2", client_email: "new@e.com", client_user_id: null, rep_id: id("b1"), active: true }]
      : t === "profiles" ? [{ id: id("c1"), role: "client", status: "active", email: "sam@e.com", first_name: "Sam", last_name: "A", cell_phone: "+12405550132" }]
      : t === "invitations" ? [{ email: "new@e.com", cell_phone: "+17035550150" }] : []) }) };
  const cl2 = await CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, fake2).listMyClients();
  assert.strictEqual(cl2.find((c) => c.email === "sam@e.com").cellPhone, "+12405550132"); assert.strictEqual(cl2.find((c) => c.email === "new@e.com").cellPhone, "+17035550150"); ok("supabase: rep client list maps cells (profile cell, or the pending invitation's)");
  await S.adminSetStatus("u", "disabled"); assert.ok(calls.some((c) => c[0] === "fn" && c[1] === "set-user-status")); ok("supabase: disable goes through the Edge Function");
  assert.strictEqual(await S.getAvatarUrl({ id: id("b1"), avatarPath: "p" }), "https://signed"); ok("supabase: photos via signed URLs");
  assert.ok(!/service_role|SERVICE_ROLE/.test(fs.readFileSync(path.join(dir, "supabase-adapter.js"), "utf8").replace(/\/\*[\s\S]*?\*\//, ""))); ok("no service-role key referenced in browser code");
  // ---- admin+rep through the Supabase adapter ----
  const fake3 = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: id("a1"), email: "sample.admin@clatitle.com" } } } }) },
    from: (t) => chain(t, t === "profiles" ? [{ id: id("a1"), role: "super_admin", is_rep: true, status: "active", email: "e", first_name: "Alex", last_name: "A", is_complete: true }] : t === "assignments" ? [{ id: "x1", client_email: "q@e.com", client_user_id: null, rep_id: id("a1"), active: true }] : t === "invitations" ? [{ email: "q@e.com", cell_phone: "+12025550182" }] : []),
    rpc: async (n, a) => { calls.push(["rpc", n, a]); return { data: null, error: null }; },
    functions: { invoke: async (n, o) => { calls.push(["fn", n, o]); return { data: { ok: true }, error: null }; } } }) };
  const S3 = CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, fake3);
  calls.length = 0;
  assert.strictEqual((await S3.getMyProfile()).isRep, true); ok("supabase: super_admin + is_rep maps to isRep = true");
  const rowRole = async (role, flag) => (await CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: fake3.createClient().auth, from: (t) => chain(t, [{ id: id("a1"), role, is_rep: flag, status: "active", email: "e" }]) }) }).getMyProfile()).isRep;
  assert.strictEqual(await rowRole("super_admin", false), false); assert.strictEqual(await rowRole("super_admin", undefined), false); assert.strictEqual(await rowRole("rep", undefined), true); assert.strictEqual(await rowRole("client", true), false); ok("supabase: isRep is false for a plain admin or a client (even if flagged), true for a rep");
  calls.length = 0; await S3.listMyClients();
  assert.ok(calls.some((c) => c[0] === "assignments" && c[1] === "eq" && c[2][0] === "rep_id" && c[2][1] === id("a1"))); ok("supabase: own-client list filters assignments by rep_id = me (admins can read all assignments)");
  calls.length = 0; await S3.inviteClient("n@e.com", { cellPhone: "2405550142" });
  const ib = calls.find((c) => c[0] === "fn" && c[1] === "invite-user")[2].body; assert.ok(ib.role === "client" && ib.repId === id("a1") && ib.asRep === true && ib.cellPhone === "+12405550142"); ok("supabase: rep-dashboard invite sends repId = me and asRep (rep rules at the database)");
  calls.length = 0; await S3.adminInvite({ email: "a@clatitle.com", role: "super_admin", isRep: true });
  assert.strictEqual(calls.find((c) => c[0] === "fn")[2].body.isRep, true); await S3.adminInvite({ email: "a@b.com", role: "client", isRep: true }); assert.strictEqual(calls.filter((c) => c[0] === "fn").pop()[2].body.isRep, false); ok("supabase: isRep is sent only for a super admin invitation");
  await S3.adminSetIsRep(id("c1"), true); const r3 = calls.find((c) => c[0] === "rpc" && c[1] === "admin_set_is_rep"); assert.strictEqual(JSON.stringify(r3[2]), JSON.stringify({ p_user: id("c1"), p_is_rep: true })); ok("supabase: adminSetIsRep calls the admin_set_is_rep RPC");
  assert.ok(!/is_rep/.test(JSON.stringify(calls.filter((c) => c[1] === "update")))); ok("supabase: no direct is_rep column writes (the API cannot write it)");
  // ---- the admin role through the Supabase adapter ----
  assert.strictEqual(await rowRole("admin", true), true); assert.strictEqual(await rowRole("admin", false), false); assert.strictEqual(await rowRole("admin", undefined), false); ok("supabase: admin + is_rep maps to isRep; a plain admin does not");
  calls.length = 0; await S3.adminInvite({ email: "a@clatitle.com", role: "admin", isRep: true }); assert.strictEqual(calls.find((c) => c[0] === "fn")[2].body.isRep, true); assert.strictEqual(calls.find((c) => c[0] === "fn")[2].body.role, "admin"); ok("supabase: inviting an admin who also reps sends role admin + isRep");
  await S3.adminInvite({ email: "a@clatitle.com", role: "admin" }); assert.strictEqual(calls.filter((c) => c[0] === "fn").pop()[2].body.isRep, false); ok("supabase: a plain admin invitation sends isRep false");
  const refuse = (message, code) => CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: fake3.createClient().auth, rpc: async () => ({ data: null, error: { message, code } }),
    functions: { invoke: async () => ({ data: null, error: { message: "Edge Function returned a non-2xx status code", context: { json: async () => ({ error: message }) } } }) } }) });
  await reject(refuse("only a super admin can change the role of an admin or super admin", "42501").adminSetRole("u", "client"), /^Only a super admin can change the role of an admin or super admin\.$/, "supabase: the database's refusal is shown as a readable sentence (not a generic 'no access')");
  await reject(refuse("there must always be at least one active super admin", "55000").adminSetRole("u", "client"), /^There must always be at least one active super admin\.$/, "supabase: the last-super-admin refusal reads well");
  await reject(refuse("only a super admin can disable or re-enable an admin or super admin", "42501").adminSetStatus("u", "disabled"), /^Only a super admin can disable or re-enable an admin or super admin\.$/, "supabase: Edge Function refusals read well too");
  await reject(refuse("not allowed", "42501").adminSetRole("u", "client"), /You do not have access to that/, "supabase: a bare 42501 is still the generic message");

  // ---- staff feedback through the Supabase adapter ----
  {
    const fb = [{ id: "f1", created_at: "2026-10-25T10:00:00Z", user_id: id("b1"), role_at_submit: "rep", category: "bug", message: "<b>x</b>", page_path: "/index.html", status: "new", notified_at: null, decided_at: null, decided_note: null }];
    const cl = []; const chain2 = (t) => { const o = {}; for (const m of ["select", "eq", "order", "limit"]) o[m] = (...a) => { cl.push([t, m, a]); return o; }; o.then = (res) => res({ data: t === "feedback" ? fb : [{ id: id("b1"), role: "rep", is_rep: false, status: "active", email: "e", first_name: "J", last_name: "R", is_complete: true }], error: null }); o.maybeSingle = o.single = async () => ({ data: { id: id("b1"), role: "rep", is_rep: false, status: "active", email: "e", first_name: "J", last_name: "R", is_complete: true }, error: null }); return o; };
    const SF = CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: id("b1"), email: "e" } } } }) }, from: (t) => chain2(t),
      rpc: async (n, a) => { cl.push(["rpc", n, a]); return { data: n === "submit_feedback" ? "new-id" : null, error: null }; } }) });
    assert.strictEqual((await SF.submitFeedback({ category: "idea", message: "m", page: "/p" })).id, "new-id"); assert.strictEqual(JSON.stringify(cl.find((c) => c[1] === "submit_feedback")[2]), JSON.stringify({ p_category: "idea", p_message: "m", p_page: "/p" })); ok("supabase: submitFeedback calls the submit_feedback RPC (no table insert)");
    await SF.adminSetFeedbackStatus("f1", "approved", "ok"); assert.strictEqual(JSON.stringify(cl.find((c) => c[1] === "admin_set_feedback_status")[2]), JSON.stringify({ p_id: "f1", p_status: "approved", p_note: "ok" })); assert.ok(!cl.some((c) => c[0] === "feedback" && ["insert", "update", "delete"].includes(c[1]))); ok("supabase: deciding calls admin_set_feedback_status (no direct table writes)");
    const list = await SF.adminListFeedback(); assert.strictEqual(JSON.stringify(list[0]), JSON.stringify({ id: "f1", createdAt: "2026-10-25T10:00:00Z", userId: id("b1"), roleAtSubmit: "rep", category: "bug", message: "<b>x</b>", pagePath: "/index.html", status: "new", notifiedAt: null, decidedAt: null, decidedNote: null })); ok("supabase: feedback rows map to the Feedback DTO");
    assert.strictEqual((await SF.listMyFeedback()).length, 1); assert.ok(cl.some((c) => c[0] === "feedback" && c[1] === "eq" && c[2][0] === "user_id")); ok("supabase: listMyFeedback filters on the caller's user id");
    assert.ok(!/user_agent/.test(JSON.stringify(cl.filter((c) => c[1] === "select")))); ok("supabase: the user agent column is never read into the app");
    const rf = (message, code) => CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: fake3.createClient().auth, rpc: async () => ({ data: null, error: { message, code } }) }) });
    await reject(rf("you have sent a lot of feedback recently: please try again later", "54000").submitFeedback({ category: "bug", message: "x" }), /^You have sent a lot of feedback recently: please try again later\.$/, "supabase: the rate-limit message reads well");
    await reject(rf("only a super admin can decide feedback", "42501").adminSetFeedbackStatus("f1", "approved"), /super admin/i, "supabase: a refusal to decide is shown");
  }

  // ---- the CALCULATOR tour (index.html, for anyone: guest or signed in; same engine as the portal tours) ----
  {
    const root = path.join(__dirname, "..");
    const idx = fs.readFileSync(path.join(root, "index.html"), "utf8"), tj2 = fs.readFileSync(path.join(__dirname, "js", "tour.js"), "utf8");
    const zjs2 = fs.readFileSync(path.join(root, "zip-county.js"), "utf8"), sjs2 = fs.readFileSync(path.join(root, "fee-snapshot.js"), "utf8");
    const tick2 = (ms) => new Promise((r) => setTimeout(r, ms || 40));
    // jsdom cannot lazy-load scripts: the snapshot data and tour.js are inlined (the real page downloads tour.js only when the tour starts)
    const calcHtml = idx.replace(/<script src="https[^>]+><\/script>/, "").replace(/<link[^>]*fonts\.googleapis[^>]*>/, "")
      .replace(/<script src="zip-county.js[^"]*"><\/script>/, "<script>" + zjs2 + "</script>").replace(/<script src="fee-snapshot.js[^"]*"><\/script>/, "<script>" + sjs2 + "</script>")
      .replace(/<script src="portal\/js\/portal-hook.js[^"]*" defer><\/script>/, "").replace("<script>\n// Guided tour:", "<script>" + tj2 + "</script><script>\n// Guided tour:");
    const mkCalc = async ({ store, width, noStorage, extra } = {}) => {
      const errs = [];
      const dom = new JSDOM(calcHtml, { url: "http://localhost/index.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(win) { win.fetch = async () => ({ ok: false, status: 401, text: async () => "" }); win.addEventListener("error", (e) => errs.push(e.message));
          for (const k in store || {}) win.localStorage.setItem(k, store[k]);
          if (width) Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
          if (noStorage) Object.defineProperty(win, "localStorage", { get() { throw new Error("blocked"); } }); } });
      const d = dom.window.document; await tick2(80);
      if (extra) extra(d);
      return { dom, win: dom.window, d, errs };
    };
    const nums = (d) => ["tB", "tS", "tA"].map((i) => d.getElementById(i).textContent).join("|");
    const tcount = (d) => d.getElementById("claTourCount").textContent, ttitle = (d) => d.getElementById("claTourTitle").textContent;
    const stepNext = async (C, n) => { for (let k = 0; k < n; k++) { C.d.getElementById("claTourNext").click(); await tick2(130); } };
    const CHIP = "cla_calc_tour_chip";

    // link present: a visible "Take the tour" button in the header, next to Reload (works with no login and no portal config)
    const G = await mkCalc(); assert.strictEqual(G.errs.length, 0, G.errs.join());
    const lk = G.d.getElementById("claCalcTourLink"); assert.ok(lk && lk.tagName === "BUTTON" && lk.textContent === "Take the tour" && lk.closest("header .hr") && !lk.hidden && lk.previousElementSibling.id === "btnReload"); ok("calculator tour: a 'Take the tour' button sits in the header (guest, no login needed)");

    // every target exists in the page
    const ST = G.win.CLA.tourSteps("calculator", {}), targets = ST.map((s) => s.target).filter(Boolean);
    const tourAttrs = targets.filter((t) => /data-tour="k-/.test(t)); assert.strictEqual(tourAttrs.length, 12);
    for (const t of tourAttrs) assert.strictEqual(G.d.querySelectorAll(t).length, 1, t + " must match exactly one element");
    assert.ok([...G.d.querySelectorAll('[data-tour^="k-"]')].length === 12); ok("calculator tour: all 12 data-tour targets exist exactly once in index.html");

    // steps: count, order, wording
    const avail = (C, me) => C.win.CLA.tourAvailable(C.win.CLA.tourSteps("calculator", me || {}));
    assert.strictEqual(ST.length, 15); assert.strictEqual(avail(G).length, 13); ok("calculator tour: 15 steps defined; 13 for a guest with no portal (the save and feedback steps need signed-in-only elements)");
    const sv = G.d.createElement("button"); sv.id = "claSave_quote"; sv.textContent = "Log in to save"; G.d.querySelector("#mainQ .foot").appendChild(sv);
    assert.strictEqual(avail(G).length, 14); const fbb = G.d.createElement("button"); fbb.id = "claFeedbackLink"; G.d.body.appendChild(fbb); assert.strictEqual(avail(G).length, 15); ok("calculator tour: 14 steps with the portal's save button (guest or client), 15 when the staff feedback bubble is there too");
    assert.ok(/aren't saved/.test(G.win.CLA.tourSteps("calculator", { signedIn: false }).find((s) => s.target === "#claSave_quote").text) && /save on their own/.test(G.win.CLA.tourSteps("calculator", { signedIn: true }).find((s) => s.target === "#claSave_quote").text)); ok("calculator tour: the save step reads differently for a guest and for someone signed in");
    assert.strictEqual(JSON.stringify(ST.map((s) => s.title)), JSON.stringify(["Welcome to the closing cost estimator", "Buyer quote or seller net sheet", "Purchase, cash or refinance", "Start with the ZIP", "Price and loan amount", "Title policy choices", "CLA fees, endorsements, documents", "Your estimate", "Where every dollar comes from", "Copy or print your quote", "Seller net sheet", "Saving a quote", "Tell me what to fix", "Take the tour any time", "Estimates only"])); ok("calculator tour: step order (welcome, tabs, ZIP, amounts, policy, fees, total, breakdown, copy/print, seller, save, feedback, replay, disclaimer)");
    assert.ok(ST.every((s) => s.title && s.text.length < 330 && s.title.length < 45) && !/<|&lt;/.test(JSON.stringify(ST)) && /^Hi, I'm John\./.test(ST[0].text) && /estimates, not a Loan Estimate or Closing Disclosure/.test(ST[14].text) && /sign in/.test(ST[0].text)); ok("calculator tour: short plain copy in John's voice, welcome says no sign-in is needed, ends with the estimates-only disclaimer");
    const alltext = JSON.stringify(ST); assert.ok(!/login required|must (sign|log) in/i.test(alltext)); assert.ok(!/https?:\/\//.test(tj2)); ok("calculator tour: nothing in it requires a login");

    // run it: skipping a missing or hidden target, counts, and the box
    const C0 = await mkCalc(); C0.d.querySelector('[data-tour="k-policy"]').remove(); C0.d.getElementById("claTourChipGo").click(); await tick2(60);
    assert.strictEqual(tcount(C0.d), "Step 1 of 12"); assert.ok(C0.d.getElementById("claTour") && C0.d.querySelector(".claTourPop").getAttribute("role") === "dialog"); const titles0 = []; for (let k = 0; k < 12; k++) { titles0.push(ttitle(C0.d)); if (k < 11) await stepNext(C0, 1); }
    assert.ok(!titles0.includes("Title policy choices") && titles0.includes("Where every dollar comes from") && titles0.length === 12); ok("calculator tour: a missing target is skipped, and the step counter only counts the steps shown (12 of 13)");
    C0.d.getElementById("claTourNext").click(); await tick2(40); assert.ok(!C0.d.getElementById("claTour")); C0.win.close();
    const C1 = await mkCalc(); C1.d.querySelector('[data-tour="k-tourlink"]').hidden = true; C1.d.getElementById("claTourChipGo").click(); await tick2(60);
    assert.strictEqual(tcount(C1.d), "Step 1 of 12"); C1.d.getElementById("claTourSkip").click(); await tick2(40); assert.ok(!C1.d.getElementById("claTour")); ok("calculator tour: a hidden target is skipped too; Skip tour closes it"); C1.win.close();
    const C2 = await mkCalc(); C2.d.getElementById("claCalcTourLink").click(); await tick2(60); assert.ok(C2.d.getElementById("claTour")); C2.d.dispatchEvent(new C2.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await tick2(100); assert.strictEqual(tcount(C2.d), "Step 2 of 13");
    C2.d.dispatchEvent(new C2.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick2(40); assert.ok(!C2.d.getElementById("claTour")); assert.strictEqual(C2.d.activeElement.id, "claCalcTourLink"); ok("calculator tour: the header link starts it, the arrow keys move, Esc closes it and focus goes back to the link"); C2.win.close();

    // tab restore: the Seller Net Sheet is opened for its step and the person's own tab is put back; Purchase / Cash / Refinance are never touched; no number changes
    const T1 = await mkCalc(); const before = nums(T1.d), typeBefore = T1.d.querySelector("#tabs button.on").dataset.t, docsBefore = T1.d.getElementById("docs").innerHTML, endsBefore = T1.d.getElementById("ends").innerHTML;
    T1.d.querySelector('#tabs button[data-t="cash"]').click(); const cashNums = nums(T1.d), cashDocs = T1.d.getElementById("docs").innerHTML; T1.d.querySelector('#tabs button[data-t="cash"]').parentElement.querySelector('[data-t="purchase"]').click();
    T1.d.getElementById("claCalcTourLink").click(); await tick2(60); let seenSeller = false; const mode = () => T1.d.querySelector("#modes button.on").dataset.mode;
    for (let k = 0; k < 13; k++) { if (ttitle(T1.d) === "Seller net sheet") { seenSeller = true; assert.strictEqual(mode(), "seller"); assert.ok(T1.d.getElementById("mainQ").hidden && !T1.d.getElementById("mainS").hidden); } if (k < 12) await stepNext(T1, 1); }
    assert.ok(seenSeller); assert.strictEqual(mode(), "quote"); assert.strictEqual(ttitle(T1.d), "Estimates only"); T1.d.getElementById("claTourNext").click(); await tick2(60);
    assert.ok(!T1.d.getElementById("claTour") && mode() === "quote" && !T1.d.getElementById("mainQ").hidden && T1.d.getElementById("mainS").hidden && !T1.d.getElementById("discQ").hidden); ok("calculator tour: Buyer Quote tab is restored after the Seller Net Sheet step (and the right disclaimer shows)");
    assert.strictEqual(T1.d.querySelector("#tabs button.on").dataset.t, typeBefore); assert.strictEqual(nums(T1.d), before); assert.strictEqual(T1.d.getElementById("docs").innerHTML, docsBefore); assert.strictEqual(T1.d.getElementById("ends").innerHTML, endsBefore); assert.notStrictEqual(cashNums, before); ok("calculator tour: Purchase / Cash / Refinance, the documents, the endorsements and every number are exactly as before the tour: " + before);
    // starting on the Seller Net Sheet: the tour shows the buyer steps, then puts the seller tab back (also when closed half way through)
    const T2 = await mkCalc(); T2.d.querySelector('#modes button[data-mode="seller"]').click(); const sBefore = T2.d.getElementById("sNet").textContent; T2.d.getElementById("claCalcTourLink").click(); await tick2(60);
    await stepNext(T2, 2); assert.strictEqual(ttitle(T2.d), "Purchase, cash or refinance"); assert.ok(!T2.d.getElementById("mainQ").hidden); await stepNext(T2, 1);
    assert.strictEqual(ttitle(T2.d), "Start with the ZIP"); T2.d.getElementById("claTourSkip").click(); await tick2(60); assert.strictEqual(T2.d.querySelector("#modes button.on").dataset.mode, "seller"); assert.ok(T2.d.getElementById("mainQ").hidden && !T2.d.getElementById("mainS").hidden && T2.d.getElementById("sNet").textContent === sBefore); ok("calculator tour: started on the Seller Net Sheet, a closed tour leaves the person on the Seller Net Sheet with the same net");
    const T3 = await mkCalc(); T3.d.querySelector('#modes button[data-mode="seller"]').click(); T3.d.getElementById("claCalcTourLink").click(); await tick2(60); await stepNext(T3, 11); assert.strictEqual(ttitle(T3.d), "Take the tour any time"); await stepNext(T3, 1); T3.d.getElementById("claTourNext").click(); await tick2(60);
    assert.strictEqual(T3.d.querySelector("#modes button.on").dataset.mode, "seller"); ok("calculator tour: started on the Seller Net Sheet, finishing the tour puts that tab back"); [T1, T2, T3].forEach((x) => x.win.close());

    // the first-visit chip: shown once, dismissed for good (localStorage)
    const F1 = await mkCalc(); const chip = F1.d.getElementById("claTourChip"); assert.ok(chip && !chip.hidden && /New here\?/.test(chip.textContent) && /Take a 1-minute tour/.test(chip.textContent) && !F1.d.getElementById("claTour")); ok("calculator tour: a first-time visitor sees a small 'New here? Take a 1-minute tour' chip, and nothing opens by itself");
    assert.ok(chip.closest(".modebar") && F1.d.getElementById("claTourChipX").getAttribute("aria-label")); F1.d.getElementById("claTourChipX").click(); assert.ok(chip.hidden); assert.strictEqual(F1.win.localStorage.getItem(CHIP), "1"); ok("calculator tour: the x dismisses the chip and remembers it in localStorage");
    const F2 = await mkCalc({ store: { [CHIP]: "1" } }); assert.ok(F2.d.getElementById("claTourChip").hidden && !F2.d.getElementById("claTour")); ok("calculator tour: a returning visitor who dismissed it never sees the chip again (and the header link still works)");
    const F3 = await mkCalc(); F3.d.getElementById("claTourChipGo").click(); await tick2(60); assert.ok(F3.d.getElementById("claTour") && F3.d.getElementById("claTourChip").hidden && F3.win.localStorage.getItem(CHIP) === "1"); ok("calculator tour: taking the tour from the chip hides the chip for good too");
    const F4 = await mkCalc(); F4.d.getElementById("claCalcTourLink").click(); await tick2(60); assert.ok(F4.d.getElementById("claTour") && F4.win.localStorage.getItem(CHIP) === "1" && F4.d.getElementById("claTourChip").hidden); ok("calculator tour: starting it from the header link also retires the chip");
    const F5 = await mkCalc({ noStorage: true }); assert.strictEqual(F5.errs.length, 0, F5.errs.join()); assert.ok(F5.d.getElementById("claTourChip").hidden); F5.d.getElementById("claCalcTourLink").click(); await tick2(60); assert.ok(F5.d.getElementById("claTour")); ok("calculator tour: with browser storage blocked the chip stays hidden (it could not remember 'no thanks'), no errors, and the tour still works");
    [F1, F2, F3, F4, F5].forEach((x) => x.win.close());

    // phones: the box is a bottom sheet
    const M1 = await mkCalc({ width: 390 }); M1.d.getElementById("claCalcTourLink").click(); await tick2(60); assert.ok(M1.d.querySelector(".claTourPop").classList.contains("sheet")); await stepNext(M1, 3); assert.ok(M1.d.querySelector(".claTourPop").classList.contains("sheet") && !M1.d.querySelector(".claTourSpot").hidden);
    ok("calculator tour: on a phone-width screen the box is a bottom sheet (with the spotlight on the target)"); M1.win.close();
    const D1 = await mkCalc(); D1.d.getElementById("claCalcTourLink").click(); await tick2(60); assert.ok(!D1.d.querySelector(".claTourPop").classList.contains("sheet")); ok("calculator tour: on a desktop-width screen it is a floating box, not a sheet"); D1.win.close();

    // cache-bust: every ?v= in index.html and TOUR_V agree
    const vs = [...idx.matchAll(/\?v=(\d{8}[a-z])/g)].map((m) => m[1]), pu = fs.readFileSync(path.join(__dirname, "js", "portal-ui.js"), "utf8");
    assert.ok(vs.length === 3 && new Set(vs).size === 1 && vs[0] === "20261026a" && new RegExp('CLA.TOUR_V = "' + vs[0] + '"').test(pu) && idx.includes('var V="' + vs[0] + '"')); ok("calculator tour: the index.html ?v= values (zip-county, fee-snapshot, portal-hook), the tour loader's version and CLA.TOUR_V are all 20261026a");
    // the new elements are inert in print and add no external requests
    assert.ok(/@media print\{\s*@page\{margin:14mm\}\s*\.claChip\{display:none!important\}/.test(idx) && !/https?:\/\//.test(tj2)); ok("calculator tour: the chip is not printed; tour.js has no external libraries or CDN");
  }
  console.log("\nALL PASS (" + pass + " checks)");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
