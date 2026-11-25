/* Upload CLA fees helpers: template, parse, validate, diff. Used by portal/admin.html (CLA fees tab) and the mock adapter.
 * No network except CLA.loadCurrentClaFees (reads the public fee sheet, like the calculator does).
 * The SAME rules are enforced again by the database (migration 22, admin_submit_cla_fee_batch): this file is only for the preview. */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  CLA.FEE_UPLOAD_MAX = 500;
  CLA.FEE_FILE_MAX_BYTES = 1048576;
  // the CLA_Fees tab of "CLA Fee Tables (Live - Calculator)", same column order
  CLA.FEE_HEADERS = ["Active", "State", "Fee Name", "Transaction", "Amount", "Paid By", "LE Section", "Default On", "Notes"];
  CLA.FEE_SHEET_ID = "1kVBo3hchS-B5-g8NHn5ZSAdAZxXxOjuaHTv6SuXamOM";
  CLA.US_STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
    FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
  // States the calculator can quote today (its State dropdown in index.html; a test keeps the two in step).
  CLA.CALC_STATES = ["MD", "DC", "VA", "FL", "PA", "WV", "MI"];
  const TX = { purchase: "Purchase", refi: "Refi", refinance: "Refi", financed: "Financed", both: "Both" };
  const PAY = { buyer: "Buyer", seller: "Seller", borrower: "Borrower", split: "Split" };
  const SECS = ["B", "C", "E", "H"];
  const flag = (v, d) => { const s = String(v == null ? "" : v).trim().toLowerCase(); if (!s) return d; if (["y", "yes", "true", "1"].includes(s)) return true; if (["n", "no", "false", "0"].includes(s)) return false; return null; };
  const ALIAS = {
    "Active": ["active"], "State": ["state", "st"], "Fee Name": ["fee name", "fee", "fee_name", "name"], "Transaction": ["transaction", "tx", "type"],
    "Amount": ["amount", "amt", "fee amount"], "Paid By": ["paid by", "paid_by", "payer"], "LE Section": ["le section", "le_section", "section"],
    "Default On": ["default on", "default_on", "default"], "Notes": ["notes", "note"],
  };
  const headerKey = (h) => { const k = String(h == null ? "" : h).trim().toLowerCase().replace(/[_\s]+/g, " "); for (const col of CLA.FEE_HEADERS) if (ALIAS[col].includes(k)) return col; return null; };
  const key = (r) => r.state + "|" + String(r.feeName).toLowerCase() + "|" + r.transaction + "|" + r.paidBy;
  CLA.feeKey = key;
  const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  CLA.feeMoney = money;

  // grid (array of arrays, first row = headers) -> raw rows keyed by the CLA_Fees column names
  CLA.feeRowsFromGrid = function (grid) {
    if (!grid || !grid.length) return { error: "This file is empty.", rows: [] };
    const map = {}; grid[0].forEach((h, i) => { const k = headerKey(h); if (k && map[k] === undefined) map[k] = i; });
    const missing = ["State", "Fee Name", "Transaction", "Amount", "Paid By"].filter((k) => map[k] === undefined);
    if (missing.length) return { error: "Missing column" + (missing.length > 1 ? "s" : "") + ": " + missing.join(", ") + ". Start from the template.", rows: [] };
    const rows = grid.slice(1).filter((r) => r.some((c) => String(c == null ? "" : c).trim() !== ""))
      .map((r) => { const o = {}; CLA.FEE_HEADERS.forEach((h) => { o[h] = map[h] === undefined ? "" : r[map[h]] == null ? "" : String(r[map[h]]); }); return o; });
    if (!rows.length) return { error: "The file has no fee rows.", rows: [] };
    if (rows.length > CLA.FEE_UPLOAD_MAX) return { error: "Upload at most " + CLA.FEE_UPLOAD_MAX + " fee rows at a time (this file has " + rows.length + ").", rows: [] };
    return { error: null, rows };
  };

  // one raw row -> clean row + errors (the same rules as the database)
  function cleanRow(o, line) {
    const errors = [];
    const state = String(o.State || "").trim().toUpperCase();
    const feeName = String(o["Fee Name"] || "").trim().replace(/\s+/g, " ");
    const transaction = TX[String(o.Transaction || "").trim().toLowerCase()] || null;
    const paidBy = PAY[String(o["Paid By"] || "").trim().toLowerCase()] || null;
    const leSection = String(o["LE Section"] || "").trim().toUpperCase() || "C";
    const amtRaw = String(o.Amount == null ? "" : o.Amount).replace(/[$,\s]/g, "");
    const amount = /^\d+(\.\d{1,2})?$/.test(amtRaw) ? Number(amtRaw) : null;
    const active = flag(o.Active, true), defaultOn = flag(o["Default On"], true);
    const notes = String(o.Notes || "").trim();
    if (!CLA.US_STATES[state]) errors.push("State must be a US state code like MD" + (state ? " (got “" + state + "”)" : "") + ".");
    if (!feeName) errors.push("Fee name is required.");
    else if (feeName.length > 120 || /[\u0000-\u001f\u007f]/.test(feeName)) errors.push("Fee name is too long or has hidden characters.");
    if (!transaction) errors.push("Transaction must be Purchase, Refi, Financed or Both.");
    if (amount === null) errors.push("Amount must be a number like 450 or 4.75" + (amtRaw ? " (got “" + String(o.Amount).trim() + "”)" : "") + ".");
    else if (amount > 100000) errors.push("Amount is over $100,000.");
    if (!paidBy) errors.push("Paid by must be Buyer, Seller, Borrower or Split.");
    if (!SECS.includes(leSection)) errors.push("LE section must be B, C, E or H.");
    if (active === null) errors.push("Active must be Y or N.");
    if (defaultOn === null) errors.push("Default On must be Y or N.");
    if (notes.length > 1000) errors.push("Notes are too long (1000 characters at most).");
    return { line, state, feeName, transaction, amount, paidBy, leSection, active: active !== false, defaultOn: defaultOn !== false, notes, errors, warnings: [] };
  }

  // raw rows -> { rows, errorCount, states, stateWarnings{st: [..]} }
  CLA.validateFeeRows = function (raw) {
    const seen = {}, rows = raw.map((o, i) => cleanRow(o, i + 1));
    rows.forEach((r) => {
      if (r.errors.length) return;
      const k = key(r); if (seen[k]) r.errors.push("Duplicate of row " + seen[k] + " (same state, fee, transaction and payer)."); else seen[k] = r.line;
      if (r.transaction === "Refi" && r.paidBy === "Seller") r.warnings.push("A refinance has no seller: the calculator ignores this row.");
    });
    const ok = rows.filter((r) => !r.errors.length), states = [...new Set(ok.map((r) => r.state))].sort();
    const stateWarnings = {};
    for (const st of states) {
      const w = [], mine = ok.filter((r) => r.state === st);
      if (!CLA.CALC_STATES.includes(st)) w.push("The calculator can’t quote " + (CLA.US_STATES[st] || st) + " yet (no counties, recording fees, transfer taxes or title premiums). These fees will be saved and used once " + st + " is added to the calculator.");
      if (!mine.some((r) => r.active)) w.push("Every " + st + " row is inactive: " + st + " quotes would show no CLA fees.");
      else if (!mine.some((r) => r.active && /^settlement fee to cla title/i.test(r.feeName))) w.push("No active “Settlement Fee to CLA Title & Escrow” row: rep pricing can’t lower the settlement fee in " + st + ".");
      stateWarnings[st] = w;
    }
    return { rows, errorCount: rows.filter((r) => r.errors.length).length, states, stateWarnings };
  };

  // the calculator's CLA_Fees grid (sheet / snapshot) -> clean rows
  CLA.feeRowsFromSheetGrid = function (grid) {
    const r = CLA.feeRowsFromGrid(grid || []); if (r.error && !r.rows.length) return [];
    return r.rows.map((o, i) => cleanRow(o, i + 1)).filter((x) => !x.errors.length);
  };

  // diff of the uploaded rows vs the current rows, per uploaded state
  CLA.diffFees = function (rows, current) {
    const out = {};
    const states = [...new Set(rows.map((r) => r.state))].sort();
    for (const st of states) {
      const now = rows.filter((r) => r.state === st), was = (current || []).filter((r) => r.state === st);
      const byKey = {}; was.forEach((r) => (byKey[key(r)] = r));
      const d = { added: [], changed: [], removed: [], same: 0 };
      for (const r of now) {
        const b = byKey[key(r)];
        if (!b) { d.added.push(r); continue; }
        delete byKey[key(r)];
        const fields = [];
        if (Number(b.amount) !== Number(r.amount)) fields.push("amount");
        if (b.active !== r.active) fields.push("active");
        if (b.leSection !== r.leSection) fields.push("section");
        if (b.defaultOn !== r.defaultOn) fields.push("default");
        if (fields.length) {
          const big = fields.includes("amount") && Number(b.amount) > 0 && Math.abs(r.amount - b.amount) / b.amount > 0.5 && Math.abs(r.amount - b.amount) >= 100;
          d.changed.push({ before: b, after: r, fields, big });
        } else d.same++;
      }
      d.removed = Object.values(byKey);
      out[st] = d;
    }
    return out;
  };

  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""') + '"' : s; };
  // a CSV in the CLA_Fees layout, prefilled with the current fees of one state (or one sample row for a state with none)
  CLA.feeTemplateCsv = function (state, current) {
    const st = String(state || "").toUpperCase(), mine = (current || []).filter((r) => r.state === st);
    const rows = mine.length ? mine : [{ active: true, state: st || "MD", feeName: "Settlement Fee to CLA Title & Escrow", transaction: "Purchase", amount: 0, paidBy: "Buyer", leSection: "C", defaultOn: true, notes: "Replace with CLA's fee" }];
    return [CLA.FEE_HEADERS.join(",")].concat(rows.map((r) => [r.active ? "Y" : "N", r.state, r.feeName, r.transaction, r.amount, r.paidBy, r.leSection, r.defaultOn ? "Y" : "N", r.notes || ""].map(csvCell).join(","))).join("\r\n") + "\r\n";
  };
  CLA.downloadFeeTemplate = function (state, current) {
    const blob = new Blob([CLA.feeTemplateCsv(state, current)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cla-fees-" + String(state || "template").toLowerCase() + ".csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // rows for the database RPC (same names as migration 22)
  CLA.feeRowsForRpc = (rows) => rows.map((r) => ({ active: r.active ? "Y" : "N", state: r.state, fee_name: r.feeName, transaction: r.transaction, amount: String(r.amount),
    paid_by: r.paidBy, le_section: r.leSection, default_on: r.defaultOn ? "Y" : "N", notes: r.notes || "" }));

  // What the calculator uses today for CLA fees: the portal's approved rows for "portal" states, else the fee sheet (else the built-in snapshot).
  // -> { rows, sourceOf: {MD: "portal" | "sheet" | "snapshot"}, sheetSource, live: [{state, approvedAt, approvedBy}] }
  CLA.loadCurrentClaFees = async function (A, fetchFn) {
    let grid = null, sheetSource = "sheet";
    try {
      const url = "https://docs.google.com/spreadsheets/d/" + CLA.FEE_SHEET_ID + "/gviz/tq?tqx=out:csv&headers=1&sheet=CLA_Fees";
      const r = await (fetchFn || fetch)(url, { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status);
      grid = CLA.parseCsv(await r.text()); if (!grid.length || !grid[0].map((x) => String(x).trim()).includes("Active")) throw new Error("unexpected content");
    } catch (e) { sheetSource = "snapshot"; grid = (typeof CLA_FEES_SNAPSHOT !== "undefined" && CLA_FEES_SNAPSHOT.CLA_Fees) || []; }
    const sheet = CLA.feeRowsFromSheetGrid(grid);
    let live = [];
    try { live = (A && A.adminListLiveClaFees) ? await A.adminListLiveClaFees() : []; } catch (e) { live = []; }
    const liveStates = [...new Set(live.map((r) => r.state))];
    const rows = sheet.filter((r) => !liveStates.includes(r.state)).concat(live);
    const sourceOf = {}; rows.forEach((r) => (sourceOf[r.state] = liveStates.includes(r.state) ? "portal" : sheetSource));
    const liveInfo = liveStates.sort().map((st) => { const r = live.find((x) => x.state === st); return { state: st, approvedAt: r.approvedAt, approvedBy: r.approvedBy || null }; });
    return { rows, sourceOf, sheetSource, live: liveInfo };
  };
})();
(function () {
  const CLA = window.CLA;
  // a chosen CSV / .xlsx file -> grid (array of arrays). Uses CLA.parseCsv / CLA.parseXlsx from bulk-invite.js.
  CLA.readFeeFile = async function (file) {
    if (!file) throw new Error("Choose a file first.");
    if (file.size > CLA.FEE_FILE_MAX_BYTES) throw new Error("This file is over 1 MB. Upload at most " + CLA.FEE_UPLOAD_MAX + " fee rows as a CSV or .xlsx.");
    const name = String(file.name || "").toLowerCase();
    const isXlsx = name.endsWith(".xlsx") || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const isCsv = name.endsWith(".csv") || file.type === "text/csv" || file.type === "text/plain" || !name;
    if (!isXlsx && !isCsv) throw new Error("Use a CSV or Excel (.xlsx) file. Download the template if you need it.");
    if (isXlsx) return CLA.parseXlsx(await file.arrayBuffer());
    const text = typeof file.text === "function" ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
    return CLA.parseCsv(text);
  };
})();
