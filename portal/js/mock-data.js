/* Sample people and quotes for the MOCK adapter. All fictional; mirrors supabase/seed.sql so the two line up.
 * Photos are drawn placeholders (head-and-shoulders silhouettes), not real people. */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  const id = (k) => "00000000-0000-4000-8000-0000000000" + k;

  const P = (k, role, email, f, l, phone, co, extra) =>
    Object.assign({ id: id(k), role, status: "active", email, firstName: f, lastName: l, phone, companyName: co,
      companyPhone: null, companyAddress: null, companyWebsite: null, licenseOrNmls: null, avatarPath: null,
      termsAcceptedAt: "2026-10-01T12:00:00Z", createdAt: "2026-10-01T12:00:00Z" }, extra || {});

  CLA.MOCK_SEED = function () {
    const now = Date.now(), day = 86400000, iso = (d) => new Date(now - d * day).toISOString();
    const users = [
      P("a1", "super_admin", "sample.admin@clatitle.com", "Alex", "Admin", "301-555-0100", "C.L.A. Title & Escrow"),
      P("b1", "rep", "sample.rep.jane@clatitle.com", "Jane", "Rep", "301-555-0111", "C.L.A. Title & Escrow", { companyAddress: "Rockville, MD", avatarPath: id("b1") + "/avatar" }),
      P("b2", "rep", "sample.rep.marcus@clatitle.com", "Marcus", "Rep", "703-555-0122", "C.L.A. Title & Escrow", { companyAddress: "Arlington, VA", avatarPath: id("b2") + "/avatar" }),
      P("c1", "client", "sam.agent@example.com", "Sam", "Agent", "240-555-0131", "Acme Realty", { companyPhone: "240-555-0130", companyAddress: "12 Elm St, Bethesda, MD", licenseOrNmls: "MD-SAMPLE-1001", avatarPath: id("c1") + "/avatar" }),
      P("c2", "client", "lee.lender@example.com", "Lee", "Lender", "202-555-0141", "Capital Home Loans", { companyAddress: "500 K St NW, Washington, DC", licenseOrNmls: "NMLS-SAMPLE-2002" }),
      P("c3", "client", "pat.homes@example.com", "Pat", "Homes", "757-555-0151", "Homes by Pat"),
      P("c4", "client", "dee.disabled@example.com", "Dee", "Disabled", "703-555-0161", "Old Dominion Realty", { status: "disabled" }),
      P("c5", "client", "omar.broker@example.com", "Omar", "Broker", "703-555-0171", "Potomac Brokers", { companyAddress: "9 Main St, Alexandria, VA" }),
    ];
    const A = (n, email, rep, uid) => ({ id: "as" + n, clientEmail: email, clientUserId: uid ? id(uid) : null, repId: id(rep), active: true, createdAt: iso(20) });
    const assignments = [
      A(1, "sam.agent@example.com", "b1", "c1"), A(2, "lee.lender@example.com", "b1", "c2"),
      A(3, "dee.disabled@example.com", "b2", "c4"), A(4, "omar.broker@example.com", "b2", "c5"),
      A(5, "nina.newagent@example.com", "b2", null),
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
    ];
    const audit = [
      { id: "au1", at: iso(2), actorId: id("a1"), action: "invite_sent", targetType: "invitation", details: { email: "omar.broker@example.com", role: "client" } },
      { id: "au2", at: iso(1), actorId: id("a1"), action: "assignment_changed", targetType: "assignment", details: { client_email: "lee.lender@example.com", rep_id: id("b1") } },
      { id: "au3", at: iso(1), actorId: id("b1"), action: "photo_changed", targetType: "photo", details: { mime_type: "image/jpeg" } },
    ];
    // sample "photos": silhouettes in the sample colors, stored as data URLs keyed by user id
    const photos = {};
    photos[id("b1")] = CLA.silhouette("#cfe6a6", "#4d7a17");
    photos[id("b2")] = CLA.silhouette("#d6dff0", "#33476b");
    photos[id("c1")] = CLA.silhouette("#f3dcc4", "#8a5a2b");
    return { version: 1, users, assignments, quotes, audit, photos, invitations: [] };
  };
})();
