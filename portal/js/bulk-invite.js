/* Upload-clients helpers: CSV / Excel parse and preview classification.
 * Used by portal/admin.html. No network. Depends on CLA.normalizePhone / CLA.PHONE_MSG (auth-adapter.js). */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  CLA.BULK_INVITE_MAX = 50;
  CLA.BULK_INVITE_HEADERS = ["first_name", "last_name", "email", "cell_phone", "company", "rep_email"];
  CLA.clientUploadTemplateCsv = function () {
    const h = CLA.BULK_INVITE_HEADERS.join(",");
    const sample = ["Maya", "Chen", "maya.chen@example.com", "(240) 555-0142", "Chen Realty", "sample.rep.jane@clatitle.com"].join(",");
    return h + "\n" + sample + "\n";
  };
  CLA.downloadClientUploadTemplate = function () {
    const blob = new Blob([CLA.clientUploadTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cla-client-invite-template.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const ALIAS = {
    first_name: ["first_name", "first", "firstname", "first name", "given_name", "given name"],
    last_name: ["last_name", "last", "lastname", "last name", "surname", "family_name"],
    email: ["email", "e-mail", "email_address", "email address", "client_email", "client email"],
    cell_phone: ["cell_phone", "cell", "cellphone", "cell phone", "mobile", "mobile_phone", "phone", "phone_number"],
    company: ["company", "company_name", "company name", "brokerage", "firm"],
    rep_email: ["rep_email", "rep", "rep email", "sales_rep", "sales rep", "sales_rep_email", "sales rep email", "repemail"],
  };
  const keyOf = (h) => {
    const k = String(h || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    for (const col of CLA.BULK_INVITE_HEADERS) if (ALIAS[col].includes(k) || ALIAS[col].includes(String(h || "").trim().toLowerCase())) return col;
    return null;
  };

  // RFC-style CSV: commas, quoted fields, "" escapes, CRLF. A BOM is ignored.
  CLA.parseCsv = function (text) {
    const s = String(text || "").replace(/^\uFEFF/, "");
    const rows = []; let row = [], field = "", i = 0, q = false;
    const pushField = () => { row.push(field); field = ""; };
    const pushRow = () => { if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row); row = []; };
    while (i < s.length) {
      const c = s[i];
      if (q) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ",") { pushField(); i++; continue; }
      if (c === "\n") { pushField(); pushRow(); i++; continue; }
      if (c === "\r") { i++; continue; }
      field += c; i++;
    }
    if (q) throw new Error("This CSV has an unclosed quote. Check the file and try again.");
    if (field !== "" || row.length) { pushField(); pushRow(); }
    return rows;
  };

  function rowsFromGrid(grid) {
    if (!grid.length) throw new Error("This file is empty.");
    const map = {};
    grid[0].forEach((h, i) => { const k = keyOf(h); if (k && map[k] === undefined) map[k] = i; });
    if (map.email === undefined || map.rep_email === undefined) {
      throw new Error("This file needs an email column and a rep_email column. Download the template if you need it.");
    }
    const out = [];
    for (let r = 1; r < grid.length; r++) {
      const line = grid[r] || [];
      const get = (k) => String(line[map[k]] == null ? "" : line[map[k]]).trim();
      const rec = { first_name: get("first_name"), last_name: get("last_name"), email: get("email"),
        cell_phone: get("cell_phone"), company: get("company"), rep_email: get("rep_email") };
      if (CLA.BULK_INVITE_HEADERS.every((k) => !rec[k])) continue;   // skip blank lines
      rec._line = r + 1;
      out.push(rec);
    }
    return out;
  }

  CLA.rowsFromGrid = rowsFromGrid;

  // Minimal first-sheet reader for .xlsx (ZIP of XML). No library, no CDN.
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") throw new Error("This browser cannot read Excel files. Save the sheet as a CSV and try again.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function zipEntries(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    const min = Math.max(0, u8.length - 22 - 65535);
    for (let i = u8.length - 22; i >= min; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("That file is not a valid Excel spreadsheet. Try saving it as a CSV.");
    const cdOff = view.getUint32(eocd + 16, true), cdCnt = view.getUint16(eocd + 10, true);
    const files = {}; let p = cdOff;
    const dec = new TextDecoder();
    for (let n = 0; n < cdCnt; n++) {
      if (u8[p] !== 0x50 || u8[p + 1] !== 0x4b || u8[p + 2] !== 0x01 || u8[p + 3] !== 0x02) break;
      const method = view.getUint16(p + 10, true);
      const comp = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const name = dec.decode(u8.slice(p + 46, p + 46 + nameLen));
      const lnLen = view.getUint16(localOff + 26, true);
      const leLen = view.getUint16(localOff + 28, true);
      const data = u8.slice(localOff + 30 + lnLen + leLen, localOff + 30 + lnLen + leLen + comp);
      files[name] = { method, data };
      p += 46 + nameLen + extraLen + commLen;
    }
    return files;
  }
  async function zipText(files, name) {
    const ent = files[name]; if (!ent) return "";
    const bytes = ent.method === 0 ? ent.data : ent.method === 8 ? await inflateRaw(ent.data)
      : (() => { throw new Error("This spreadsheet uses an unsupported compression. Save it as a CSV and try again."); })();
    return new TextDecoder("utf-8").decode(bytes);
  }
  const xmlText = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  function sharedStrings(xml) {
    const out = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(xml))) {
      const parts = []; const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let t;
      while ((t = tr.exec(m[1]))) parts.push(xmlText(t[1]));
      out.push(parts.join(""));
    }
    return out;
  }
  function colRow(ref) {
    const m = /^([A-Z]+)(\d+)$/i.exec(String(ref || "")); if (!m) return null;
    let c = 0; const letters = m[1].toUpperCase();
    for (let i = 0; i < letters.length; i++) c = c * 26 + (letters.charCodeAt(i) - 64);
    return { c: c - 1, r: +m[2] - 1 };
  }
  function sheetGrid(xml, sst) {
    const grid = [];
    const rows = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
    rows.forEach((rowXml) => {
      const cells = rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || [];
      cells.forEach((cell) => {
        const ref = (cell.match(/\br="([^"]+)"/) || [])[1];
        const pos = colRow(ref); if (!pos) return;
        const t = (cell.match(/\bt="([^"]+)"/) || [])[1] || "";
        let val = "";
        if (t === "inlineStr") val = xmlText(((cell.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/) || [])[1]) || "");
        else if (t === "s") { const i = +(((cell.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/) || [])[1]) || ""); val = sst[i] || ""; }
        else val = xmlText(((cell.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/) || [])[1]) || "");
        if (!grid[pos.r]) grid[pos.r] = [];
        grid[pos.r][pos.c] = val;
      });
    });
    return grid.map((r) => { const row = r || []; const len = row.length; const out = []; for (let i = 0; i < len; i++) out[i] = row[i] == null ? "" : String(row[i]); return out; }).filter((r) => r.some((c) => String(c).trim()));
  }
  CLA.parseXlsx = async function (buf) {
    const files = zipEntries(buf);
    const sst = sharedStrings(await zipText(files, "xl/sharedStrings.xml"));
    const wb = await zipText(files, "xl/workbook.xml");
    const rels = await zipText(files, "xl/_rels/workbook.xml.rels");
    const firstId = ((wb.match(/<sheet\b[^>]*r:id="([^"]+)"/) || wb.match(/<sheet\b[^>]*\bid="([^"]+)"/)) || [])[1];
    let path = "xl/worksheets/sheet1.xml";
    if (firstId) {
      const esc = firstId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const relMatch = rels.match(new RegExp("Id=\"" + esc + "\"[^>]*Target=\"([^\"]+)\""))
        || rels.match(new RegExp("Target=\"([^\"]+)\"[^>]*Id=\"" + esc + "\""));
      if (relMatch) {
        const target = relMatch[1] || "";
        path = target.startsWith("/") ? target.replace(/^\//, "") : ("xl/" + target.replace(/^\.\//, ""));
      }
    }
    const sheet = await zipText(files, path) || await zipText(files, "xl/worksheets/sheet1.xml");
    if (!sheet) throw new Error("This spreadsheet has no sheet I can read. Save it as a CSV and try again.");
    return sheetGrid(sheet, sst);
  };

  CLA.parseClientUploadFile = async function (file) {
    if (!file) throw new Error("Choose a file first.");
    const name = String(file.name || "").toLowerCase();
    const isXlsx = name.endsWith(".xlsx") || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const isCsv = name.endsWith(".csv") || file.type === "text/csv" || file.type === "text/plain" || !name;
    if (!isXlsx && !isCsv && name.endsWith(".xls")) throw new Error("Please save the file as .xlsx or .csv and try again.");
    if (!isXlsx && !isCsv) throw new Error("Use a CSV or Excel (.xlsx) file. Download the template if you need it.");
    if (isXlsx) return rowsFromGrid(await CLA.parseXlsx(await file.arrayBuffer()));
    const text = typeof file.text === "function" ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
    return rowsFromGrid(CLA.parseCsv(text));
  };

  // Preview classification (same rules the database uses). `users` is adminListUsers().
  CLA.classifyClientUpload = function (rows, users) {
    const max = CLA.BULK_INVITE_MAX;
    if (rows.length > max) {
      return { error: "This file has " + rows.length + " rows. Upload at most " + max + " at a time.", rows: [], counts: { invite: 0, skip: 0, reject: 0, total: rows.length } };
    }
    const byEmail = {};
    (users || []).forEach((u) => { if (u && u.email) byEmail[String(u.email).toLowerCase()] = u; });
    const isRepCapable = (u) => !!u && u.status === "active" && (u.role === "rep" || ((u.role === "admin" || u.role === "super_admin") && !!u.isRep));
    const seen = {};
    const out = (rows || []).map((raw, i) => {
      const email = String(raw.email || "").trim().toLowerCase();
      const repEmail = String(raw.rep_email || raw.repEmail || "").trim().toLowerCase();
      const firstName = String(raw.first_name || raw.firstName || "").trim();
      const lastName = String(raw.last_name || raw.lastName || "").trim();
      const company = String(raw.company || raw.company_name || raw.companyName || "").trim();
      const cellRaw = String(raw.cell_phone || raw.cellPhone || "").trim();
      let status = "invite", reason = null, cellPhone = null, rep = null;
      if (!email) { status = "reject"; reason = "Email is required."; }
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { status = "reject"; reason = "Enter a valid email address."; }
      else if (seen[email]) { status = "reject"; reason = "Duplicate email in this file."; }
      else if (firstName.length > 80) { status = "reject"; reason = "First name is too long (80 characters at most)."; }
      else if (lastName.length > 80) { status = "reject"; reason = "Last name is too long (80 characters at most)."; }
      else if (company.length > 160) { status = "reject"; reason = "Company is too long (160 characters at most)."; }
      else if (cellRaw) {
        const n = CLA.normalizePhone(cellRaw);
        if (n === null) { status = "reject"; reason = CLA.PHONE_MSG.replace(/\.$/, ""); }
        else cellPhone = n || null;
      }
      if (status === "invite") {
        if (!repEmail) { status = "reject"; reason = "A sales rep email is required."; }
        else {
          const u = byEmail[repEmail];
          if (!u) { status = "reject"; reason = "No sales rep has that email."; }
          else if (u.status && u.status !== "active") { status = "reject"; reason = "That sales rep is disabled."; }
          else if (!isRepCapable(u)) { status = "reject"; reason = "That email is not a sales rep."; }
          else rep = u;
        }
      }
      if (status === "invite" && byEmail[email]) { status = "skip"; reason = "This email already has an account."; rep = null; }
      if (email) seen[email] = true;
      return { index: i + 1, firstName, lastName, email, cellPhone, cellRaw, company, repEmail, repId: rep ? rep.id : null, rep, status, reason };
    });
    const counts = { invite: 0, skip: 0, reject: 0, total: out.length };
    out.forEach((r) => { if (r.status === "invite") counts.invite++; else if (r.status === "skip") counts.skip++; else counts.reject++; });
    return { error: null, rows: out, counts };
  };
})();
