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
  const renderAdmin = async (email, expectBlocked, prep, mutate) => {
    // first load seeds + signs in (the page redirects to login when signed out), so seed the session first in a throwaway window
    const w0 = boot(), A0 = w0.CLA.createMockAdapter({}); if (prep) { await A0.signIn("sample.admin@clatitle.com", "x"); await prep(A0); } await A0.signIn(email, "x");
    const store = { cla_portal_mock_v1: w0.localStorage.getItem("cla_portal_mock_v1"), cla_portal_mock_session: w0.localStorage.getItem("cla_portal_mock_session") };
    const html = fs.readFileSync(path.join(pdir, "admin.html"), "utf8")
      .replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script src="config\.js"><\/script>/, "<script>window.CLA_PORTAL_CONFIG={mode:'mock'}</script>")
        .replace(/<script src="\.\.\/fee-snapshot\.js[^"]*"><\/script>/, () => "<script>" + fs.readFileSync(path.join(pdir, "..", "fee-snapshot.js"), "utf8") + "</script>")
      .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (m, f) => "<script>" + fs.readFileSync(path.join(pdir, f), "utf8") + "</script>" + (f === "js/portal-ui.js" ? WIDGET + TOURJS : ""));
    const errs = [];
    const dom = new JSDOM(html, { url: "http://localhost/portal/admin.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(win) { win.crypto.randomUUID = require("crypto").randomUUID; win.confirm = () => true; win.addEventListener("error", (e) => errs.push(e.message));
        if (mutate) store.cla_portal_mock_v1 = mutate(store.cla_portal_mock_v1);
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
    // "Active" only means not disabled: a person who was invited but has never signed in gets the warn badge (migration 15 data: lastSignInAt === null)
    const stBadges = (root) => [...root.querySelectorAll(".badge")].filter((b) => /^(Active|Disabled|Invited, never signed in)$/.test(b.textContent)), badge = (uid) => stBadges(R.row(uid))[0];
    assert.ok(badge(id("c7")).classList.contains("warn") && badge(id("c7")).textContent === "Invited, never signed in" && /has not signed in yet/.test(badge(id("c7")).title)); ok("admin.html: Nia (invited, never signed in) shows the warn badge 'Invited, never signed in'");
    assert.ok(badge(id("b3")).classList.contains("warn") && badge(id("b3")).textContent === "Invited, never signed in"); ok("admin.html: Riley (a rep who has never signed in) shows it too");
    assert.ok(!badge(id("c1")).classList.contains("warn") && badge(id("c1")).textContent === "Active" && /Last signed in/.test(badge(id("c1")).title)); ok("admin.html: Sam (has signed in) shows 'Active' with the last sign-in in the tooltip");
    assert.ok(badge(id("a2")).textContent === "Active" && !badge(id("a2")).classList.contains("warn")); ok("admin.html: the admin looking at the page (just signed in) is 'Active'");
    assert.ok(badge(id("c4")).classList.contains("off") && badge(id("c4")).textContent === "Disabled"); ok("admin.html: a disabled user still shows 'Disabled'");
    assert.strictEqual(stBadges(d.getElementById("users")).filter((b) => b.classList.contains("warn")).length, 2); assert.strictEqual(stBadges(d.getElementById("users")).length, 13); ok("admin.html: every row has one status badge; exactly the two never-signed-in sample users carry the warn one");
    {   // sign-in data unknown (migration 15 not applied, so the column never arrives): plain 'Active', never a wrong 'Invited' label
      const U = await renderAdmin("sample.robin.admin@clatitle.com", false, null, (raw) => { const st = JSON.parse(raw); st.users.forEach((u) => delete u.lastSignInAt); return JSON.stringify(st); });
      assert.strictEqual(stBadges(U.d.getElementById("users")).filter((b) => b.classList.contains("warn")).length, 0); assert.strictEqual(stBadges([...U.d.querySelectorAll("#users tr")].find((tr) => tr.textContent.includes("Nia Newcomer")))[0].textContent, "Active"); ok("admin.html: unknown sign-in data stays plain 'Active' (no wrong badge)"); U.dom.window.close();
    }
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
    await as("sample.admin@clatitle.com"); assert.strictEqual((await A.adminListFeedback()).length, 9); ok("feedback: the demo data has 9 sample submissions (every status)");
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
    const mine = await A.listMyFeedback(); assert.strictEqual(mine.length, 6); const row = mine.find((f) => f.id === r1.id);
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
    await A.submitFeedback({ category: "idea", message: "Admin idea" }); assert.strictEqual((await A.listMyFeedback()).length, 3); ok("feedback: an Admin can send feedback too (their own: two samples + new)");
    await as("sample.admin@clatitle.com");
    await reject(A.adminSetFeedbackStatus("fb1", "notified"), /approved or dismissed/, "feedback: notified is not settable from the app");
    await reject(A.adminSetFeedbackStatus("nope", "approved"), /No such feedback/, "feedback: an unknown id is refused");
    await reject(A.adminSetFeedbackStatus("fb1", "approved", "n".repeat(1001)), /too long/, "feedback: a 1001-character note is refused");
    await A.adminSetFeedbackStatus("fb1", "approved", "  Fixed in the next release  ");
    let f1 = (await A.adminListFeedback()).find((f) => f.id === "fb1"); assert.deepStrictEqual([f1.status, f1.decidedNote, !!f1.decidedAt], ["approved", "Fixed in the next release", true]); ok("feedback: a super admin approves with a trimmed note");
    await A.adminSetFeedbackStatus("fb1", "dismissed", "   "); f1 = (await A.adminListFeedback()).find((f) => f.id === "fb1"); assert.deepStrictEqual([f1.status, f1.decidedNote], ["dismissed", null]); ok("feedback: a decision can be changed; a blank note is stored as none");
    const au = await A.adminAuditLog(50); assert.ok(au.some((x) => x.action === "feedback_decided") && au.some((x) => x.action === "feedback_submitted")); assert.ok(!JSON.stringify(au.filter((x) => x.action === "feedback_submitted")).includes("dark mode")); ok("feedback: audited (the message itself is not copied into the audit log)");
    await as("sample.rep.jane@clatitle.com"); assert.strictEqual((await A.listMyFeedback()).every((f) => f.userId === id("b1")), true);
    // ---- feedback status updates (migration 17): shipped, the sender's seen marker, mark shipped ----
    const unread = (rows) => Array.from(rows).filter((f) => ["approved", "shipped", "dismissed"].includes(f.status) && (f.seenStatus || null) !== f.status);
    await as("sample.rep.jane@clatitle.com"); let jm = await A.listMyFeedback();
    assert.deepStrictEqual([...new Set(Array.from(jm).map((f) => f.status))].sort(), ["approved", "dismissed", "new", "shipped"]); assert.deepStrictEqual(unread(jm).map((f) => f.id).sort(), ["fb1", "fb4", "fb5"]); ok("feedback status: the demo data has a note in every status; Jane has unread decisions (fb4 approved, fb5 shipped, and fb1 just dismissed above)");
    assert.strictEqual(await A.markMyFeedbackSeen("fb4"), 1); assert.strictEqual(await A.markMyFeedbackSeen("fb4"), 0); assert.deepStrictEqual(unread(await A.listMyFeedback()).map((f) => f.id).sort(), ["fb1", "fb5"]); ok("feedback status: a sender marks one note as seen (once); the others stay unread");
    assert.strictEqual(await A.markMyFeedbackSeen("fb8"), 0); await as("sample.rep.marcus@clatitle.com"); assert.deepStrictEqual(unread(await A.listMyFeedback()).map((f) => f.id), ["fb8"]); ok("feedback status: marking someone else's note changes nothing (Marcus still has his unread)");
    await as("sample.rep.jane@clatitle.com"); assert.ok((await A.markMyFeedbackSeen()) >= 1); assert.strictEqual(unread(await A.listMyFeedback()).length, 0); ok("feedback status: mark all seen clears every unread decision");
    await as("sam.agent@example.com"); await reject(A.markMyFeedbackSeen(), /Not allowed/, "feedback status: a client cannot mark seen"); await reject(A.adminMarkFeedbackShipped("fb4", "x"), /Admins only/, "feedback status: a client cannot mark shipped");
    await as("sample.rep.jane@clatitle.com"); await reject(A.adminMarkFeedbackShipped("fb4", "x"), /Admins only/, "feedback status: a rep cannot mark shipped");
    await as("sample.robin.admin@clatitle.com"); await reject(A.adminMarkFeedbackShipped("fb4", "x"), /Only a super admin/, "feedback status: an Admin cannot mark shipped (same permission as approve)");
    await as("sample.admin@clatitle.com");
    await reject(A.adminMarkFeedbackShipped("fb1", "x"), /Only an approved item/, "feedback status: a new (not approved) item cannot be shipped"); await reject(A.adminMarkFeedbackShipped("nope", "x"), /No such feedback/, "feedback status: an unknown id is refused");
    await reject(A.adminMarkFeedbackShipped("fb4", "n".repeat(501)), /too long/, "feedback status: a 501-character shipped note is refused");
    await A.adminMarkFeedbackShipped("fb4", "  Save as PDF is in the calculator.  "); let f4 = (await A.adminListFeedback()).find((x) => x.id === "fb4");
    assert.deepStrictEqual([f4.status, f4.shippedNote, !!f4.shippedAt, f4.decidedNote, f4.seenStatus], ["shipped", "Save as PDF is in the calculator.", true, "Good one, it is on the list.", null]); ok("feedback status: a super admin marks an approved item shipped with a note (trimmed); the decision note stays; the sender's seen marker resets");
    await reject(A.adminMarkFeedbackShipped("fb4", "again"), /Only an approved item/, "feedback status: a shipped item cannot be shipped twice"); await reject(A.adminSetFeedbackStatus("fb4", "dismissed"), /already shipped/, "feedback status: a shipped item cannot be dismissed or re-approved");
    await A.adminMarkFeedbackShipped("fb3", ""); assert.strictEqual((await A.adminListFeedback()).find((x) => x.id === "fb3").shippedNote, null); ok("feedback status: the shipped note is optional (a blank note is stored as none)");
    await as("sample.rep.jane@clatitle.com"); jm = await A.listMyFeedback(); assert.deepStrictEqual(unread(jm).map((f) => f.id), ["fb4"]); ok("feedback status: the sender sees the shipped item as unread again");
    await as("sample.admin@clatitle.com"); await A.adminSetFeedbackStatus("fb6", "dismissed", "Not now: fees depend on the property, so we want you to pick it each time."); await as("sample.rep.jane@clatitle.com");
    assert.strictEqual(unread(await A.listMyFeedback()).some((f) => f.id === "fb6"), false); await as("sample.admin@clatitle.com"); await A.adminSetFeedbackStatus("fb6", "dismissed", "A changed note"); await as("sample.rep.jane@clatitle.com");
    assert.strictEqual(unread(await A.listMyFeedback()).some((f) => f.id === "fb6"), true); ok("feedback status: the same decision again does not re-flag; a changed note does");
    await as("sample.admin@clatitle.com"); const au2 = await A.adminAuditLog(80); assert.ok(au2.some((x) => x.action === "feedback_shipped") && !JSON.stringify(au2.filter((x) => x.action === "feedback_shipped")).includes("Save as PDF")); ok("feedback status: shipping is audited (feedback_shipped) without the note text");
    // senders never see anyone else's items and the adapter has no way for a sender to change a status
    await as("sample.rep.jane@clatitle.com"); assert.ok((await A.listMyFeedback()).every((f) => f.userId === id("b1"))); assert.strictEqual(typeof A.adminSetFeedbackStatus, "function"); await reject(A.adminSetFeedbackStatus("fb4", "approved"), /Admins only/, "feedback status: a sender cannot change a status");
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
        .replace(/<script src="\.\.\/fee-snapshot\.js[^"]*"><\/script>/, () => "<script>" + fs.readFileSync(path.join(pdir, "..", "fee-snapshot.js"), "utf8") + "</script>")
        .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (m, f) => "<script>" + fs.readFileSync(path.join(pdir, f), "utf8") + "</script>" + (f === "js/portal-ui.js" ? WIDGET + TOURJS : ""));
      const errs = [], dom = new JSDOM(html, { url: "http://localhost/portal/" + file + (qs || "?secret=1") + "#frag", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(win) { win.crypto.randomUUID = require("crypto").randomUUID; win.confirm = () => true; win.addEventListener("error", (e) => errs.push(e.message)); for (const k in store) win.localStorage.setItem(k, store[k]); } });
      for (let i = 0; i < 60 && !dom.window.document.querySelector(waitFor); i++) await tick(20);
      await tick(60); return { dom, d: dom.window.document, win: dom.window, errs };
    };
    const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    // staff see the button; the greeting heads the dialog
    const R = await renderPage("rep.html", "sample.rep.jane@clatitle.com", "#claFeedbackLink"), d = R.d;
    assert.strictEqual(R.errs.length, 0, R.errs.join()); const fab = d.getElementById("claFeedbackLink"); assert.ok(fab && fab.parentNode === d.body && !d.querySelector("header #claFeedbackLink") && fab.classList.contains("claFbFab")); assert.strictEqual(fab.getAttribute("aria-label"), "Send feedback (2 updates on your suggestions)"); assert.strictEqual(fab.getAttribute("aria-expanded"), "false"); ok("feedback widget: a rep sees a floating chat bubble (bottom-right launcher, labelled 'Send feedback', not in the header)");
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
    // ---- feedback status updates: the bubble's dot and the "My suggestions" list ----
    {
      const evil2 = "<img src=x onerror=window.pwned2=1>";
      const RJ = await renderPage("rep.html", "sample.rep.jane@clatitle.com", "#claFeedbackLink", null, (st) => { const f = st.feedback.find((x) => x.id === "fb5"); f.shippedNote = evil2; const g = st.feedback.find((x) => x.id === "fb6"); g.decidedNote = null; });
      await tick(120); let dj = RJ.d, fabj = dj.getElementById("claFeedbackLink"), dotj = dj.getElementById("claFbDot");
      assert.ok(dotj && !dotj.hidden && dotj.textContent === "2" && /2 updates/.test(fabj.getAttribute("aria-label"))); ok("feedback bubble: a dot with the number of unread decisions (2) shows before the panel is opened");
      fabj.click(); await tick(150);
      const li = [...dj.querySelectorAll("#claFbMine li")], txt = (re) => li.find((x) => re.test(x.textContent));
      assert.strictEqual(dj.querySelector("#claFbMine h3").textContent, "My suggestions"); assert.ok(li.length >= 5);
      assert.ok(txt(/Show my email/) && /Shipped/.test(txt(/Show my email/).querySelector(".st").textContent) && /What changed: /.test(txt(/Show my email/).textContent)); assert.ok(txt(/Show my email/).querySelector(".up"));
      assert.ok(/Approved · on the list/.test(txt(/save a quote as a PDF/).querySelector(".st").textContent) && /John: Good one/.test(txt(/save a quote as a PDF/).textContent) && txt(/save a quote as a PDF/).querySelector(".up"));
      assert.ok(/Not planned/.test(txt(/remember my last county/).querySelector(".st").textContent) && !/John:/.test(txt(/remember my last county/).textContent) && !txt(/remember my last county/).querySelector(".up")); ok("feedback bubble: My suggestions shows Received / Approved · on the list / Shipped (with what changed) / Not planned (decision note only when there is one); changed items carry an Updated tag");
      assert.ok(/Received/.test(txt(/Save as new quote button/).querySelector(".st").textContent) && !txt(/Save as new quote button/).querySelector(".up")); const order = li.map((x) => x.textContent); assert.ok(order.findIndex((t) => /Save as new quote button/.test(t)) < order.findIndex((t) => /save a quote as a PDF/.test(t)) && order.findIndex((t) => /save a quote as a PDF/.test(t)) < order.findIndex((t) => /remember my last county/.test(t))); ok("feedback bubble: a new note shows Received, and the list is newest first");
      assert.ok(!dj.querySelector("#claFbMine img") && !RJ.win.pwned2 && txt(/Show my email/).textContent.includes(evil2)); ok("feedback bubble: the shipped note is put on the page as text (markup in it does nothing)");
      await tick(150); assert.ok(dotj.hidden, "dot cleared once the panel was opened"); const stj = JSON.parse(RJ.win.localStorage.getItem("cla_portal_mock_v1")).feedback.filter((x) => x.userId === id("b1")); assert.ok(stj.every((x) => !["approved", "shipped", "dismissed"].includes(x.status) || x.seenStatus === x.status)); assert.deepStrictEqual(stj.map((x) => x.status).sort(), ["approved", "dismissed", "new", "shipped", "shipped"]); ok("feedback bubble: opening the panel marks the decisions as seen (dot gone), and no status was changed");
      RJ.dom.window.close();
      const RJ2 = await renderPage("rep.html", "sample.rep.jane@clatitle.com", "#claFeedbackLink", null, (st) => { st.feedback.forEach((x) => { if (x.seenStatus !== undefined && x.userId === id("b1")) x.seenStatus = ["approved", "shipped", "dismissed"].includes(x.status) ? x.status : null; }); }); await tick(120);
      assert.ok(RJ2.d.getElementById("claFbDot").hidden && RJ2.d.getElementById("claFeedbackLink").getAttribute("aria-label") === "Send feedback"); RJ2.d.getElementById("claFeedbackLink").click(); await tick(120); assert.ok(!RJ2.d.querySelector("#claFbMine .up")); ok("feedback bubble: nothing unread means no dot and no Updated tags"); RJ2.dom.window.close();
      const RM = await renderPage("rep.html", "sample.rep.marcus@clatitle.com", "#claFeedbackLink"); await tick(120); assert.strictEqual(RM.d.getElementById("claFbDot").textContent, "1"); RM.d.getElementById("claFeedbackLink").click(); await tick(150);
      assert.ok(/Where do I change my cell/.test(RM.d.getElementById("claFbMine").textContent) && !/Show my email|county/.test(RM.d.getElementById("claFbMine").textContent) && /Cell column/.test(RM.d.getElementById("claFbMine").textContent)); ok("feedback bubble: each sender sees only their own suggestions (Marcus sees his shipped note, not Jane's)"); RM.dom.window.close();
    }
    const RA = await renderPage("admin.html", "sample.robin.admin@clatitle.com", "#users tr", async (A0) => { await A0.submitFeedback({ category: "bug", message: evil, page: "/portal/admin.html" }); });
    assert.ok(RA.d.getElementById("claFeedbackLink")); const tabs = [...RA.d.querySelectorAll("#tabs button")]; assert.strictEqual(tabs[4].textContent, "Feedback"); tabs[4].click(); await tick(80);
    assert.ok(!RA.d.getElementById("pFeedback").hidden); assert.ok(RA.d.querySelectorAll("#fbRows tr").length >= 4); assert.strictEqual(RA.d.querySelectorAll("#fbRows [data-fb]").length, 0); assert.match(RA.d.getElementById("fNote").textContent, /Read only/); ok("feedback panel: an Admin lists everything but has no approve/dismiss buttons");
    assert.ok(!RA.d.querySelector("#fbRows img") && RA.d.getElementById("fbRows").textContent.includes(evil)); assert.strictEqual(RA.errs.length, 0, RA.errs.join()); ok("feedback panel: messages are escaped");
    RA.d.getElementById("fStatus").value = "approved"; fire(RA.win, RA.d.getElementById("fStatus"), "change"); assert.strictEqual(RA.d.querySelectorAll("#fbRows tr").length, 2); assert.match(RA.d.getElementById("fbRows").textContent, /Where do I change my cell/); RA.d.getElementById("fStatus").value = "";
    RA.d.getElementById("fCat").value = "idea"; fire(RA.win, RA.d.getElementById("fCat"), "change"); assert.ok([...RA.d.querySelectorAll("#fbRows tr")].every((tr) => /Idea/.test(tr.children[2].textContent))); RA.d.getElementById("fCat").value = "";
    RA.d.getElementById("fFilter").value = "dark"; fire(RA.win, RA.d.getElementById("fFilter"), "input"); assert.match(RA.d.getElementById("fbRows").textContent, /No feedback matches/); ok("feedback panel: filters by status, category and text"); RA.dom.window.close();
    const RS = await renderPage("admin.html", "sample.admin@clatitle.com", "#users tr"); [...RS.d.querySelectorAll("#tabs button")][4].click(); await tick(80);
    assert.match(RS.d.getElementById("fNote").textContent, /approve or dismiss/); const btn = RS.d.querySelector('#fbRows button[data-fb="fb1"][data-to="approved"]'); assert.ok(btn && RS.d.querySelector('#fbRows button[data-fb="fb1"][data-to="dismissed"]'));
    RS.d.querySelector('#fbRows input[data-note="fb1"]').value = "Thanks, fixed"; btn.click(); await tick(80);
    const st = JSON.parse(RS.win.localStorage.getItem("cla_portal_mock_v1")).feedback.find((f) => f.id === "fb1"); assert.deepStrictEqual([st.status, st.decidedNote], ["approved", "Thanks, fixed"]); assert.match(RS.d.querySelector('#fbRows input[data-note="fb1"]').closest("tr").textContent, /Approved/); ok("feedback panel: a super admin approves with a note");
    assert.strictEqual(RS.errs.length, 0, RS.errs.join()); RS.dom.window.close();
    // ---- feedback status updates: "Mark shipped" in the admin Feedback tab ----
    {
      const RP = await renderPage("admin.html", "sample.admin@clatitle.com", "#users tr"); [...RP.d.querySelectorAll("#tabs button")][4].click(); await tick(80);
      assert.ok([...RP.d.querySelectorAll("#fStatus option")].some((o) => o.value === "shipped")); const row4 = (id4) => RP.d.querySelector('#fbRows [data-fb="' + id4 + '"]');
      assert.ok(row4("fb4") && RP.d.querySelector('#fbRows button[data-fb="fb4"][data-to="shipped"]') && RP.d.querySelector('#fbRows input[data-ship-note="fb4"]')); assert.ok(!RP.d.querySelector('#fbRows button[data-fb="fb1"][data-to="shipped"]') && !RP.d.querySelector('#fbRows button[data-fb="fb5"][data-to="shipped"]')); ok("feedback panel: an approved item gets a What changed field and a Mark shipped button; new and already-shipped items do not");
      RP.d.querySelector('#fbRows input[data-ship-note="fb4"]').value = "Save as PDF is on the calculator."; RP.d.querySelector('#fbRows button[data-fb="fb4"][data-to="shipped"]').click(); await tick(120);
      const st4 = JSON.parse(RP.win.localStorage.getItem("cla_portal_mock_v1")).feedback.find((f) => f.id === "fb4"); assert.deepStrictEqual([st4.status, st4.shippedNote, !!st4.shippedAt, st4.seenStatus], ["shipped", "Save as PDF is on the calculator.", true, null]);
      const tr4 = [...RP.d.querySelectorAll("#fbRows tr")].find((t) => /save a quote as a PDF/.test(t.textContent)); assert.ok(/Shipped/.test(tr4.textContent) && /Save as PDF is on the calculator/.test(tr4.textContent) && !tr4.querySelector("button")); ok("feedback panel: Mark shipped saves the note, shows Shipped with the note and drops the buttons");
      RP.d.getElementById("fStatus").value = "shipped"; fire(RP.win, RP.d.getElementById("fStatus"), "change"); assert.ok(RP.d.querySelectorAll("#fbRows tr").length >= 3); assert.strictEqual(RP.errs.length, 0, RP.errs.join()); RP.dom.window.close();
      const RR = await renderPage("admin.html", "sample.robin.admin@clatitle.com", "#users tr"); [...RR.d.querySelectorAll("#tabs button")][4].click(); await tick(80);
      assert.strictEqual(RR.d.querySelectorAll("#fbRows [data-fb]").length, 0); assert.match(RR.d.getElementById("fbRows").textContent, /Shipped/); assert.match(RR.d.getElementById("fNote").textContent, /Read only/); ok("feedback panel: an Admin (not super) sees shipped items and notes read-only, with no buttons"); RR.dom.window.close();
    }


    // ================= delete a disabled user (migration 18) + the Users-tab filters =================
    {
      const wx = boot(), Ax = wx.CLA.createMockAdapter({}), as = async (email) => { wx.localStorage.removeItem("cla_portal_mock_session"); await Ax.signIn(email, "x"); };
      const ids = (k) => "00000000-0000-4000-8000-0000000000" + k, rej = async (p, re, name) => { try { await p; assert.fail("should have thrown: " + name); } catch (e) { assert.ok(re.test(e.message), name + " (" + e.message + ")"); } };
      const ROBIN = "sample.robin.admin@clatitle.com", ALEX = "sample.admin@clatitle.com";
      await as(ROBIN);
      await rej(Ax.adminDeleteUser(ids("c1"), "sam.agent@example.com"), /disable this person first/i, "delete: an active person is refused");
      await rej(Ax.adminDeleteUser(ids("a2"), ROBIN), /yourself|your own/i, "delete: not yourself");
      await rej(Ax.adminDeleteUser(ids("a1"), ALEX), /super admin/i, "delete: an admin cannot delete a super admin");
      await rej(Ax.adminDeleteUser(ids("c4"), "wrong@example.com"), /email you typed/i, "delete: the typed email must match");
      assert.ok((await Ax.adminListUsers()).some((u) => u.id === ids("c4"))); ok("delete (mock): refusals change nothing");
      const r1 = await Ax.adminDeleteUser(ids("c4"), "  Dee.Disabled@Example.com ");
      assert.strictEqual(r1.email, "dee.disabled@example.com"); assert.strictEqual(r1.role, "client");
      assert.ok(!(await Ax.adminListUsers()).some((u) => u.id === ids("c4"))); assert.ok(!(await Ax.adminListAssignments()).some((a) => a.clientEmail === "dee.disabled@example.com")); ok("delete (mock): an admin deletes a disabled client (typed email, any case) and the realtor link goes");
      const au = (await Ax.adminAuditLog(50)).find((a) => a.action === "user_deleted");
      assert.ok(au && au.details.email === "dee.disabled@example.com" && au.details.role === "client" && au.details.deleted_by_email === ROBIN); ok("delete (mock): the audit log keeps email, role, who deleted them");
      await Ax.adminInvite({ email: "dee.disabled@example.com", role: "client", firstName: "Dee" }); ok("delete (mock): the same email can be invited again");
      // a rep with active clients: disable first, choose a successor
      const q0 = (await Ax.adminListQuotes()).find((q) => q.repId === ids("b2") && q.ownerId !== ids("b2"));
      await Ax.adminSetStatus(ids("b2"), "disabled");
      await rej(Ax.adminDeleteUser(ids("b2"), "sample.rep.marcus@clatitle.com"), /still has|reassign|another rep|successor/i, "delete: a rep with active clients needs a successor");
      const r2 = await Ax.adminDeleteUser(ids("b2"), "sample.rep.marcus@clatitle.com", ids("b1"));
      assert.ok(r2.clients_moved >= 2); const cl = (await Ax.adminListAssignments()).filter((a) => a.repId === ids("b1")).map((a) => a.clientEmail);
      assert.ok(cl.includes("omar.broker@example.com") && cl.includes("nina.newagent@example.com")); ok("delete (mock): a rep's clients move to the chosen rep");
      if (q0) assert.strictEqual((await Ax.adminListQuotes()).find((q) => q.id === q0.id).repId, null), ok("delete (mock): quotes the rep handled for others stay, with the rep name removed");
      assert.ok((await Ax.adminListFeedback()).filter((f) => f.id === "fb3").every((f) => f.userId === null)); ok("delete (mock): feedback is kept, without a name");
      // admin may delete another (disabled) admin; never a super admin
      await Ax.adminSetStatus(ids("a3"), "disabled"); await Ax.adminDeleteUser(ids("a3"), "sample.casey.admin@clatitle.com"); ok("delete (mock): an admin can delete another disabled admin (same reach as disable)");
      await as("sample.rep.jane@clatitle.com"); await rej(Ax.adminDeleteUser(ids("c3"), "pat.homes@example.com"), /admin/i, "delete: a rep cannot");
      await as(ALEX); await Ax.adminSetStatus(ids("a2"), "disabled"); await Ax.adminDeleteUser(ids("a2"), ROBIN); ok("delete (mock): a super admin can delete a disabled admin");
      // supabase adapter -> the Edge Function
      const sc = []; const S2 = await wx.CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: ids("a1") } } } }) },
        functions: { invoke: async (n, o) => { sc.push([n, o]); return { data: { ok: true, summary: { email: "x@y.com", clients_moved: 1 } }, error: null }; } } }) });
      const sr = await S2.adminDeleteUser("u1", "x@y.com", "r1"); assert.strictEqual(sc[0][0], "delete-user"); assert.deepStrictEqual(JSON.parse(JSON.stringify(sc[0][1].body)), { userId: "u1", confirmEmail: "x@y.com", reassignTo: "r1" }); assert.strictEqual(sr.clients_moved, 1); ok("delete (supabase): goes through the delete-user Edge Function with the typed email");
      // admin screen: the Delete button + confirm dialog, and the filters
      const RA = await renderPage("admin.html", ROBIN, "#users tr"), da = RA.d, rows = () => [...da.querySelectorAll("#users tr")], txt = (t) => t.textContent;
      assert.strictEqual(RA.errs.length, 0, RA.errs.join());
      const total = rows().length; assert.ok(total >= 10); assert.strictEqual(da.getElementById("uShown").textContent, "");
      const delBtns = [...da.querySelectorAll("#users [data-del]")]; assert.strictEqual(delBtns.length, 1); assert.ok(/Dee/.test(txt(delBtns[0].closest("tr")))); ok("users tab: the Delete button is only on the disabled person");
      const roleSel = da.getElementById("uRole"), stSel = da.getElementById("uStatus"), search = da.getElementById("uSearch"), setv = (el, v) => { el.value = v; fire(RA.win, el, "input"); fire(RA.win, el, "change"); };
      setv(roleSel, "super_admin"); assert.strictEqual(rows().length, 1); assert.ok(/Alex/.test(txt(rows()[0]))); assert.match(da.getElementById("uShown").textContent, /Showing 1 of \d+/);
      setv(roleSel, "admin"); assert.ok(rows().length >= 2 && rows().every((t) => /Admin/.test(txt(t)))); assert.ok(da.getElementById("uNote").hidden);
      setv(roleSel, "rep"); const repRows = rows().map(txt).join("|"); assert.ok(/Jane/.test(repRows) && /Marcus/.test(repRows) && /Alex/.test(repRows) && !/Sam/.test(repRows)); assert.ok(!da.getElementById("uNote").hidden); ok("users tab: role filter; Rep includes the admin who also works as a rep, with a note");
      setv(roleSel, "client"); assert.ok(rows().every((t) => !/Jane|Alex/.test(txt(t.querySelector("td"))))); assert.ok(rows().length >= 5);
      setv(roleSel, ""); setv(stSel, "disabled"); assert.strictEqual(rows().length, 1); assert.ok(/Dee/.test(txt(rows()[0])) && !!rows()[0].querySelector("[data-del]"));
      setv(stSel, "never"); assert.ok(rows().length >= 2 && rows().every((t) => /never signed in/i.test(txt(t)))); setv(stSel, "active"); assert.ok(rows().length >= 8 && !rows().some((t) => /Dee/.test(txt(t))));
      setv(stSel, ""); setv(roleSel, "client"); setv(search, "bright"); assert.strictEqual(rows().length, 1); assert.ok(/Quinn/.test(txt(rows()[0]))); ok("users tab: status filter, and the search works together with the role filter");
      setv(search, "zzzz"); assert.match(txt(da.getElementById("users")), /No users match/); assert.ok(!da.getElementById("uClear").hidden);
      da.getElementById("uClear").click(); assert.strictEqual(rows().length, total); assert.ok(da.getElementById("uClear").hidden); assert.strictEqual(roleSel.value, ""); ok("users tab: Clear filters restores the full list");
      da.querySelector("#users [data-del]").click(); await tick(60);
      const dlg = da.getElementById("delDlg"); assert.ok(dlg && /Delete Dee Disabled/.test(dlg.textContent) && /dee\.disabled@example\.com/.test(dlg.textContent) && /audit log/.test(dlg.textContent) && /invited again/.test(dlg.textContent));
      const okb = da.getElementById("delOk"), inp = da.getElementById("delConfirm"); assert.ok(okb.disabled); inp.value = "dee.disabled@exampl"; fire(RA.win, inp, "input"); assert.ok(okb.disabled); inp.value = "DEE.disabled@example.com"; fire(RA.win, inp, "input"); assert.ok(!okb.disabled); ok("users tab: the delete dialog needs the exact email typed before the button works");
      okb.click(); await tick(120); assert.ok(!da.getElementById("delDlg")); assert.ok(!rows().some((t) => /Dee/.test(txt(t)))); assert.strictEqual(RA.errs.length, 0, RA.errs.join()); ok("users tab: confirming deletes the person and refreshes the list");
      // a disabled rep with clients: the dialog asks for a successor
      const RB = await renderPage("admin.html", ALEX, "#users tr", async (A) => { await A.adminSetStatus(ids("b1"), "disabled"); }), db = RB.d;
      db.querySelector("#users [data-del]").click(); await tick(60); assert.ok(db.getElementById("delRep") && /realtor/.test(db.getElementById("delDlg").textContent)); const opts = [...db.getElementById("delRep").options].map((o) => o.textContent); assert.ok(opts.some((t) => /Marcus/.test(t)) && !opts.some((t) => /Jane/.test(t))); ok("users tab: deleting a rep with clients asks which rep takes them over");
      db.getElementById("delNo").click(); assert.ok(!db.getElementById("delDlg")); assert.ok(RB.errs.length === 0);
      // an admin sees a disabled super admin's Delete button greyed out
      const RC = await renderPage("admin.html", ROBIN, "#users tr", async (A) => { await A.adminSetStatus(ids("a1"), "disabled"); }).catch(() => null);
      if (RC) { const b = [...RC.d.querySelectorAll("#users [data-del]")].find((x) => /Alex/.test(txt(x.closest("tr")))); assert.ok(!b || b.disabled); ok("users tab: an admin cannot use Delete on a super admin"); }
    }

    // ================= named PRICING TABLES for the settlement fee (migration 16) =================
    {
      const mock = () => { const wx = boot(), Ax = wx.CLA.createMockAdapter({}); return { wx, Ax, as: async (email) => { wx.localStorage.removeItem("cla_portal_mock_session"); await Ax.signIn(email, "x"); } }; };
      const M = mock(), ids = (k) => "00000000-0000-4000-8000-0000000000" + k, rej = async (p, re, name) => { try { await p; assert.fail("should have thrown: " + name); } catch (e) { assert.ok(re.test(e.message), name + " -> " + e.message); ok(name); } };
      const sum = (r) => r.filter((o) => o.amount !== null).map((o) => o.state + "/" + o.transaction + "/" + o.paidBy + "/" + o.amount).join(",");
      const J2 = JSON.stringify, mine = async (e) => { await M.as(e); return sum((await M.Ax.getMyFeeOverrides()).sort((a, b) => (a.state + a.transaction + a.paidBy).localeCompare(b.state + b.transaction + b.paidBy))); };
      const JANE = "FL/purchase/buyer/1000,FL/purchase/seller/800,MD/purchase/buyer/900,MD/purchase/seller/500,VA/purchase/buyer/900,VA/purchase/seller/500", MARV = "*/purchase/buyer/950,*/purchase/seller/600,*/refi/buyer/350", FEE = (tableId, state, transaction, paidBy, amount) => ({ tableId, state, transaction, paidBy, amount });
      // starter data: two fake tables
      await M.as("sample.robin.admin@clatitle.com"); let L = await M.Ax.adminListPricingTables();
      assert.strictEqual(JSON.stringify(L.tables.map((t) => t.name)), JSON.stringify(["Marvin's Pricing", "Jane's Pricing"])); assert.strictEqual(L.fees.length, 9); assert.strictEqual(new Set(L.fees.filter((f) => f.tableId === "pt2").map((f) => f.setId)).size, 2); assert.strictEqual(L.members.length, 4);
      assert.ok(L.members.every((m) => m.email === m.email.toLowerCase()) && L.members.some((m) => m.email === "omar.broker@example.com") && !JSON.stringify(L).includes("feeKey"));
      ok("pricing tables (mock): fake starter data: Marvin's Pricing (one all-states set; Marcus + an email with no account) and Jane's Pricing (an MD+VA set and a separate FL set; Jane and Omar)");
      // who sees what: the rep in a table, the rep's clients, nobody else
      assert.strictEqual(await mine("sample.rep.jane@clatitle.com"), JANE); assert.strictEqual(await mine("sam.agent@example.com"), JANE); assert.strictEqual(await mine("lee.lender@example.com"), JANE);
      assert.strictEqual(await mine("sample.rep.marcus@clatitle.com"), MARV); assert.strictEqual(await mine("omar.broker@example.com"), JANE);
      ok("pricing tables (mock): a rep gets their table's fees, and their assigned clients (Sam, Lee) follow the rep; Omar (Marcus's client) is listed in Jane's Pricing himself, so his own email wins: Jane's fees");
      for (const e of ["pat.homes@example.com", "quinn.buyer@example.com", "sample.admin@clatitle.com", "sample.robin.admin@clatitle.com", "sample.new.rep@clatitle.com"]) assert.strictEqual(await mine(e), "", e);
      ok("pricing tables (mock): an unassigned client, the admin's client, the admin who reps, a plain admin and a rep in no table all pay standard fees");
      // writes: admins and super admins only
      for (const [who, label] of [["sample.rep.jane@clatitle.com", "a rep"], ["sam.agent@example.com", "a client"]]) {
        await M.as(who);
        for (const [n, p] of [["create", () => M.Ax.adminCreatePricingTable("X")], ["rename", () => M.Ax.adminRenamePricingTable("pt1", "X")], ["delete", () => M.Ax.adminDeletePricingTable("pt1")], ["save a fee set", () => M.Ax.adminSavePricingFeeSet({ tableId: "pt1", states: ["*"], purchaseBuyer: 1 })],
          ["remove a fee set", () => M.Ax.adminRemovePricingFeeSet("pt1", "ps1")], ["add a member", () => M.Ax.adminAddPricingMember("pt1", "x@clatitle.com")], ["remove a member", () => M.Ax.adminRemovePricingMember("pt1", "sample.rep.marcus@clatitle.com")], ["list", () => M.Ax.adminListPricingTables()]])
          await rej(p(), /Admins only/, "pricing tables: " + label + " cannot " + n);
      }
      // create / rename / delete (Robin = Admin, Alex = Super admin)
      await M.as("sample.robin.admin@clatitle.com"); const T = await M.Ax.adminCreatePricingTable("  Priya's    Pricing "); assert.ok(T.id);
      assert.strictEqual((await M.Ax.adminListPricingTables()).tables.find((t) => t.id === T.id).name, "Priya's Pricing"); ok("pricing tables (mock): an Admin creates a table; the name is tidied (trimmed, single spaces)");
      await rej(M.Ax.adminCreatePricingTable("PRIYA'S pricing"), /already exists/, "pricing tables: a name used twice (ignoring case) is refused"); await rej(M.Ax.adminCreatePricingTable("   "), /needs a name/, "pricing tables: an empty name is refused"); await rej(M.Ax.adminCreatePricingTable("x".repeat(81)), /too long/, "pricing tables: a name over 80 characters is refused");
      await M.as("sample.admin@clatitle.com"); await M.Ax.adminRenamePricingTable(T.id, "Priya Pricing"); await rej(M.Ax.adminRenamePricingTable(T.id, "marvin's pricing"), /already exists/, "pricing tables: renaming to another table's name is refused"); await rej(M.Ax.adminRenamePricingTable("nope", "Z"), /No such pricing table/, "pricing tables: an unknown table is refused");
      assert.strictEqual((await M.Ax.adminListPricingTables()).tables.find((t) => t.id === T.id).name, "Priya Pricing"); ok("pricing tables (mock): a Super admin renames");
      // fee sets: normalised, validated, settlement only
      const SAVE = (o) => M.Ax.adminSavePricingFeeSet(o);
      const S1 = await SAVE({ tableId: T.id, states: ["md"], purchaseBuyer: "$900", purchaseSeller: 500 }), S2 = await SAVE({ tableId: T.id, states: ["*"], refiBorrower: 0 });
      assert.ok(S1.id && S2.id && S1.id !== S2.id); L = await M.Ax.adminListPricingTables(); let mf = L.fees.filter((f) => f.tableId === T.id);
      assert.strictEqual(mf.length, 3); assert.strictEqual(new Set(mf.map((f) => f.setId)).size, 2); assert.ok(mf.every((f) => typeof f.amount === "number"));
      ok("pricing tables (mock): a fee set is saved with normalised input ('md', '$900', 0 allowed, empty boxes skipped): two sets, three fee rows");
      assert.strictEqual((await SAVE({ tableId: T.id, setId: S1.id, states: ["MD"], purchaseBuyer: 912.505, purchaseSeller: 500 })).id, S1.id); L = await M.Ax.adminListPricingTables(); assert.strictEqual(L.fees.find((f) => f.tableId === T.id && f.state === "MD" && f.paidBy === "buyer").amount, 912.51); assert.strictEqual(L.fees.filter((f) => f.tableId === T.id).length, 3);
      ok("pricing tables (mock): editing a set (its id) replaces it in place, rounded to the cent"); await SAVE({ tableId: T.id, setId: S1.id, states: ["MD"], purchaseBuyer: 900, purchaseSeller: 500 });
      const base = { tableId: T.id, states: ["MD"], purchaseBuyer: 1 };
      for (const [o, re, n] of [[{ states: ["TX"] }, /States must be/, "unknown state"], [{ states: ["*", "MD"] }, /cannot be combined/, "all states mixed with a state"], [{ states: [] }, /at least one state/, "no state"], [{ states: undefined }, /at least one state/, "states missing"],
        [{ purchaseBuyer: null }, /at least one fee/, "no fee at all"], [{ purchaseBuyer: -1 }, /Amount/, "negative amount"], [{ purchaseBuyer: 100000 }, /Amount/, "too large"], [{ purchaseBuyer: "abc" }, /Amount/, "text amount"], [{ states: ["FL"], setId: "nope" }, /No such fee set/, "unknown set"], [{ tableId: "nope" }, /No such pricing table/, "unknown table"]])
        await rej(SAVE(Object.assign({}, base, o)), re, "pricing tables: fee set refused: " + n);
      await rej(SAVE({ tableId: "pt1", setId: S1.id, states: ["FL"], purchaseBuyer: 1 }), /No such fee set/, "pricing tables: a set id of another table is refused");
      await SAVE({ tableId: T.id, states: ["VA"], purchaseBuyer: 700, feeKey: "premium", name: "Owner's Title Policy", transaction: "recording" }); assert.ok((await M.Ax.adminListPricingTables()).fees.every((f) => !("feeKey" in f) && !("name" in f) && ["purchase", "refi"].includes(f.transaction)));
      ok("pricing tables (mock): there is no way to say WHICH fee: extra properties are ignored, only the settlement fee exists");
      const S3 = (await M.Ax.adminListPricingTables()).fees.find((f) => f.state === "VA" && f.tableId === T.id).setId; await M.Ax.adminRemovePricingFeeSet(T.id, S3); await M.Ax.adminRemovePricingFeeSet(T.id, S3); assert.strictEqual((await M.Ax.adminListPricingTables()).fees.filter((f) => f.tableId === T.id).length, 3); ok("pricing tables (mock): removing a fee set (twice) puts its states back to standard, quietly");
      // members: by email, one table only
      assert.strictEqual(await M.Ax.adminAddPricingMember(T.id, "  SAMPLE.New.Rep@ClaTitle.com "), "added"); assert.strictEqual(await M.Ax.adminAddPricingMember(T.id, "sample.new.rep@clatitle.com"), "already");
      L = await M.Ax.adminListPricingTables(); assert.strictEqual(JSON.stringify(L.members.filter((m) => m.tableId === T.id).map((m) => m.email)), JSON.stringify(["sample.new.rep@clatitle.com"])); ok("pricing tables (mock): an email is stored lower-case and trimmed; adding it again says 'already'");
      assert.strictEqual(await mine("sample.new.rep@clatitle.com"), "*/refi/buyer/0,MD/purchase/buyer/900,MD/purchase/seller/500"); ok("pricing tables (mock): the email matches the rep's account in any letter case: Riley now gets the table's fees");
      await M.as("sample.admin@clatitle.com");
      assert.strictEqual(await M.Ax.adminAddPricingMember(T.id, "Not.Yet.Hired@clatitle.com"), "added"); ok("pricing tables (mock): an email with no portal account yet can be added ahead of time");
      await rej(M.Ax.adminAddPricingMember(T.id, "sample.rep.marcus@clatitle.com"), /sample\.rep\.marcus@clatitle\.com is already in pricing table "Marvin's Pricing"/, "pricing tables: an email in another table is refused and the message names that table");
      assert.strictEqual(await mine("sample.rep.marcus@clatitle.com"), MARV);
      await M.as("sample.admin@clatitle.com"); assert.strictEqual(await M.Ax.adminAddPricingMember(T.id, "SAMPLE.REP.MARCUS@clatitle.com", { move: true }), "moved");
      L = await M.Ax.adminListPricingTables(); assert.strictEqual(L.members.filter((m) => m.email === "sample.rep.marcus@clatitle.com").length, 1); assert.strictEqual(L.members.find((m) => m.email === "sample.rep.marcus@clatitle.com").tableId, T.id);
      assert.strictEqual(await mine("sample.rep.marcus@clatitle.com"), "*/refi/buyer/0,MD/purchase/buyer/900,MD/purchase/seller/500"); assert.strictEqual(await mine("omar.broker@example.com"), JANE); await M.as("sample.admin@clatitle.com"); ok("pricing tables (mock): moving an email takes it out of the other table (still only one table); Marcus now gets this table's fees, while Omar (listed himself in Jane's Pricing) keeps Jane's");
      await M.as("sample.admin@clatitle.com");
      for (const [e, re, n] of [["", /valid email/, "empty"], ["not an email", /valid email/, "no @"], ["a@b", /valid email/, "no domain dot"], ["x@localhost", /valid email/, "no domain dot"]]) await rej(M.Ax.adminAddPricingMember(T.id, e), re, "pricing tables: member email refused: " + n);
      await M.Ax.adminRemovePricingMember(T.id, "NOT.YET.HIRED@clatitle.com"); await M.Ax.adminRemovePricingMember(T.id, "not.yet.hired@clatitle.com"); assert.ok(!(await M.Ax.adminListPricingTables()).members.some((m) => m.email === "not.yet.hired@clatitle.com")); ok("pricing tables (mock): removing a member (any case, twice) works and is quiet");
      // admin who reps vs plain admin; reassigning a client; delete releases members
      assert.strictEqual(await M.Ax.adminAddPricingMember("pt2", "sample.admin@clatitle.com"), "added"); assert.strictEqual(await M.Ax.adminAddPricingMember("pt2", "sample.robin.admin@clatitle.com"), "added");
      assert.strictEqual(await mine("sample.admin@clatitle.com"), JANE); assert.strictEqual(await mine("quinn.buyer@example.com"), JANE); assert.strictEqual(await mine("sample.robin.admin@clatitle.com"), ""); await M.as("sample.admin@clatitle.com"); ok("pricing tables (mock): an admin who also reps gets the table (and their clients); an admin who does not rep gets nothing");
      await M.as("sample.admin@clatitle.com"); await M.Ax.adminReassign("sam.agent@example.com", ids("b2")); assert.strictEqual(await mine("sam.agent@example.com"), "*/refi/buyer/0,MD/purchase/buyer/900,MD/purchase/seller/500"); await M.as("sample.admin@clatitle.com"); await M.Ax.adminReassign("sam.agent@example.com", ids("b1")); assert.strictEqual(await mine("sam.agent@example.com"), JANE);
      ok("pricing tables (mock): moving a client to another rep moves them to that rep's table");
      await M.as("sample.admin@clatitle.com"); await M.Ax.adminDeletePricingTable("pt2"); L = await M.Ax.adminListPricingTables();
      assert.strictEqual(L.tables.length, 2); assert.strictEqual(L.fees.filter((f) => f.tableId === "pt2").length + L.members.filter((m) => m.tableId === "pt2").length, 0); assert.strictEqual(await mine("sample.rep.jane@clatitle.com"), ""); assert.strictEqual(await mine("lee.lender@example.com"), "");
      ok("pricing tables (mock): deleting a table removes its fees and members: Jane and her clients are back on standard fees");
      // audit
      await M.as("sample.admin@clatitle.com"); const au = (await M.Ax.adminAuditLog(200)).filter((r) => r.action === "pricing_table_changed"), ops = {}; au.forEach((r) => (ops[r.details.op] = (ops[r.details.op] || 0) + 1));
      assert.ok(["create", "rename", "delete", "fee_set_add", "fee_set_edit", "fee_set_remove", "member_add", "member_move", "member_remove"].every((o) => ops[o] > 0), JSON.stringify(ops)); assert.ok(au.some((r) => r.details.op === "delete" && r.details.fees_removed === 2 && r.details.members_released === 4) && au.some((r) => r.details.op === "member_move" && r.details.from_table === "Marvin's Pricing") && au.some((r) => r.details.op === "fee_set_edit" && r.details.before.purchase_buyer === 912.51 && r.details.after.purchase_buyer === 900 && J2(r.details.after.states) === '["MD"]'));
      ok("pricing tables (mock): every create / rename / delete / fee / member change is audited (pricing_table_changed with op, before and after)");
      // supabase adapter: the right tables / functions, mapped
      const calls = [], rowsFor = { pricing_tables: [{ id: "t1", name: "Marvin's Pricing", created_by: ids("a1"), created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" }],
        pricing_table_fees: [{ id: "f1", table_id: "t1", set_id: "s1", state: "MD", transaction: "purchase", paid_by: "buyer", amount: "900.00", updated_at: "2026-10-27T00:00:00Z", updated_by: ids("a1") }], pricing_table_members: [{ id: "m1", table_id: "t1", email: "sample.rep.marcus@clatitle.com", added_by: ids("a1"), added_at: "2026-10-27T00:00:00Z" }] };
      const fakeSb = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: ids("a1"), email: "a@clatitle.com" } } } }) },
        from: (t) => { calls.push(["from", t]); return { select: () => { const r = Promise.resolve({ data: rowsFor[t], error: null }); r.order = () => Promise.resolve({ data: rowsFor[t], error: null }); return r; } }; },
        rpc: async (n, a) => { calls.push(["rpc", n, a]); return { data: n === "get_my_fee_overrides" ? [{ state: "*", transaction: "refi", paid_by: "buyer", amount: 300 }, { state: "MD", transaction: "refi", paid_by: "buyer", amount: null }] : n === "admin_add_pricing_member" ? "added" : n === "admin_create_pricing_table" ? "t9" : null, error: null }; } }) };
      const SA = CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, fakeSb), J = JSON.stringify;
      assert.strictEqual(J((await SA.getMyFeeOverrides()).map((o) => [o.state, o.transaction, o.paidBy, o.amount])), J([["*", "refi", "buyer", 300], ["MD", "refi", "buyer", null]]));
      const sl = await SA.adminListPricingTables(); assert.strictEqual(J([sl.tables[0].name, sl.fees[0].tableId, sl.fees[0].setId, sl.fees[0].paidBy, sl.fees[0].amount, sl.members[0].tableId, sl.members[0].email]), J(["Marvin's Pricing", "t1", "s1", "buyer", 900, "t1", "sample.rep.marcus@clatitle.com"]));
      assert.deepStrictEqual(["pricing_tables", "pricing_table_fees", "pricing_table_members"].filter((t) => calls.some((c) => c[0] === "from" && c[1] === t)).length, 3);
      assert.strictEqual(J(await SA.adminCreatePricingTable("Z")), J({ id: "t9" })); await SA.adminRenamePricingTable("t1", "Y"); await SA.adminDeletePricingTable("t1");
      await SA.adminSavePricingFeeSet({ tableId: "t1", setId: null, states: ["MD", "VA"], purchaseBuyer: 880, purchaseSeller: "$500.50", refiBorrower: "", move: true }); await SA.adminRemovePricingFeeSet("t1", "s1");
      assert.strictEqual(await SA.adminAddPricingMember("t1", "a@clatitle.com"), "added"); await SA.adminAddPricingMember("t1", "a@clatitle.com", { move: true }); await SA.adminRemovePricingMember("t1", "a@clatitle.com");
      const rc = calls.filter((c) => c[0] === "rpc").map((c) => [c[1], J(c[2])]);
      assert.deepStrictEqual(rc, [["get_my_fee_overrides", undefined], ["admin_create_pricing_table", J({ p_name: "Z" })], ["admin_rename_pricing_table", J({ p_table: "t1", p_name: "Y" })], ["admin_delete_pricing_table", J({ p_table: "t1" })],
        ["admin_save_pricing_fee_set", J({ p_table: "t1", p_set: null, p_states: ["MD", "VA"], p_purchase_buyer: 880, p_purchase_seller: 500.5, p_refi_borrower: null, p_move: true })], ["admin_remove_pricing_fee_set", J({ p_table: "t1", p_set: "s1" })],
        ["admin_add_pricing_member", J({ p_table: "t1", p_email: "a@clatitle.com", p_move: false })], ["admin_add_pricing_member", J({ p_table: "t1", p_email: "a@clatitle.com", p_move: true })], ["admin_remove_pricing_member", J({ p_table: "t1", p_email: "a@clatitle.com" })]]);
      ok("supabase adapter: reads the three pricing tables and get_my_fee_overrides, writes only through the admin_*_pricing_* RPCs (names and arguments checked); rows mapped");
      // integration with the calculator: Jane's client Lee, Marcus's client Omar and Pat in the real page
      {
        const root = path.join(__dirname, ".."), idx = fs.readFileSync(path.join(root, "index.html"), "utf8"), M2 = mock();
        const page = idx.replace(/<script src="https[^>]+><\/script>/, "").replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script src="zip-county.js[^"]*"><\/script>/, "<script>" + fs.readFileSync(path.join(root, "zip-county.js"), "utf8") + "</script>")
          .replace(/<script src="fee-snapshot.js[^"]*"><\/script>/, "<script>" + fs.readFileSync(path.join(root, "fee-snapshot.js"), "utf8") + "</script>").replace(/<script src="portal\/js\/portal-hook.js[^"]*" defer><\/script>/, "");
        const dom = new JSDOM(page, { url: "http://localhost/index.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), beforeParse(win) { win.fetch = async () => ({ ok: false, status: 401, text: async () => "" }); } });
        await tick(80); const dd = dom.window.document, fee = () => [...dd.querySelectorAll("#fees .fee")].filter((r) => r.children[0].dataset.name === "Settlement Fee to CLA Title & Escrow").map((r) => r.children[2].value).join(",");
        const z = dd.getElementById("zip"); z.value = "21704"; fire(dom.window, z, "input"); await tick(40); assert.strictEqual(fee(), "1075,670");
        for (const [e, want] of [["lee.lender@example.com", "900,500"], ["omar.broker@example.com", "900,500"], ["pat.homes@example.com", "1075,670"], ["sample.rep.marcus@clatitle.com", "950,600"]]) { await M2.as(e); dom.window.CLA_QUOTE_API.setFeeOverrides(await M2.Ax.getMyFeeOverrides()); assert.strictEqual(fee(), want, e); }
        { const tot = () => ["tB", "tS"].map((i) => +dd.getElementById(i).textContent.replace(/[$,]/g, "")); await M2.as("pat.homes@example.com"); dom.window.CLA_QUOTE_API.setFeeOverrides(await M2.Ax.getMyFeeOverrides()); const std = tot(); await M2.as("omar.broker@example.com"); dom.window.CLA_QUOTE_API.setFeeOverrides(await M2.Ax.getMyFeeOverrides()); const sp = tot();
          assert.strictEqual(JSON.stringify([Math.round((std[0] - sp[0]) * 100), Math.round((std[1] - sp[1]) * 100)]), JSON.stringify([17500, 17000])); }
        ok("calculator + adapter: Omar's totals differ from the standard ones by exactly the settlement-fee difference (175 buyer, 170 seller): insurance premiums and recording fees are unchanged");
        ok("calculator + adapter: Jane's client Lee gets 900 / 500, Marcus 950 / 600, Omar (Marcus's client, listed in Jane's Pricing himself) 900 / 500, unassigned Pat the standard 1075 / 670"); dom.window.close();
        const hook = fs.readFileSync(path.join(dir, "..", "js", "portal-hook.js"), "utf8"); assert.ok(/getMyFeeOverrides/.test(hook) && /setFeeOverrides/.test(hook) && /catch \(e\) \{ \/\* standard fees \*\/ \}/.test(hook)); ok("portal-hook: asks the adapter for the user's fee overrides and hands them to the calculator; any failure = standard fees");
      }
      // individual CLIENTS in a table: own email first, else the rep's table, else standard (fresh sample data)
      {
        const C = mock(), mineC = async (e) => { await C.as(e); return sum((await C.Ax.getMyFeeOverrides()).sort((a, b) => (a.state + a.transaction + a.paidBy).localeCompare(b.state + b.transaction + b.paidBy))); };
        assert.strictEqual(await mineC("omar.broker@example.com"), JANE); assert.strictEqual(await mineC("sample.rep.marcus@clatitle.com"), MARV);
        ok("client pricing (mock): the client's OWN table beats the rep's: Omar (his rep Marcus uses Marvin's Pricing) gets Jane's Pricing; Marcus still gets Marvin's");
        assert.strictEqual(await mineC("lee.lender@example.com"), JANE); assert.strictEqual(await mineC("sam.agent@example.com"), JANE); assert.strictEqual(await mineC("pat.homes@example.com"), ""); assert.strictEqual(await mineC("quinn.buyer@example.com"), "");
        ok("client pricing (mock): a client not in any table follows their assigned rep's table (Lee, Sam: Jane's); a client with no rep or a rep without a table pays standard (Pat, Quinn)");
        await C.as("sample.robin.admin@clatitle.com"); await C.Ax.adminRemovePricingMember("pt2", "Omar.Broker@example.com"); assert.strictEqual(await mineC("omar.broker@example.com"), MARV); ok("client pricing (mock): take Omar out of his own table and he follows his rep Marcus again (Marvin's Pricing)");
        await C.as("sample.robin.admin@clatitle.com");
        assert.strictEqual(await C.Ax.adminAddPricingMember("pt1", " Lee.Lender@Example.com "), "added"); assert.strictEqual(await C.Ax.adminAddPricingMember("pt1", "pat.homes@example.com"), "added"); assert.strictEqual(await C.Ax.adminAddPricingMember("pt1", "future.agent@gmail.com"), "added"); assert.strictEqual(await C.Ax.adminAddPricingMember("pt1", "sample.robin.admin@clatitle.com"), "added");
        ok("client pricing (mock): any email is accepted: a client (any case), an unassigned client, a gmail address with no account yet, and an admin's email (no @clatitle.com rule, no 'add their rep instead')");
        assert.strictEqual(await mineC("lee.lender@example.com"), MARV); assert.strictEqual(await mineC("sam.agent@example.com"), JANE); assert.strictEqual(await mineC("pat.homes@example.com"), MARV); assert.strictEqual(await mineC("sample.robin.admin@clatitle.com"), "");
        ok("client pricing (mock): Lee (Jane's client) now gets Marvin's Pricing instead of his rep's; Sam still follows Jane; Pat (no rep) gets Marvin's on his own; a plain admin gets nothing");
        await C.as("sample.robin.admin@clatitle.com"); await rej(C.Ax.adminAddPricingMember("pt2", "pat.homes@example.com"), /already in pricing table "Marvin's Pricing"/, "client pricing: one email, one table still holds for clients"); assert.strictEqual(await C.Ax.adminAddPricingMember("pt2", "pat.homes@example.com", { move: true }), "moved"); assert.strictEqual(await mineC("pat.homes@example.com"), JANE); ok("client pricing (mock): a client can be moved between tables");
        for (const [who, label] of [["omar.broker@example.com", "a client (even for himself)"], ["sample.rep.marcus@clatitle.com", "a rep"]]) { await C.as(who); await rej(C.Ax.adminAddPricingMember("pt1", "omar.broker@example.com", { move: true }), /Admins only/, "client pricing: " + label + " cannot put an email in a table"); await rej(C.Ax.adminRemovePricingMember("pt2", "pat.homes@example.com"), /Admins only/, "client pricing: " + label + " cannot remove one"); }
        assert.strictEqual(await mineC("omar.broker@example.com"), MARV);
      }
      // MULTI-STATE fee sets (fresh sample data): a set applies to each chosen state and not to others; a state's own set beats the all-states fallback as a whole
      {
        const C = mock(), mineC = async (e) => { await C.as(e); return sum((await C.Ax.getMyFeeOverrides()).sort((a, b) => (a.state + a.transaction + a.paidBy).localeCompare(b.state + b.transaction + b.paidBy))); }, rawC = async (e) => { await C.as(e); return await C.Ax.getMyFeeOverrides(); };
        assert.strictEqual(await mineC("sample.rep.jane@clatitle.com"), JANE); const jr = await rawC("sample.rep.jane@clatitle.com"); assert.strictEqual(JSON.stringify([...new Set(jr.map((o) => o.state))].sort()), JSON.stringify(["FL", "MD", "VA"]));
        ok("multi-state (mock): Jane's table has an MD+VA set (900 / 500) and a separate FL set (1000 / 800): each chosen state gets its rows and DC (in no set) gets none");
        await C.as("sample.robin.admin@clatitle.com");
        await rej(C.Ax.adminSavePricingFeeSet({ tableId: "pt2", states: ["VA", "DC"], purchaseBuyer: 1100, purchaseSeller: 700 }), /VA is already in another fee set of "Jane's Pricing" \(MD, VA\)/, "multi-state: a state cannot be in two sets of one table: the message names the set that holds it");
        assert.strictEqual((await C.Ax.adminListPricingTables()).fees.filter((f) => f.tableId === "pt2").length, 6);
        await C.Ax.adminSavePricingFeeSet({ tableId: "pt2", states: ["VA", "DC"], purchaseBuyer: 1100, purchaseSeller: 700, move: true });
        assert.strictEqual(await mineC("sample.rep.jane@clatitle.com"), "DC/purchase/buyer/1100,DC/purchase/seller/700,FL/purchase/buyer/1000,FL/purchase/seller/800,MD/purchase/buyer/900,MD/purchase/seller/500,VA/purchase/buyer/1100,VA/purchase/seller/700");
        ok("multi-state (mock): with the move confirmed VA leaves the MD+VA set and joins the new VA+DC set; MD keeps its set, FL is untouched");
        await C.as("sample.robin.admin@clatitle.com"); const vadc = (await C.Ax.adminListPricingTables()).fees.find((f) => f.state === "DC").setId;
        await C.Ax.adminSavePricingFeeSet({ tableId: "pt2", setId: vadc, states: ["DC"], purchaseBuyer: 1100, purchaseSeller: 700 }); assert.ok(!(await mineC("sample.rep.jane@clatitle.com")).includes("VA/"));
        await C.as("sample.robin.admin@clatitle.com"); const mdset = (await C.Ax.adminListPricingTables()).fees.find((f) => f.state === "MD").setId; await C.Ax.adminSavePricingFeeSet({ tableId: "pt2", setId: mdset, states: ["MD", "VA"], purchaseBuyer: 900, purchaseSeller: 500 });
        assert.ok((await mineC("sample.rep.jane@clatitle.com")).includes("VA/purchase/buyer/900,VA/purchase/seller/500")); ok("multi-state (mock): editing a set's states: VA+DC becomes DC only (VA has no fee), then MD+VA takes VA back");
        // all-states fallback + a state's own set beats it as a whole
        await C.as("sample.robin.admin@clatitle.com"); await C.Ax.adminSavePricingFeeSet({ tableId: "pt1", states: ["MD"], purchaseBuyer: 900 });
        const mr = await rawC("sample.rep.marcus@clatitle.com"), md = mr.filter((o) => o.state === "MD"), key = (o) => o.transaction + "/" + o.paidBy;
        assert.strictEqual(JSON.stringify(md.map((o) => [key(o), o.amount]).sort()), JSON.stringify([["purchase/buyer", 900], ["purchase/seller", null], ["refi/buyer", null]].sort())); assert.ok(mr.some((o) => o.state === "*" && o.paidBy === "seller" && o.amount === 600));
        ok("multi-state (mock): Marcus has an all-states set (950 / 600 / 350) and now an MD set with only a buyer fee: in MD the buyer fee is 900 and the seller and refi lines are STANDARD (null rows), not the all-states fee; other states use the all-states set");
        await C.as("sample.robin.admin@clatitle.com"); const mdOnly = (await C.Ax.adminListPricingTables()).fees.find((f) => f.tableId === "pt1" && f.state === "MD").setId; await C.Ax.adminRemovePricingFeeSet("pt1", mdOnly); assert.strictEqual(await mineC("sample.rep.marcus@clatitle.com"), "*/purchase/buyer/950,*/purchase/seller/600,*/refi/buyer/350");
        await C.as("sample.robin.admin@clatitle.com"); await rej(C.Ax.adminSavePricingFeeSet({ tableId: "pt1", states: ["*"], purchaseBuyer: 1 }), /\* is already in another fee set|All states is already|already in another fee set/, "multi-state: a second all-states set is refused"); ok("multi-state (mock): removing a state's set sends it back to the all-states fallback");
        await C.as("sample.admin@clatitle.com"); await C.Ax.adminDeletePricingTable("pt2"); const dl = (await C.Ax.adminAuditLog(50)).find((r) => r.details.op === "delete"); assert.ok(dl.details.fees_removed === 3 && dl.details.members_released === 2, JSON.stringify(dl.details)); assert.strictEqual(await mineC("sample.rep.jane@clatitle.com"), ""); ok("multi-state (mock): deleting the table deletes its fee sets (audit counts the 3 sets it then had) and releases Jane to standard fees");
      }
      // quotes in each state for the same rep, in the real calculator page: MD, VA, FL use their sets, DC (in no set) pays standard; only the settlement fee moves
      {
        const root = path.join(__dirname, ".."), idx = fs.readFileSync(path.join(root, "index.html"), "utf8"), M5 = mock();
        const page = idx.replace(/<script src="https[^>]+><\/script>/, "").replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script src="zip-county.js[^"]*"><\/script>/, "<script>" + fs.readFileSync(path.join(root, "zip-county.js"), "utf8") + "</script>")
          .replace(/<script src="fee-snapshot.js[^"]*"><\/script>/, "<script>" + fs.readFileSync(path.join(root, "fee-snapshot.js"), "utf8") + "</script>").replace(/<script src="portal\/js\/portal-hook.js[^"]*" defer><\/script>/, "");
        const dom = new JSDOM(page, { url: "http://localhost/index.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), beforeParse(win) { win.fetch = async () => ({ ok: false, status: 401, text: async () => "" }); } });
        await tick(80); const dd = dom.window.document, W5 = dom.window, fee = () => [...dd.querySelectorAll("#fees .fee")].filter((r) => r.children[0].dataset.name === "Settlement Fee to CLA Title & Escrow").map((r) => r.children[2].value).join(","), tot = () => ["tB", "tS"].map((i) => Math.round(+dd.getElementById(i).textContent.replace(/[$,]/g, "") * 100));
        const apply = async (e) => { await M5.as(e); W5.CLA_QUOTE_API.setFeeOverrides(await M5.Ax.getMyFeeOverrides()); };
        const rows = [["MD", "21704", "900,500", 17500, 17000], ["VA", "22030", "900,500", 17500, 17000], ["FL", "33101", "1000,800", 10000, 15000], ["DC", "20001", "1075,670", 0, 0]];
        for (const [st, zip, want, dB, dS] of rows) { const z = dd.getElementById("zip"); z.value = zip; fire(W5, z, "input"); await tick(40); assert.strictEqual(dd.getElementById("state").value, st, zip);
          await apply("quinn.buyer@example.com"); const std = tot(); await apply("sample.rep.jane@clatitle.com"); assert.strictEqual(fee(), want, st); const sp = tot();
          assert.strictEqual(JSON.stringify([std[0] - sp[0], std[1] - sp[1]]), JSON.stringify([dB, dS]), st + " totals differ by exactly the settlement-fee difference"); }
        ok("calculator + multi-state sets: the same rep's quotes use 900 / 500 in MD and VA, 1000 / 800 in FL and the standard 1075 / 670 in DC; each total differs from the standard total by exactly the settlement-fee difference (premiums and recording fees unchanged)"); dom.window.close();
      }
      // transfer / recordation tax payer choice: saved with the quote, shown on the saved quote and in its print, and a seller net sheet snapshot too
      {
        const root = path.join(__dirname, ".."), idx = fs.readFileSync(path.join(root, "index.html"), "utf8"), M6 = mock();
        const page = idx.replace(/<script src="https[^>]+><\/script>/, "").replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script src="zip-county.js[^"]*"><\/script>/, "<script>" + fs.readFileSync(path.join(root, "zip-county.js"), "utf8") + "</script>")
          .replace(/<script src="fee-snapshot.js[^"]*"><\/script>/, "<script>" + fs.readFileSync(path.join(root, "fee-snapshot.js"), "utf8") + "</script>").replace(/<script src="portal\/js\/portal-hook.js[^"]*" defer><\/script>/, "");
        const dom = new JSDOM(page, { url: "http://localhost/index.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), beforeParse(win) { win.fetch = async () => ({ ok: false, status: 401, text: async () => "" }); } });
        await tick(80); const dd = dom.window.document, W6 = dom.window; const z = dd.getElementById("zip"); z.value = "20850"; fire(W6, z, "input"); await tick(40);
        const pay = (box, name, v) => [...dd.querySelectorAll("#" + box + " button[data-tax]")].find((b) => b.dataset.tax === name && b.dataset.v === v).click();
        pay("taxPay", "County transfer tax", "seller"); pay("taxPay", "County recordation tax", "buyer");
        await M6.as("sample.rep.jane@clatitle.com"); const snap = W6.CLA_QUOTE_API.snapshot(); assert.strictEqual(JSON.stringify(snap.inputs.taxPayers), JSON.stringify({ "County transfer tax": "seller", "County recordation tax": "buyer" }));
        const sv = await M6.Ax.saveQuote(snap), back = await M6.Ax.getQuote(sv.id);
        assert.strictEqual(JSON.stringify(back.inputs.taxPayers), JSON.stringify(snap.inputs.taxPayers)); assert.ok(back.results.lines.some((l) => /County transfer tax \(paid by seller\)/.test(l.item) && l.b === 0 && l.s > 0)); assert.ok(back.results.lines.some((l) => /County recordation tax \(paid by buyer\)/.test(l.item) && l.s === 0 && l.b > 0)); assert.match(back.results.text, /County transfer tax \(paid by seller\)/);
        pay("taxPay", "County transfer tax", "split"); const sp = W6.CLA_QUOTE_API.snapshot(), tl = sp.results.lines.find((l) => /County transfer tax \(split 50\/50\)/.test(l.item));
        assert.ok(tl && tl.b > 0 && Math.abs(tl.b - tl.s) <= 0.01); assert.strictEqual(Math.round((sp.results.totals.buyer + sp.results.totals.seller) * 100), Math.round(sp.results.totals.total * 100));
        const up = await M6.Ax.updateQuote(sv.id, sp), back2 = await M6.Ax.getQuote(sv.id); assert.strictEqual(back2.inputs.taxPayers["County transfer tax"], "split"); assert.match(back2.results.text, /County transfer tax \(split 50\/50\)/);
        ok("tax payer choice (mock): the Seller / Buyer / Split choices ride in the saved quote's inputs, its lines and its copied text; saving again after a change to Split stores the new choice, labelled (split 50/50), with the buyer and seller columns still adding to the total");
        dom.window.close();
      }
      // the admin screen
      {
        const RP = await renderPage("admin.html", "sample.robin.admin@clatitle.com", "#users tr"), $ = (i) => RP.d.getElementById(i), click = async (i, ms) => { $(i).click(); await tick(ms || 80); }, submit = async (i) => { fire(RP.win, $(i), "submit"); await tick(100); };
        const tabs = [...RP.d.querySelectorAll("#tabs button")]; assert.strictEqual(tabs.length, 6); assert.strictEqual(tabs[5].textContent, "Rep pricing"); assert.strictEqual(tabs[4].textContent, "Feedback"); assert.ok($("pPricing").hidden);
        tabs[5].click(); await tick(80);
        assert.ok(!$("pPricing").hidden && $("pUsers").hidden && !$("ptListView").hidden && $("ptDetailView").hidden); assert.match($("pPricing").textContent, /Settlement Fee to CLA Title/); assert.match($("pPricing").textContent, /Title insurance premiums, recording fees, taxes and every other fee never change/);
        const rows = () => [...RP.d.querySelectorAll("#ptRows tr")].map((r) => r.textContent); assert.strictEqual(rows().length, 2); assert.ok(/Marvin's Pricing/.test(rows()[1] || rows()[0]) && rows().join().includes("sample.rep.marcus@clatitle.com") && rows().join().includes("sample.rep.jane@clatitle.com")); assert.match($("ptCount").textContent, /2 tables · 4 rep or client emails/);
        ok("pricing screen: the 'Rep pricing' tab lists the pricing tables with fee counts and member emails; says settlement fee only");
        // member rows: role, and for a client who the rep is and a note when the table differs
        RP.d.querySelector('#ptRows [data-open="pt2"]').click(); await tick(60); const jr = () => [...RP.d.querySelectorAll("#mRows tr")].map((r) => r.textContent);
        const omarRow = jr().find((t) => /omar\.broker@example\.com/.test(t)); assert.ok(omarRow && /Client/.test(omarRow) && /Uses Jane's Pricing instead of their rep Marcus Rep's table \(Marvin's Pricing\)/.test(omarRow), omarRow); assert.ok(/Has an account/.test(omarRow) && /Omar Broker/.test(omarRow));
        ok("pricing screen: a client row shows the role, their rep and the note 'Uses Jane's Pricing instead of their rep Marcus Rep's table (Marvin's Pricing)'");
        assert.match($("mEmail").placeholder, /client/i); assert.match($("pPricing").textContent, /individual client/i);
        for (const e of ["sam.agent@example.com", "pat.homes@example.com", "agent.new@gmail.com"]) { $("mEmail").value = e; await submit("mForm"); assert.strictEqual($("mErr").textContent, "", e); }
        const t2 = jr(); assert.ok(/Sam/.test(t2.find((t) => /sam\.agent/.test(t))) && /same pricing as their rep/.test(t2.find((t) => /sam\.agent/.test(t))), "sam"); assert.match(t2.find((t) => /pat\.homes/.test(t)), /No assigned rep: uses this table on their own/); assert.match(t2.find((t) => /agent\.new/.test(t)), /No portal account yet/);
        ok("pricing screen: any email is accepted (client, no-rep client, gmail address); a client in the same table as their rep says so; a client without a rep says that");
        for (const e of ["sam.agent@example.com", "pat.homes@example.com", "agent.new@gmail.com"]) { RP.d.querySelector('#mRows [data-rm="' + e + '"]').click(); await tick(80); } assert.strictEqual(jr().length, 2); await click("ptBack");
        // new pricing table asks for a name
        assert.ok($("ptNewForm").hidden); await click("ptNew"); assert.ok(!$("ptNewForm").hidden); await submit("ptNewForm"); assert.match($("ptNewErr").textContent, /needs a name/);
        $("ptNewName").value = "Jane's pricing"; await submit("ptNewForm"); assert.match($("ptNewErr").textContent, /already exists/);
        $("ptNewName").value = "Priya's Pricing"; await submit("ptNewForm"); assert.ok($("ptListView").hidden && !$("ptDetailView").hidden); assert.strictEqual($("ptTitle").textContent, "Priya's Pricing"); assert.match($("pOk").textContent, /Created/);
        assert.ok($("fsEditor").hidden); assert.match($("pRows").textContent, /No fee sets yet/); assert.match($("mRows").textContent, /No members yet/); assert.match($("ptSub").textContent, /0 fee sets/);
        ok("pricing screen: 'New pricing table' asks for a name (blank and duplicate refused), then opens the empty table: no fee sets, no members");
        // fee sets: state checkboxes + three fee boxes
        const stored = () => JSON.parse(RP.win.localStorage.getItem("cla_portal_mock_v1")), myRows = () => stored().pricingFees.filter((f) => f.tableId === stored().pricingTables.find((t) => t.name === "Priya's Pricing").id);
        const chk = (st, on) => { const c = st === "*" ? $("fsAll") : RP.d.querySelector('#fsStates input[data-st="' + st + '"]'); if (c.checked !== on) c.click(); }, fin = (tx, side) => RP.d.querySelector('#fsSlots input[data-tx="' + tx + '"][data-side="' + side + '"]');
        const stdCol = () => [...RP.d.querySelectorAll("#fsSlots tr")].map((r) => r.children[1].textContent), rowsOf = () => [...RP.d.querySelectorAll("#pRows tr[data-set]")].map((r) => r.textContent);
        await click("fsAdd", 60); assert.ok(!$("fsEditor").hidden); assert.strictEqual(RP.d.querySelectorAll('#fsStates input[type=checkbox]').length, 5); assert.strictEqual(J(stdCol()), J(["—", "—", "—"]));
        chk("MD", true); chk("VA", true); assert.strictEqual(J(stdCol()), J(["$1,075.00", "$670.00", "$450.00"])); chk("FL", true); assert.strictEqual(J(stdCol()), J(["$1,075.00 / $1,100.00", "$670.00 / $950.00", "$450.00"])); chk("FL", false);
        assert.ok([...RP.d.querySelectorAll("#fsSlots input")].every((i) => i.value === "" && i.placeholder === "Standard")); ok("pricing screen: the editor has All states + MD / VA / DC / FL checkboxes and three fee boxes; the standard amounts follow the chosen states");
        chk("MD", false); chk("VA", false); await click("fsSave", 60); assert.match($("fsErr").textContent, /Pick at least one state/); chk("MD", true); fin("purchase", "buyer").value = "abc"; await click("fsSave", 60); assert.match($("fsErr").textContent, /dollar amount/);
        fin("purchase", "buyer").value = ""; await click("fsSave", 60); assert.match($("fsErr").textContent, /at least one fee/); assert.strictEqual(myRows().length, 0); ok("pricing screen: no state, a non-number or no fee at all is refused with a message and nothing is saved");
        chk("VA", true); fin("purchase", "buyer").value = "900"; fin("purchase", "seller").value = "$500.50"; await click("fsSave", 100); assert.match($("pOk").textContent, /Saved the fee set for Maryland, Virginia in Priya's Pricing/); assert.ok($("fsEditor").hidden);
        assert.strictEqual(rowsOf().length, 1); assert.ok(/Maryland, Virginia/.test(rowsOf()[0]) && /\$900\.00/.test(rowsOf()[0]) && /\$500\.50/.test(rowsOf()[0]) && /Standard/.test(rowsOf()[0]) && /standard \$1,075\.00/.test(rowsOf()[0]));
        assert.strictEqual(J(myRows().map((f) => f.state + f.transaction + f.paidBy + f.amount).sort()), J(["MDpurchasebuyer900", "MDpurchaseseller500.5", "VApurchasebuyer900", "VApurchaseseller500.5"])); assert.strictEqual(new Set(myRows().map((f) => f.setId)).size, 1);
        ok("pricing screen: MD + VA at 900 / 500.50 is ONE fee set: one grouped row listing both states and the amounts (with the standard fee beside them), stored for each state");
        await click("fsAdd", 60); chk("FL", true); fin("purchase", "buyer").value = "1000"; fin("purchase", "seller").value = "800"; await click("fsSave", 100); assert.strictEqual(rowsOf().length, 2); assert.match($("ptSub").textContent, /2 fee sets/); assert.ok(/Maryland, Virginia/.test(rowsOf()[0]) && /^Florida/.test(rowsOf()[1]) && /\$1,000\.00/.test(rowsOf()[1]));
        ok("pricing screen: a second fee set (FL 1000 / 800) shows as its own grouped row; the table has two fee sets");
        await click("fsAdd", 60); assert.ok([...RP.d.querySelectorAll("#fsStates [data-in]")].filter((x) => x.textContent).map((x) => x.dataset.in).join() === "MD,VA,FL"); chk("VA", true); chk("DC", true); fin("purchase", "buyer").value = "1100"; fin("purchase", "seller").value = "700"; await click("fsSave", 60);
        assert.ok(!$("fsMove").hidden); assert.match($("fsMoveTxt").textContent, /VA is already in another fee set of "Priya's Pricing" \(MD, VA\)/); assert.strictEqual(myRows().length, 6);
        await click("fsMoveNo"); assert.ok($("fsMove").hidden); assert.strictEqual(myRows().length, 6); await click("fsSave", 60); assert.ok(!$("fsMove").hidden); await click("fsMoveBtn", 100); assert.ok($("fsEditor").hidden); assert.match($("pOk").textContent, /Virginia, Washington, DC/);
        assert.strictEqual(rowsOf().length, 3); assert.ok(/^Maryland\$900/.test(rowsOf()[0].replace(/\s+/g, "")) || /Maryland/.test(rowsOf()[0]) && !/Virginia/.test(rowsOf()[0])); assert.ok(/Virginia, Washington, DC/.test(rowsOf()[1]) && /\$1,100\.00/.test(rowsOf()[1]));
        assert.strictEqual(J([...new Set(myRows().filter((f) => f.setId === myRows().find((x) => x.state === "DC").setId).map((f) => f.state))].sort()), J(["DC", "VA"]));
        ok("pricing screen: picking a state that is already in another set (VA) is refused with a clear message naming that set, and offers 'Move to this set' (or Cancel): moving takes VA out of the MD+VA set");
        // edit a set: states and amounts
        RP.d.querySelector("#pRows tr[data-set]:nth-child(1) [data-editset]").click(); await tick(60); assert.ok(!$("fsEditor").hidden); assert.match($("fsTitle").textContent, /Edit fee set: Maryland/);
        assert.ok(RP.d.querySelector('#fsStates input[data-st="MD"]').checked && !RP.d.querySelector('#fsStates input[data-st="VA"]').checked && fin("purchase", "buyer").value === "900.00" && fin("purchase", "seller").value === "500.50");
        fin("purchase", "seller").value = ""; fin("refi", "buyer").value = "310"; await click("fsSave", 100); assert.strictEqual(rowsOf().length, 3); assert.ok(/Maryland/.test(rowsOf()[0]) && /\$310\.00/.test(rowsOf()[0])); assert.ok(!myRows().some((f) => f.state === "MD" && f.paidBy === "seller"));
        RP.d.querySelector('#pRows tr[data-set]:nth-child(2) [data-editset]').click(); await tick(60); chk("VA", false); chk("DC", true); chk("FL", false); await click("fsSave", 100); assert.ok(!myRows().some((f) => f.state === "VA")); assert.ok(myRows().some((f) => f.state === "DC"));
        ok("pricing screen: Edit loads a set's states and amounts into the editor; changing the states and boxes saves it in place (a line left empty is standard; a state dropped has no fee)");
        await click("fsAdd", 60); chk("*", true); assert.ok(RP.d.querySelector('#fsStates input[data-st="MD"]').disabled && !RP.d.querySelector('#fsStates input[data-st="MD"]').checked); fin("purchase", "buyer").value = "950"; await click("fsSave", 100);
        assert.strictEqual(rowsOf().length, 4); assert.match(rowsOf()[3], /All states/); assert.match(rowsOf()[3], /for states with no set of their own/); ok("pricing screen: 'All states' is its own fallback set (listed last); ticking it unticks and locks the single states");
        let said = ""; RP.win.confirm = (m) => { said = m; return false; }; RP.d.querySelector("#pRows tr[data-set]:nth-child(4) [data-rmset]").click(); await tick(60); assert.match(said, /Remove the fee set for All states/); assert.strictEqual(rowsOf().length, 4);
        RP.win.confirm = () => true; RP.d.querySelector("#pRows tr[data-set]:nth-child(4) [data-rmset]").click(); await tick(100); assert.strictEqual(rowsOf().length, 3); assert.match($("pOk").textContent, /Removed the fee set for All states/); ok("pricing screen: Remove asks first; confirmed it takes the whole set away");
        // members
        $("mEmail").value = " New.Hire@ClaTitle.com "; await submit("mForm"); assert.match($("mOk").textContent, /Added new\.hire@clatitle\.com\. They have no portal account yet/); assert.match($("mRows").textContent, /new\.hire@clatitle\.com/); assert.match($("mRows").textContent, /No portal account yet/);
        $("mEmail").value = "SAMPLE.new.rep@clatitle.com"; await submit("mForm"); assert.match($("mOk").textContent, /right away/); const riley = [...RP.d.querySelectorAll("#mRows tr")].find((r) => /sample\.new\.rep/.test(r.textContent)); assert.ok(/Has an account/.test(riley.textContent) && /CLA rep/.test(riley.textContent));
        $("mEmail").value = "sample.new.rep@clatitle.com"; await submit("mForm"); assert.match($("mOk").textContent, /already in this table/);
        $("mEmail").value = "nonsense"; await submit("mForm"); assert.match($("mErr").textContent, /valid email/); $("mEmail").value = "x@localhost"; await submit("mForm"); assert.match($("mErr").textContent, /valid email/); $("mEmail").value = ""; await submit("mForm"); assert.match($("mErr").textContent, /Enter the rep's email/);
        $("mEmail").value = "sample.robin.admin@clatitle.com"; await submit("mForm"); assert.match($("mRows").textContent, /not set to work as a rep/);
        ok("pricing screen: members are added by email (any case); no-account emails are flagged; accounts show role; duplicates and bad emails get clear messages; an admin who does not rep is flagged");
        $("mEmail").value = "sample.rep.marcus@clatitle.com"; await submit("mForm"); assert.ok(!$("mMove").hidden); assert.match($("mMoveTxt").textContent, /already in pricing table "Marvin's Pricing"/); assert.ok(!/sample\.rep\.marcus/.test($("mRows").textContent));
        await click("mMoveNo"); assert.ok($("mMove").hidden); assert.ok(!/sample\.rep\.marcus/.test($("mRows").textContent));
        $("mEmail").value = "sample.rep.marcus@clatitle.com"; await submit("mForm"); await click("mMoveBtn", 100); assert.ok($("mMove").hidden); assert.match($("mOk").textContent, /Moved sample\.rep\.marcus@clatitle\.com to Priya's Pricing/); assert.match($("mRows").textContent, /sample\.rep\.marcus@clatitle\.com/);
        assert.strictEqual(stored().pricingMembers.filter((m) => m.email === "sample.rep.marcus@clatitle.com").length, 1); ok("pricing screen: an email already in another table shows which one and offers 'Move to this table' (or cancel); moving leaves it in one table only");
        RP.d.querySelector('#mRows [data-rm="new.hire@clatitle.com"]').click(); await tick(100); assert.ok(!/new\.hire@/.test($("mRows").textContent)); assert.match($("mOk").textContent, /Removed new\.hire@clatitle\.com/); ok("pricing screen: Remove takes an email out of the table");
        // rename, delete
        await click("ptRename"); assert.ok(!$("ptRenameForm").hidden && $("ptRenameName").value === "Priya's Pricing"); $("ptRenameName").value = "marvin's pricing"; await submit("ptRenameForm"); assert.match($("pErr").textContent, /already exists/);
        $("ptRenameName").value = "Priya Pricing"; await submit("ptRenameForm"); assert.strictEqual($("ptTitle").textContent, "Priya Pricing"); assert.ok($("ptRenameForm").hidden); ok("pricing screen: Rename works (a name used by another table is refused)");
        let asked = ""; RP.win.confirm = (m) => { asked = m; return false; }; await click("ptDelete"); assert.match(asked, /Delete the pricing table "Priya Pricing"/); assert.match(asked, /go back to the standard fees/); assert.ok(!$("ptDetailView").hidden); assert.strictEqual(stored().pricingTables.length, 3); ok("pricing screen: Delete asks first (mentions members go back to standard); Cancel keeps the table");
        RP.win.confirm = () => true; await click("ptDelete", 120); assert.ok(!$("ptListView").hidden && $("ptDetailView").hidden); assert.strictEqual(stored().pricingTables.length, 2); assert.ok(!stored().pricingMembers.some((m) => m.email === "sample.new.rep@clatitle.com")); assert.match($("ptCount").textContent, /2 tables/); ok("pricing screen: confirmed delete returns to the list; the table, its fees and members are gone");
        // open an existing table
        RP.d.querySelector("#ptRows [data-open]").click(); await tick(60); assert.ok(!$("ptDetailView").hidden); await click("ptBack"); assert.ok(!$("ptListView").hidden); ok("pricing screen: Open shows a table, 'All pricing tables' returns to the list");
        const aud = stored().audit.filter((r) => r.action === "pricing_table_changed"); assert.ok(aud.length >= 12 && aud.every((r) => r.actorId === ids("a2"))); ok("pricing screen: every change is in the audit log under the admin who made it");
        assert.strictEqual(RP.errs.length, 0, RP.errs.join()); RP.dom.window.close();
        const RQ = await renderPage("admin.html", "sample.admin@clatitle.com", "#users tr"); [...RQ.d.querySelectorAll("#tabs button")][5].click(); await tick(80); assert.ok(!RQ.d.getElementById("pPricing").hidden && RQ.d.querySelectorAll("#ptRows tr").length === 2); ok("pricing screen: a Super admin has it too"); RQ.dom.window.close();
      }
    }

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
    // ---- Help pages: client guide (help.html) and staff manual (staff-help.html) ----
    { const rd = (f) => fs.readFileSync(path.join(__dirname, f), "utf8"), cg = rd("help.html"), sg = rd("staff-help.html"), hook2 = rd("js/portal-hook.js"), pui = rd("js/portal-ui.js");
      const hrefOf = async (pg, who, w) => { const X = await renderPage(pg, who, w); const a = X.d.querySelector("header .hr a#helpLink"), kk = [...X.d.querySelector("header .hr").children];
        const r = { href: a && a.getAttribute("href"), text: a && a.textContent, before: a && kk.indexOf(a) < kk.indexOf(X.d.getElementById("claTourLink")) }; X.dom.window.close(); return r; };
      // header Help link routes by role
      for (const [pg, who, w, want] of [["client.html", "sam.agent@example.com", "#claTourLink", "help.html"], ["rep.html", "sample.rep.jane@clatitle.com", "#claTourLink", "staff-help.html"], ["admin.html", "sample.admin@clatitle.com", "#claTourLink", "staff-help.html"], ["admin.html", "sample.robin.admin@clatitle.com", "#claTourLink", "staff-help.html"]]) {
        const r = await hrefOf(pg, who, w); assert.ok(r.href === want && r.text === "Help" && r.before, who + " -> " + r.href);
      }
      ok("help: the header Help link goes to the client guide for a client and to the staff manual for a rep, an admin and a super admin (before 'Take the tour')");
      const GH = await renderPage("login.html", null, "header"); assert.ok(!GH.d.getElementById("helpLink")); GH.dom.window.close(); ok("help: no Help link in the header for guests (sign-in page)");
      assert.ok(/CLA\.helpHref = \(p\) => \(CLA\.isStaff\(p\) \? "staff-help\.html" : "help\.html"\)/.test(pui) && /claHelpLink[^;]*CLA\.helpHref\(me\)/.test(hook2)); ok("help: the calculator header link uses the same role routing (CLA.helpHref), and only where the account link is (signed in)");
      // guards
      process.on("unhandledRejection", swallow);
      { const G1 = await renderPage("help.html", null, "main"); assert.ok(G1.d.getElementById("top").hidden && !G1.d.querySelector("header.top")); G1.dom.window.close();
        const G2 = await renderPage("staff-help.html", null, "main"); assert.ok(G2.d.getElementById("top").hidden && !G2.d.querySelector("header.top")); G2.dom.window.close(); }
      await new Promise((r) => setTimeout(r, 30)); process.removeListener("unhandledRejection", swallow);
      ok("help: both pages stay hidden for guests (the sign-in guard sends them to login.html?next=...)");
      assert.ok(/CLA\.boot\(null\)/.test(cg) && /CLA\.boot\(null\)/.test(sg) && /!CLA\.isStaff\(me\)\) \{ location\.replace\("help\.html"\)/.test(sg)); ok("help: the staff manual sends anyone who is not staff to the client guide; the client guide only needs a signed-in person");
      { // a client opening the staff manual is redirected (jsdom cannot navigate: it records the call) and never sees the content
        const reds = []; const SC = await renderPage("staff-help.html", "sam.agent@example.com", "header .hr .chip", null, null, "?x=1"); await tick(100);
        assert.ok(SC.d.getElementById("top").hidden && [...SC.d.querySelectorAll(".help-sec")].every((e) => e.closest("main").hidden)); assert.ok(!SC.d.getElementById("audSeg") || SC.d.getElementById("audSeg").hidden); SC.dom.window.close(); }
      ok("help: a client who opens staff-help.html is redirected: the staff content stays hidden");
      // client guide for a client, rep and admin; staff manual for a rep and an admin
      const shown = (X) => !X.d.getElementById("top").hidden;
      for (const who of ["sam.agent@example.com", "sample.rep.jane@clatitle.com", "sample.admin@clatitle.com"]) { const X = await renderPage("help.html", who, "header .hr .chip"); assert.strictEqual(X.errs.length, 0, X.errs.join()); assert.ok(shown(X) && X.d.querySelectorAll(".help-sec").length === 12 && !X.d.getElementById("audSeg")); X.dom.window.close(); }
      ok("help: any signed-in person can read the client guide (12 sections, no audience filter)");
      const secsOf = (X) => [...X.d.querySelectorAll(".help-sec")].filter((e) => !e.hidden);
      const HR = await renderPage("staff-help.html", "sample.rep.jane@clatitle.com", "header .hr .chip"); assert.ok(shown(HR) && secsOf(HR).some((e) => e.dataset.aud === "R") && secsOf(HR).every((e) => e.dataset.aud !== "A") && !HR.d.getElementById("audSeg").hidden && HR.d.getElementById("clientGuideLink").getAttribute("href") === "help.html"); HR.dom.window.close();
      const HA = await renderPage("staff-help.html", "sample.robin.admin@clatitle.com", "header .hr .chip"); assert.ok(shown(HA)); const aud = new Set(secsOf(HA).map((e) => e.dataset.aud)); assert.ok(aud.has("E") && aud.has("R") && aud.has("A"));
      HA.d.querySelector('#audSeg button[data-v="A"]').click(); assert.ok(secsOf(HA).length > 0 && secsOf(HA).every((e) => e.dataset.aud === "A")); HA.d.querySelector('#audSeg button[data-v="mine"]').click(); assert.ok(secsOf(HA).length > 3); HA.dom.window.close();
      ok("help: reps see the Everyone and Reps sections of the staff manual, admins see all and can filter; both have the 'See what clients see' link to help.html");
      // the client guide has no staff terms anywhere in the file (text, comments, scripts, alt text, image paths)
      const low = cg.toLowerCase();
      for (const w of ["pricing table", "audit", "assign", "invite a client", "super admin", "admin", "staff", "discount", "tier", "fee set", "disable", "feedback", "rep dashboard", "rep pricing", "needs confirming", "help/staff", "staff-help", "clients", "internal", "special rate", "standard fee", "pricing", "cheaper", "markup", "waive"]) assert.ok(!low.includes(w), "client guide mentions: " + w);
      // no talk of rates or amounts: judged on the VISIBLE text and the picture captions / alt text (the plain word "rate" must not appear at all)
      const vis = cg.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ") + " " + [...cg.matchAll(/alt="([^"]*)"/g)].map((m) => m[1]).join(" ");
      assert.ok(!/\brates?\b/i.test(cg) && !/\bspecial\s+(rate|price|pricing|fee)/i.test(cg) && !/\bstandard\s+(rate|price|pricing|fee)/i.test(cg), "client guide talks about rates");
      assert.ok(!/\$\s?\d/.test(vis) && !/\b\d+(\.\d+)?\s?%/.test(vis) && !/\b\d{1,3}(,\d{3})+\b/.test(vis), "client guide shows an amount: " + (vis.match(/\$\s?\d[\d,.]*/) || [])[0]);
      ok("help: the client guide has none of the staff, pricing or rate words (pricing table, audit, assign, admin, staff, discount, special rate, standard fee, pricing, the word rate ...), no dollar amounts, and no percentages, anywhere in the file");
      assert.ok(/Saved to your account/.test(cg) && /Forgot password\?/.test(cg) && /Take the tour/.test(cg) && /24 hours/.test(cg) && /Print \/ Save PDF/.test(cg) && /Copy quote/.test(cg) && /Save as new quote/.test(cg) && /View \/ print/.test(cg) && /valid until/.test(cg) && /estimate is not a guarantee/i.test(cg)); ok("help: the client guide covers sign-in, forgot password, getting an estimate, what results mean, saving, printing / saving a PDF, copying, opening and deleting quotes, expiry, the tour");
      assert.ok(/id="Print \/ Save PDF"|Print \/ Save PDF/.test(rd("../index.html")) && /id="copy"/.test(rd("../index.html")) && /id="print"/.test(rd("quote.html")) && !/mailto:[^"]*quote|navigator\.share|download=/i.test(rd("../index.html") + rd("quote.html"))); ok("help: what the guide says is offered (Print / Save PDF, Copy quote) exists in the code, and there is no email / share / download button for it to deny");
      assert.ok(/help\/staff\.css/.test(sg) && !/help\/staff\.css/.test(cg)); ok("help: staff-only styles load only on the staff manual");
      // pictures
      const imgsOf = (h) => [...h.matchAll(/<img src="(help\/(client|staff)\/[\w-]+\.png)" alt="([^"]+)" width="(\d+)" height="(\d+)"/g)];
      const ci = imgsOf(cg), si = imgsOf(sg), cdir = fs.readdirSync(path.join(__dirname, "help", "client")).filter((f) => f.endsWith(".png")), sdir = fs.readdirSync(path.join(__dirname, "help", "staff")).filter((f) => f.endsWith(".png"));
      assert.ok(ci.length >= 16 && ci.every((m) => m[2] === "client" && fs.existsSync(path.join(__dirname, m[1])) && m[3].length > 8 && +m[4] <= 1200)); ok("help: every client-guide picture comes from help/client, exists, has alt text and is at most 1200px wide");
      assert.ok(si.length >= 30 && si.every((m) => fs.existsSync(path.join(__dirname, m[1])) && m[3].length > 8 && +m[4] <= 1200)); ok("help: every staff-manual picture exists, has alt text and is at most 1200px wide");
      const usedC = new Set([...ci, ...si].filter((m) => m[2] === "client").map((m) => path.basename(m[1]))), usedS = new Set(si.filter((m) => m[2] === "staff").map((m) => path.basename(m[1])));
      assert.ok(cdir.length === usedC.size && sdir.length === usedS.size && cdir.every((f) => !sdir.includes(f)) && !/<img(?![^>]*alt=)/.test(cg + sg)); ok("help: no unused or duplicate picture files; client and staff folders are separate");
      assert.ok(!/(admin|rep-|pricing|feedback|audit|special)/.test(cdir.join(" "))); ok("help: the client picture folder holds no admin, rep, pricing, special-rate, feedback or audit pictures"); assert.ok(ci.every((m) => m[2] === "client") && !ci.some((m) => /special|rep-|admin|pricing/.test(m[1]))); ok("help: no client-guide picture comes from the staff folder");
      assert.ok([...cdir.map((f) => "client/" + f), ...sdir.map((f) => "staff/" + f)].every((f) => fs.statSync(path.join(__dirname, "help", f)).size < 200 * 1024)); ok("help: each picture is under 200 KB");
      assert.ok(![cg, sg].some((h) => /https?:\/\/(?!fonts\.googleapis)/.test(h.replace(/quotes\.clatitle\.com/g, "")) || /eyJ|service_role|apikey|password\s*[:=]/i.test(h))); ok("help: no external links except the font, and no keys or passwords in either page");
      assert.ok(/not access control/.test(sg) && /fetched by anyone/.test(sg)); ok("help: the staff manual says plainly that static pages are public and the guard only controls what shows on screen");
      const idsOf = (h) => [...h.matchAll(/ id="([\w-]+)"/g)].map((m) => m[1]), tocOf = (h) => [...h.matchAll(/<a href="#([\w-]+)">/g)].map((m) => m[1]).filter((x) => x !== "top");
      for (const h of [cg, sg]) { const ids = idsOf(h); assert.ok(tocOf(h).length >= 9 && tocOf(h).every((x) => ids.includes(x)) && new Set(ids).size === ids.length); } ok("help: every contents link points at a section on both pages; ids are unique");
    }
    // ---- a client's contact details on the co-branded quote header (calculator print + portal quote view) ----
    { const FQ = "?id=00000000-0000-4000-8000-0000000000f01";
      const G = await renderPage("login.html", null, "header"), W = G.win, L = (p) => Array.from(W.CLA.clientContactLines(p)).map((x) => x.replace(/\u00a0/g, " ")), strip = (h) => h.replace(/<[^>]+>/g, "");
      // only fields with a value appear, in a fixed order
      assert.deepStrictEqual(L({}), []); assert.deepStrictEqual(L(null), []); assert.deepStrictEqual(L({ companyName: "  ", phone: "", companyAddress: null, companyWebsite: "", licenseOrNmls: " " }), []);
      assert.deepStrictEqual(L({ companyAddress: "9 Main St, Alexandria, VA" }), ["9 Main St, Alexandria, VA"]); assert.deepStrictEqual(L({ licenseOrNmls: "NMLS-1" }), ["License / NMLS NMLS-1"]);
      const full = L({ companyName: "Acme Realty", phone: "240-555-0131", cellPhone: "+12405550132", companyPhone: "240-555-0130", companyAddress: "12 Elm St, Bethesda, MD", companyWebsite: "https://www.acme.example/about", licenseOrNmls: "MD-1001" });
      assert.strictEqual(full.length, 6); assert.strictEqual(full[0], "Acme Realty"); assert.strictEqual(full[1], '<span class="nw">Phone 240-555-0131</span> · <span class="nw">Cell (240) 555-0132</span>'); assert.strictEqual(full[2], '<span class="nw">Company 240-555-0130</span>'); assert.strictEqual(full[3], "12 Elm St, Bethesda, MD");
      assert.ok(/^<a href="https:\/\/www\.acme\.example\/about" target="_blank" rel="noopener noreferrer">www\.acme\.example\/about<\/a>$/.test(full[4])); assert.strictEqual(full[5], "License / NMLS MD-1001");
      assert.deepStrictEqual(L({ phone: "240-555-0131", companyPhone: "240-555-0131" }), ['<span class="nw">Phone 240-555-0131</span>']);   // the same number is not printed twice
      ok("contact header: only fields with a value appear (company, phones, address, website, license), in a fixed order; empty / blank fields leave nothing");
      // escaping: nothing from a profile can add markup
      const evil = L({ companyName: '<img src=x onerror=alert(1)>', phone: '"><script>alert(2)</script>', companyAddress: "<b>1 St</b> & Co", companyWebsite: "https://ok.example/<x>", licenseOrNmls: "<svg onload=1>" });
      assert.ok(evil.every((h) => !/<(img|script|b|svg)\b/i.test(h)) && evil.join("").includes("&lt;img src=x onerror=alert(1)&gt;") && evil.join("").includes("&amp; Co") && !evil.some((h) => /<a /.test(h))); ok("contact header: every value is escaped (no tag from a profile survives); a website with markup is dropped");
      // website: http / https only, shown as text
      const sw = (v) => W.CLA.safeWebsite(v);
      for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>", "ftp://x.example", "//evil.example", "www.nope.example", "https://a.example/ b", 'https://a.example/"onmouseover="x', "https://a.example/'x", "https://", "", null, undefined, "https://" + "a".repeat(250) + ".example", "vbscript:x", "file:///etc/passwd"]) assert.strictEqual(sw(bad), null, "should refuse: " + bad);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(sw("HTTPS://Good.Example/Path/?q=1"))), { href: "https://good.example/Path/?q=1", text: "good.example/Path?q=1" }); assert.strictEqual(sw("http://plain.example/").text, "plain.example"); assert.strictEqual(sw("https://plain.example").href, "https://plain.example/");
      const wl = L({ companyWebsite: "javascript:alert(1)" }); assert.deepStrictEqual(wl, []); ok("contact header: the website must be an absolute http(s) address; javascript:, data:, ftp:, protocol-relative, spaces, quotes and bare words are refused; it shows without the scheme"); G.dom.window.close();
      // portal quote view as the client: all fields appear, with the website as a safe link; and a bare profile falls back to name + company only
      const Q1 = await renderPage("quote.html", "sam.agent@example.com", "#body:not([hidden])", null, null, FQ), cb = Q1.d.getElementById("cobrand"), left = cb.querySelector(".party");
      const sp = [...left.querySelectorAll("span")].map((x) => x.textContent.replace(/\u00a0/g, " ")); assert.deepStrictEqual(sp.slice(0, 1), ["Acme Realty"]); assert.ok(sp.some((t) => /^Phone 240-555-0131/.test(t) && /Cell \(240\) 555-0132/.test(t)) && sp.includes("Company 240-555-0130") && sp.includes("12 Elm St, Bethesda, MD") && sp.includes("www.acme-realty.example") && sp.includes("License / NMLS MD-SAMPLE-1001"));
      const a1 = left.querySelector("a"); assert.ok(a1 && a1.getAttribute("href") === "https://www.acme-realty.example/" && a1.target === "_blank" && /noopener/.test(a1.rel)); assert.strictEqual(cb.querySelectorAll(".party").length, 2); assert.ok(/C\.L\.A\. Title & Escrow/.test(cb.querySelectorAll(".party")[1].textContent)); Q1.dom.window.close();
      const Q2 = await renderPage("quote.html", "sam.agent@example.com", "#body:not([hidden])", null, (st) => { const u = st.users.find((x) => x.email === "sam.agent@example.com"); Object.assign(u, { phone: null, cellPhone: null, companyPhone: null, companyAddress: null, companyWebsite: null, licenseOrNmls: null }); }, FQ);
      const sp2 = [...Q2.d.getElementById("cobrand").querySelector(".party").querySelectorAll("span")].map((x) => x.textContent); assert.deepStrictEqual(sp2, ["Acme Realty"]); assert.strictEqual(Q2.d.getElementById("cobrand").querySelector(".party").querySelector("a"), null); Q2.dom.window.close();
      const Q3 = await renderPage("quote.html", "sam.agent@example.com", "#body:not([hidden])", null, (st) => { const u = st.users.find((x) => x.email === "sam.agent@example.com"); Object.assign(u, { companyName: "<img src=x onerror=window.__x=1>Evil", companyAddress: '"><script>window.__y=1</script>', companyWebsite: "javascript:window.__z=1" }); }, FQ);
      assert.ok(!Q3.d.getElementById("cobrand").querySelector("img[onerror],script") && !Q3.win.__x && !Q3.win.__y && !Q3.win.__z && !Q3.d.getElementById("cobrand").querySelector('a[href^="javascript"]') && /Evil/.test(Q3.d.getElementById("cobrand").textContent)); Q3.dom.window.close();
      ok("contact header on the saved-quote page: all of a client's fields show (website as a safe link); a bare profile shows just name and company; markup and javascript: in a profile do nothing");
      // the calculator header uses the same helper; the rep side is untouched; print CSS keeps the block on one page
      const hk = fs.readFileSync(path.join(__dirname, "js", "portal-hook.js"), "utf8");
      assert.ok(/me\.role === "client" \? await clientParty\(me\)/.test(hk) && /CLA\.clientContactLines\(p\)/.test(hk) && /await party\(rep\)/.test(hk) && /CLA\.repContactLines\(p\)/.test(hk) && /width:\.95in;height:\.95in/.test(hk) && /@media print\{\.claBrand\{break-inside:avoid/.test(hk)); ok("contact header: the calculator bar (screen and print) uses the same escaped helper for the client, the rep block uses the rep helper, and the print rules (1 in photo) keep it together");
      // the sales rep's email on the rep block (calculator bar, seller net sheet and quote.html all use CLA.repContactLines)
      const RL = (r) => Array.from(W.CLA.repContactLines(r));
      assert.deepStrictEqual(RL({ cellPhone: "+13015550112", phone: "301-555-0111", email: "jane@clatitle.com" }), ["C.L.A. Title &amp; Escrow", "Cell (301) 555-0112", "jane@clatitle.com"]); assert.deepStrictEqual(RL({ phone: "301-555-0111", email: "jane@clatitle.com" }), ["C.L.A. Title &amp; Escrow", "301-555-0111", "jane@clatitle.com"]); assert.deepStrictEqual(RL({ phone: "301-555-0111" }), ["C.L.A. Title &amp; Escrow", "301-555-0111"]); assert.deepStrictEqual(RL(null), ["C.L.A. Title &amp; Escrow"]);
      const evr = RL({ phone: "<b>1</b>", email: '"><script>x</script>@a.b' }).join(""); assert.ok(!/<(b|script)\b/i.test(evr) && evr.includes("&lt;script&gt;")); ok("rep block: shows C.L.A., cell (else phone) and the rep's email when present, nothing when not; every value escaped");
      const Q4 = await renderPage("quote.html", "sam.agent@example.com", "#body:not([hidden])", null, null, FQ); const rp = Q4.d.getElementById("cobrand").querySelectorAll(".party")[1]; assert.ok(/sample\.rep\.jane@clatitle\.com/.test(rp.textContent)); assert.ok([...rp.querySelectorAll("span")].some((x) => x.textContent === "sample.rep.jane@clatitle.com")); Q4.dom.window.close();
      const Q5 = await renderPage("quote.html", "sam.agent@example.com", "#body:not([hidden])", null, (st) => { const r = st.users.find((x) => x.email === "sample.rep.jane@clatitle.com"); r.email = '"><img src=x onerror=window.__e=1>@evil.example'; }, FQ);
      assert.ok(!Q5.d.getElementById("cobrand").querySelector("img[onerror]") && !Q5.win.__e && /evil\.example/.test(Q5.d.getElementById("cobrand").textContent)); Q5.dom.window.close(); ok("quote page: the rep's email shows as plain text and a hostile email value does nothing");
      const qh = fs.readFileSync(path.join(__dirname, "quote.html"), "utf8"); assert.ok(/CLA\.clientContactLines\(p\)/.test(qh) && !/innerHTML = .*companyWebsite/.test(qh)); ok("contact header: quote.html uses the helper too"); }
    // ---- feedback status updates send NOTHING outbound (John's rule: no automatic e-mail or messages) ----
    { const rdf = (f) => fs.readFileSync(path.join(__dirname, f), "utf8"), mig = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261027000017_feedback_status_updates.sql"), "utf8");
      for (const f of ["js/feedback-widget.js"]) assert.ok(!/mailto:|fetch\(|XMLHttpRequest|sendBeacon|functions\.invoke|\.invoke\(/.test(rdf(f)), f + " must not send anything");
      const adminJs = rdf("admin.html").slice(rdf("admin.html").indexOf("staff feedback: admin and super admin read everything")); assert.ok(!/mailto:|fetch\(|sendBeacon|functions\.invoke|\.invoke\(/.test(adminJs.slice(0, adminJs.indexOf("function drawFeedback") + 6000).split("// ---- ")[0]));
      assert.ok(!/pg_net|net\.http|http_post|mail|smtp|sendgrid|resend|webhook/i.test(mig.replace(/NO e-mail is sent[^\n]*/, "")) , "the migration must not call anything outside the database");
      assert.ok(/\bNO e-mail\b/.test(mig)); ok("feedback status updates: no outbound e-mail or request anywhere (widget, admin feedback code, migration)"); }
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

  // ---- last sign-in (migration 15): the admin Users table can tell "invited" from "signed in" ----
  {
    const rowsP = [{ id: id("a1"), role: "super_admin", status: "active", email: "a@clatitle.com", first_name: "A", last_name: "A", is_complete: true, last_seen_at: null },
                   { id: id("c9"), role: "admin", status: "active", email: "pat@example.com", first_name: "", last_name: "", is_complete: false, last_seen_at: null },
                   { id: id("c8"), role: "client", status: "active", email: "x@example.com", first_name: "X", last_name: "Y", is_complete: true, last_seen_at: null }];
    const rc = []; const mkS = (rpcImpl) => CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: id("a1"), email: "a@clatitle.com" } } } }) },
      from: () => ({ select: () => ({ order: async () => ({ data: rowsP, error: null }) }) }), rpc: async (n, a) => { rc.push([n, a]); return rpcImpl(n, a); } }) });
    const good = await mkS(async () => ({ data: [{ user_id: id("a1"), last_sign_in_at: "2026-10-25T16:06:26.556674+00:00" }, { user_id: id("c9"), last_sign_in_at: null }], error: null })).adminListUsers();
    assert.ok(rc[0][0] === "admin_list_last_sign_ins" && (!rc[0][1] || Object.keys(rc[0][1]).length === 0)); ok("supabase: adminListUsers asks admin_list_last_sign_ins (no arguments), never profiles.last_seen_at");
    assert.strictEqual(good.find((u) => u.id === id("a1")).lastSignInAt, "2026-10-25T16:06:26.556674+00:00"); assert.strictEqual(good.find((u) => u.id === id("c9")).lastSignInAt, null); assert.strictEqual(good.find((u) => u.id === id("c8")).lastSignInAt, undefined); ok("supabase: lastSignInAt = date (signed in), null (never signed in), undefined (not in the answer)");
    const bad = await mkS(async () => ({ data: null, error: { message: "function public.admin_list_last_sign_ins() does not exist" } })).adminListUsers(); assert.ok(bad.length === 3 && bad.every((u) => u.lastSignInAt === undefined)); ok("supabase: RPC missing (migration 15 not applied) = lastSignInAt unknown, the user list still loads");
    const thrown = await mkS(async () => { throw new Error("network"); }).adminListUsers(); assert.ok(thrown.length === 3 && thrown.every((u) => u.lastSignInAt === undefined)); ok("supabase: RPC throws = lastSignInAt unknown, the user list still loads");
    // mock: never signed in until the first sign-in, then a date; ordinary profile reads never carry it
    const wm = boot(), AM = wm.CLA.createMockAdapter({}); await AM.signIn("sample.admin@clatitle.com", "x");
    const nia = async () => (await AM.adminListUsers()).find((u) => u.email === "sample.new.client@example.com");
    assert.strictEqual((await nia()).lastSignInAt, null); await AM.signIn("sample.new.client@example.com", "x"); await AM.signIn("sample.admin@clatitle.com", "x");
    assert.ok(/^2026-|^20\d\d-/.test((await nia()).lastSignInAt)); assert.ok(!("lastSignInAt" in (await AM.getMyProfile()))); ok("mock: never-signed-in user has lastSignInAt null until the first sign-in; getMyProfile does not expose it");
    const mig = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261026000015_admin_last_sign_in.sql"), "utf8").replace(/^--.*$/gm, "");
    assert.ok(/security definer/i.test(mig) && /set search_path = ''/.test(mig) && /private\.is_admin\(\)/.test(mig) && /auth\.users/.test(mig) && /revoke execute on function public\.admin_list_last_sign_ins\(\) from public, anon/.test(mig) && /grant\s+execute on function public\.admin_list_last_sign_ins\(\) to authenticated/.test(mig)); ok("migration 15: definer RPC, empty search_path, admin-only guard, revoked from anon/public");
    assert.ok(!/alter table|drop |insert |update |delete |create policy|grant (select|update|insert)/i.test(mig) && /last_sign_in_at/.test(mig) && !/email|encrypted_password|token/i.test(mig.replace(/auth\.users|public\.profiles/g, ""))); ok("migration 15: read-only, no table/policy/grant changes, exposes only last_sign_in_at");
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
    const fb = [{ id: "f1", created_at: "2026-10-25T10:00:00Z", user_id: id("b1"), role_at_submit: "rep", category: "bug", message: "<b>x</b>", page_path: "/index.html", status: "new", notified_at: null, decided_at: null, decided_note: null, shipped_at: null, shipped_note: null, sender_seen_status: null }];
    const cl = []; const chain2 = (t) => { const o = {}; for (const m of ["select", "eq", "order", "limit"]) o[m] = (...a) => { cl.push([t, m, a]); return o; }; o.then = (res) => res({ data: t === "feedback" ? fb : [{ id: id("b1"), role: "rep", is_rep: false, status: "active", email: "e", first_name: "J", last_name: "R", is_complete: true }], error: null }); o.maybeSingle = o.single = async () => ({ data: { id: id("b1"), role: "rep", is_rep: false, status: "active", email: "e", first_name: "J", last_name: "R", is_complete: true }, error: null }); return o; };
    const SF = CLA.createSupabaseAdapter({ url: "u", anonKey: "k" }, { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: id("b1"), email: "e" } } } }) }, from: (t) => chain2(t),
      rpc: async (n, a) => { cl.push(["rpc", n, a]); return { data: n === "submit_feedback" ? "new-id" : null, error: null }; } }) });
    assert.strictEqual((await SF.submitFeedback({ category: "idea", message: "m", page: "/p" })).id, "new-id"); assert.strictEqual(JSON.stringify(cl.find((c) => c[1] === "submit_feedback")[2]), JSON.stringify({ p_category: "idea", p_message: "m", p_page: "/p" })); ok("supabase: submitFeedback calls the submit_feedback RPC (no table insert)");
    await SF.adminSetFeedbackStatus("f1", "approved", "ok"); assert.strictEqual(JSON.stringify(cl.find((c) => c[1] === "admin_set_feedback_status")[2]), JSON.stringify({ p_id: "f1", p_status: "approved", p_note: "ok" })); assert.ok(!cl.some((c) => c[0] === "feedback" && ["insert", "update", "delete"].includes(c[1]))); ok("supabase: deciding calls admin_set_feedback_status (no direct table writes)");
    const list = await SF.adminListFeedback(); assert.strictEqual(JSON.stringify(list[0]), JSON.stringify({ id: "f1", createdAt: "2026-10-25T10:00:00Z", userId: id("b1"), roleAtSubmit: "rep", category: "bug", message: "<b>x</b>", pagePath: "/index.html", status: "new", notifiedAt: null, decidedAt: null, decidedNote: null, shippedAt: null, shippedNote: null, seenStatus: null })); ok("supabase: feedback rows map to the Feedback DTO (including shipped and seen)");
    await SF.adminMarkFeedbackShipped("f1", "Live now"); assert.strictEqual(JSON.stringify(cl.find((c) => c[1] === "admin_mark_feedback_shipped")[2]), JSON.stringify({ p_id: "f1", p_note: "Live now" })); await SF.markMyFeedbackSeen("f1"); assert.strictEqual(JSON.stringify(cl.filter((c) => c[1] === "mark_my_feedback_seen").pop()[2]), JSON.stringify({ p_id: "f1" })); await SF.markMyFeedbackSeen(); assert.strictEqual(JSON.stringify(cl.filter((c) => c[1] === "mark_my_feedback_seen").pop()[2]), "{}"); assert.ok(!cl.some((c) => c[0] === "feedback" && ["insert", "update", "delete"].includes(c[1]))); ok("supabase: mark shipped and mark seen go through their RPCs (no direct table writes)");
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

    // Maryland principal-residence question (the existing "Owner-occupied principal residence" checkbox): unchecked in MD -> $115 deed of trust (30 pages) and a hint under the box
    {const P = await mkCalc(); assert.strictEqual(P.errs.length, 0, P.errs.join());
      const vis = () => { const b = P.d.body.cloneNode(true); b.querySelectorAll("script,style").forEach((n) => n.remove()); return b.textContent; };
      const st = P.d.getElementById("state"), occ = P.d.getElementById("occ"), note = P.d.getElementById("occNote"), fire = (el, t) => el.dispatchEvent(new P.win.Event(t, { bubbles: true }));
      st.value = "MD"; fire(st, "change"); await tick2(80);
      assert.ok(occ.checked && note.textContent === "" && !/not a principal residence/.test(vis()), "MD default: principal residence, no hint, no $115 label");
      occ.checked = false; fire(occ, "change"); await tick2(80);
      assert.ok(/\$115 instead of \$60/.test(note.textContent) && /Recording fees – Deed of Trust \(10\+ pages, not a principal residence\)/.test(vis()), "MD unchecked: hint + labelled $115 deed of trust line");
      st.value = "VA"; fire(st, "change"); await tick2(80);
      assert.ok(note.textContent === "" && !/not a principal residence\)/.test(vis()), "VA: Maryland rule and hint not shown");
      ok("calculator: MD principal-residence checkbox -> $115 recording for 10+ pages (hint + labelled line); not shown for VA"); }

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
    assert.ok(vs.length === 3 && new Set(vs).size === 1 && vs[0] === "20261027m" && new RegExp('CLA.TOUR_V = "' + vs[0] + '"').test(pu) && idx.includes('var V="' + vs[0] + '"')); ok("calculator tour: the index.html ?v= values (zip-county, fee-snapshot, portal-hook), the tour loader's version and CLA.TOUR_V are all 20261027m");
    // the new elements are inert in print and add no external requests
    assert.ok(/@media print\{\s*@page\{margin:14mm\}\s*\.claChip\{display:none!important\}/.test(idx) && !/https?:\/\//.test(tj2)); ok("calculator tour: the chip is not printed; tour.js has no external libraries or CDN");
  }
  console.log("\nALL PASS (" + pass + " checks)");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
