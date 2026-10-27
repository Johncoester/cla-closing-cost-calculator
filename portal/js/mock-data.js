/* Sample people and quotes for the MOCK adapter. All fictional; mirrors supabase/seed.sql so the two line up.
 * Photos are drawn placeholders (head-and-shoulders silhouettes), not real people. */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  const id = (k) => "00000000-0000-4000-8000-0000000000" + k;

  // fictional cell numbers (555-01xx), stored the way the database stores them: +1XXXXXXXXXX. Pat has none (optional for clients).
  const CELL = { a1: "+13015550101", b1: "+13015550112", b2: "+17035550123", c1: "+12405550132", c2: "+12025550142", c4: "+17035550162", c5: "+17035550172", c6: "+12025550182" };
  const P = (k, role, email, f, l, phone, co, extra) =>
    Object.assign({ id: id(k), role, status: "active", email, firstName: f, lastName: l, phone, cellPhone: CELL[k] || null, companyName: co,
      companyPhone: null, companyAddress: null, companyWebsite: null, licenseOrNmls: null, avatarPath: null,
      isRep: role === "rep", termsAcceptedAt: "2026-10-01T12:00:00Z", createdAt: "2026-10-01T12:00:00Z", tourSeenAt: "2026-10-01T12:30:00Z", lastSignInAt: "2026-10-20T14:00:00Z" }, extra || {});   // the sample people have seen the tour (like existing users when migration 14 runs)

  CLA.MOCK_SEED = function () {
    const now = Date.now(), day = 86400000, iso = (d) => new Date(now - d * day).toISOString();
    const users = [
      // the sample admin ALSO works as a rep (isRep): she has clients Quinn and (pending) Rae, and a photo
      P("a1", "super_admin", "sample.admin@clatitle.com", "Alex", "Admin", "301-555-0100", "C.L.A. Title & Escrow", { isRep: true, companyAddress: "Rockville, MD", avatarPath: id("a1") + "/avatar" }),
      // Robin is an "admin" (migration 10): the full dashboard; manages reps, clients and other admins (migration 11), never a super admin
      P("a2", "admin", "sample.robin.admin@clatitle.com", "Robin", "Admin", "301-555-0105", "C.L.A. Title & Escrow", { companyAddress: "Rockville, MD", avatarPath: id("a2") + "/avatar" }),
      // Casey is a second Admin (migration 11): an admin may manage ANOTHER admin (disable, demote to rep / client), never a super admin
      P("a3", "admin", "sample.casey.admin@clatitle.com", "Casey", "Admin", "301-555-0106", "C.L.A. Title & Escrow", { companyAddress: "Rockville, MD", avatarPath: id("a3") + "/avatar" }),
      P("b1", "rep", "sample.rep.jane@clatitle.com", "Jane", "Rep", "301-555-0111", "C.L.A. Title & Escrow", { companyAddress: "Rockville, MD", avatarPath: id("b1") + "/avatar" }),
      P("b2", "rep", "sample.rep.marcus@clatitle.com", "Marcus", "Rep", "703-555-0122", "C.L.A. Title & Escrow", { companyAddress: "Arlington, VA", avatarPath: id("b2") + "/avatar" }),
      P("c1", "client", "sam.agent@example.com", "Sam", "Agent", "240-555-0131", "Acme Realty", { companyPhone: "240-555-0130", companyAddress: "12 Elm St, Bethesda, MD", companyWebsite: "https://www.acme-realty.example", licenseOrNmls: "MD-SAMPLE-1001", avatarPath: id("c1") + "/avatar" }),
      P("c2", "client", "lee.lender@example.com", "Lee", "Lender", "202-555-0141", "Capital Home Loans", { companyAddress: "500 K St NW, Washington, DC", licenseOrNmls: "NMLS-SAMPLE-2002" }),
      P("c3", "client", "pat.homes@example.com", "Pat", "Homes", "757-555-0151", "Homes by Pat"),
      P("c4", "client", "dee.disabled@example.com", "Dee", "Disabled", "703-555-0161", "Old Dominion Realty", { status: "disabled" }),
      P("c5", "client", "omar.broker@example.com", "Omar", "Broker", "703-555-0171", "Potomac Brokers", { companyAddress: "9 Main St, Alexandria, VA" }),
      P("c6", "client", "quinn.buyer@example.com", "Quinn", "Buyer", "202-555-0181", "Bright Realty", { companyPhone: "202-555-0180", companyAddress: "1 Dupont Cir, Washington, DC" }),
      // brand-new people (migration 14): they have NOT seen the guided tour, so it starts by itself the first time they open their dashboard
      P("c7", "client", "sample.new.client@example.com", "Nia", "Newcomer", "301-555-0191", "Fresh Start Realty", { tourSeenAt: null, lastSignInAt: null, createdAt: new Date(now - 3600000).toISOString() }),
      P("b3", "rep", "sample.new.rep@clatitle.com", "Riley", "Rookie", "301-555-0192", "C.L.A. Title & Escrow", { tourSeenAt: null, lastSignInAt: null, createdAt: new Date(now - 3600000).toISOString() }),
    ];
    const A = (n, email, rep, uid) => ({ id: "as" + n, clientEmail: email, clientUserId: uid ? id(uid) : null, repId: id(rep), active: true, createdAt: iso(20) });
    const assignments = [
      A(1, "sam.agent@example.com", "b1", "c1"), A(2, "lee.lender@example.com", "b1", "c2"),
      A(3, "dee.disabled@example.com", "b2", "c4"), A(4, "omar.broker@example.com", "b2", "c5"),
      A(5, "nina.newagent@example.com", "b2", null),
      A(6, "quinn.buyer@example.com", "a1", "c6"), A(7, "rae.pending@example.com", "a1", null),   // the admin's own clients (admin who also works as a rep)
    ];
    const lines = (sec, items) => items.map((x) => ({ sec, item: x[0], b: x[1], s: x[2] || 0 }));
    const buyerResults = (total) => ({
      headline: { label: "Buyer total", value: total }, totals: { buyer: total, seller: 1250, total: total + 1250 },
      lines: [].concat(
        lines("A. Title & settlement", [["Settlement / closing fee", 750], ["Lender's title insurance", 1480], ["Owner's title insurance", 2210]]),
        lines("B. Government recording & transfer", [["Recording fees (deed + deed of trust)", 260], ["County transfer tax", 3150, 1250]]),
        lines("C. Prepaids & escrow", [["Prepaid interest", 1180], ["Homeowner's insurance reserve", 1020]])),
      warnings: [], text: "C.L.A. Title & Escrow — Closing Cost Estimate (sample)" });
    const sellerResults = (net) => ({
      headline: { label: "Net seller proceeds", value: net }, totals: { net },
      lines: [].concat(
        [{ sec: "1. Commissions", item: "Listing & buyer's agent commissions", amt: 36600 }],
        [{ sec: "2. Title & settlement", item: "Settlement fee, title search, release recording", amt: 1850 }],
        [{ sec: "3. Mortgage payoffs", item: "First mortgage payoff", amt: 248000 }]),
      warnings: [], text: "C.L.A. Title & Escrow — Seller's Net Sheet (sample)" });
    const Q = (n, owner, rep, type, label, st, co, addr, price, ago, total, deleted) => ({
      id: id("f0" + n), ownerId: id(owner), repId: rep ? id(rep) : null, quoteType: type, label, state: st, county: co,
      propertyAddress: addr, price, inputs: {}, results: type === "buyer" ? buyerResults(total) : sellerResults(total),
      feeVersion: "sheet 2026-10-23", createdAt: iso(ago), expiresAt: new Date(now + (30 - ago) * day).toISOString(), deletedAt: deleted ? iso(1) : null });
    const quotes = [
      Q(1, "c1", "b1", "buyer", "Buyer, 123 Main St", "MD", "Montgomery", "123 Main St, Bethesda, MD", 525000, 2, 14250.55),
      Q(2, "c1", "b1", "seller_net", "Seller net, 9 Oak Ave", "MD", "Montgomery", "9 Oak Ave, Silver Spring, MD", 610000, 10, 541200),
      Q(3, "c1", "b1", "buyer", "Buyer, 77 Pine Rd", "MD", "Howard", "77 Pine Rd, Columbia, MD", 430000, 29, 11800),
      Q(5, "c2", "b1", "buyer", "Buyer, 800 K St", "DC", "District of Columbia", "800 K St NW, Washington, DC", 750000, 1, 31000),
      Q(6, "c5", "b2", "buyer", "Buyer, 41 River Rd", "VA", "Fairfax", "41 River Rd, Fairfax, VA", 680000, 3, 17400),
      Q(7, "c3", null, "buyer", "Buyer, 2 Unassigned Way", "VA", "Norfolk", "2 Unassigned Way, Norfolk, VA", 350000, 5, 8200),
      Q(8, "b1", "b1", "buyer", "Jane test quote", "MD", "Montgomery", "1 Rep Test Ct, Rockville, MD", 500000, 4, 13000),
      Q(10, "c6", "a1", "buyer", "Buyer, 1 Quinn Way", "DC", "District of Columbia", "1 Quinn Way NW, Washington, DC", 640000, 2, 22500),
      Q(11, "a1", "a1", "buyer", "Alex test quote (admin who also reps)", "MD", "Montgomery", "2 Admin Rep Ct, Rockville, MD", 550000, 1, 15000),
    ];
    const audit = [
      { id: "au1", at: iso(2), actorId: id("a1"), action: "invite_sent", targetType: "invitation", details: { email: "omar.broker@example.com", role: "client" } },
      { id: "au2", at: iso(1), actorId: id("a1"), action: "assignment_changed", targetType: "assignment", details: { client_email: "lee.lender@example.com", rep_id: id("b1") } },
      { id: "au3", at: iso(1), actorId: id("b1"), action: "photo_changed", targetType: "photo", details: { mime_type: "image/jpeg" } },
    ];
    // sample "photos": silhouettes in the sample colors, stored as data URLs keyed by user id
    const photos = {};
    photos[id("a1")] = CLA.silhouette("#f1d9e6", "#8a2b5e");
    photos[id("a2")] = CLA.silhouette("#d9e8f1", "#2b5e8a");
    photos[id("a3")] = CLA.silhouette("#e4dcf1", "#5e2b8a");
    photos[id("b1")] = CLA.silhouette("#cfe6a6", "#4d7a17");
    photos[id("b2")] = CLA.silhouette("#d6dff0", "#33476b");
    photos[id("c1")] = CLA.silhouette("#f3dcc4", "#8a5a2b");
    // Nina has no account yet (pending); her invitation carries her cell so the rep can see it. Mirrors supabase/seed.sql.
    const invitations = [{ email: "nina.newagent@example.com", role: "client", invitedBy: id("b2"), cellPhone: "+17035550181", createdAt: iso(20) },
      { email: "rae.pending@example.com", role: "client", invitedBy: id("a1"), cellPhone: "+15715550191", createdAt: iso(20) }];
    // staff feedback (migration 13): a few sample submissions so the admin Feedback panel has something to show
    const feedback = [
      { id: "fb1", createdAt: iso(3), userId: id("b1"), roleAtSubmit: "rep", category: "bug", message: "The Save as new quote button sometimes says saved but the quote list does not update until I refresh.", pagePath: "/index.html", status: "new", notifiedAt: null, decidedAt: null, decidedNote: null },
      { id: "fb2", createdAt: iso(2), userId: id("a2"), roleAtSubmit: "admin", category: "idea", message: "Could the Users table have a search box? With more reps it gets long.", pagePath: "/portal/admin.html", status: "notified", notifiedAt: iso(2), decidedAt: null, decidedNote: null },
      { id: "fb3", createdAt: iso(1), userId: id("b2"), roleAtSubmit: "rep", category: "question", message: "Where do I change my cell number so it shows on the quotes?", pagePath: "/portal/rep.html", status: "approved", notifiedAt: iso(1), decidedAt: iso(1), decidedNote: "Profile page, top right. Added a tip to the dashboard." },
    ];
    // starter pricing tables (migration 16), all fake: "Marvin's Pricing" (Marcus, plus an email with no portal account yet) and "Jane's Pricing" (Jane)
    const PT = (n, name) => ({ id: "pt" + n, name, createdBy: id("a1"), createdAt: iso(3), updatedAt: iso(1) });
    const pricingTables = [PT(1, "Marvin's Pricing"), PT(2, "Jane's Pricing")];
    // fee SETS: one set = a selection of states + amounts, stored as one row per state per line (setId groups them).
    // Marvin's Pricing: one all-states set (the fallback). Jane's Pricing: an MD+VA set (900 / 500) and a separate FL set (1000 / 800); DC has no set, so Jane pays standard there.
    const PF = (n, t, set, st, tx, pb, amt) => ({ id: "pf" + n, tableId: "pt" + t, setId: "ps" + set, state: st, transaction: tx, paidBy: pb, amount: amt, updatedAt: iso(1), updatedBy: id("a1") });
    const pricingFees = [PF(1, 1, 1, "*", "purchase", "buyer", 950), PF(2, 1, 1, "*", "purchase", "seller", 600), PF(3, 1, 1, "*", "refi", "buyer", 350),
      PF(4, 2, 2, "MD", "purchase", "buyer", 900), PF(5, 2, 2, "MD", "purchase", "seller", 500), PF(6, 2, 2, "VA", "purchase", "buyer", 900), PF(7, 2, 2, "VA", "purchase", "seller", 500),
      PF(8, 2, 3, "FL", "purchase", "buyer", 1000), PF(9, 2, 3, "FL", "purchase", "seller", 800)];
    const PM = (n, t, email) => ({ id: "pm" + n, tableId: "pt" + t, email, addedBy: id("a1"), addedAt: iso(2) });
    // Omar is Marcus's client but is listed in Jane's Pricing himself: his own email beats his rep's table
    const pricingMembers = [PM(1, 1, "sample.rep.marcus@clatitle.com"), PM(2, 1, "marvin.newhire@clatitle.com"), PM(3, 2, "sample.rep.jane@clatitle.com"), PM(4, 2, "omar.broker@example.com")];
    return { version: 10, users, assignments, quotes, audit, photos, invitations, feedback, pricingTables, pricingFees, pricingMembers };
  };
})();
