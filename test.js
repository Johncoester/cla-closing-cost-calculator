const fs=require("fs"),assert=require("assert");const src=fs.readFileSync("index.html","utf8");
const js=src.split("<script>")[1].split("</script>")[0];const zjs=fs.readFileSync("zip-county.js","utf8"),sjs=fs.readFileSync("fee-snapshot.js","utf8");
const strip=s=>s.replace(/if\(typeof module[^\n]*/,"");const m={exports:{}};new Function("module",strip(zjs)+"\n"+strip(sjs)+"\n"+js)(m);
const X=m.exports,R=X.normalize(X.SNAP);let fails=0;const ok=(c,msg)=>{if(!c){fails++;console.error("FAIL",msg)}else console.log("ok",msg)};
const near=(a,b,t=0.01)=>Math.abs(a-b)<=t;const X_fmt=x=>"$"+(+x).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fees=(st,type)=>X.claFees(R,st,type).map(f=>({name:f["Fee Name"],payer:f["Paid By"],sec:f["LE Section"],amt:+f.Amount}));
const inp=o=>Object.assign({type:"purchase",state:"MD",county:"Montgomery",uw:"Fidelity National Title",price:450000,loan:360000,payoff:300000,pol:"enhanced",rate:"basic",fthb:false,occ:true,ownPay:"",pres:"trid",ends:[],docs:X.DOC_DEFAULTS[o.type||"purchase"]},o,{fees:o.fees||fees(o.state||"MD",o.type||"purchase")});
const line=(r,re)=>r.lines.filter(l=>re.test(l.item)).reduce((a,l)=>a+l.b+l.s,0);
// counties / ZIP
for(const[st,n]of[["MD",24],["VA",133],["DC",1],["FL",67]]){const l=X.allCounties(R,st);ok(l.length===n,`${st} has ${n} counties (got ${l.length})`)}
for(const[z,st,co]of[["20850","MD","Montgomery"],["21201","MD","Baltimore City"],["22030","VA","Fairfax"],["20001","DC","District of Columbia"],["33101","FL","Miami-Dade"],["32801","FL","Orange"],["21704","MD","Frederick"],["21740","MD","Washington"],["20646","MD","Charles"],["22601","VA","Winchester City"],["34102","FL","Collier"]]){const r=X.zipLookup(z);ok(r&&r.state===st&&r.county===co,`ZIP ${z} -> ${co}, ${st}`)}
ok(X.zipLookup("90210")===null,"out-of-area ZIP -> null");
// CSV parsing
const csv='"Active","State","Fee Name","Amount"\n"Y","MD","Fee, with comma","1,075"\n"N","MD","Off","5"\n"Y","VA","Say ""hi""","10"\r\n';
const rows=X.parseCSV(csv);ok(rows.length===4&&rows[1][2]==="Fee, with comma"&&rows[3][2]==='Say "hi"',"parseCSV handles quotes, commas, CRLF");
const N=X.normalize({CLA_Fees:rows});ok(N.CLA_Fees.length===2&&N.CLA_Fees[0].Amount==="1,075","normalize keeps Active=Y rows only");
// Montgomery tiered recordation (reference: $800k ≈ $9,938; $9,048 with owner-occupant exemption)
const mo=o=>X.taxAmount&&X.calc(R,inp(Object.assign({county:"Montgomery",price:800000,loan:640000,ends:[],fees:[]},o)));
const recNoEx=line(mo({occ:false}),/County recordation/),recEx=line(mo({occ:true}),/County recordation/);
ok(near(recNoEx,9938),`Montgomery $800k recordation = ${recNoEx} (expect 9938)`);ok(near(recEx,9048),`Montgomery $800k owner-occupied = ${recEx} (expect 9048)`);
// MD FTHB: state transfer 0.25% paid by seller
const f=X.calc(R,inp({price:400000,fthb:true}));const st=f.lines.find(l=>/State transfer/.test(l.item));ok(st&&st.b===0&&near(st.s,1000),"MD FTHB state transfer 0.25% all seller");
// DC brackets + FTHB
const dc=p=>X.calc(R,inp({state:"DC",county:"District of Columbia",price:p,fees:[]}));
ok(near(line(dc(399000),/Deed recordation/),4389),"DC $399k recordation 1.1% whole");ok(near(line(dc(500000),/Deed recordation/),7250),"DC $500k recordation 1.45% whole");
ok(near(line(X.calc(R,inp({state:"DC",county:"District of Columbia",price:500000,fthb:true,fees:[]})),/Deed recordation/),3625),"DC FTHB recordation 0.725%");
// VA NoVA fees only in PD8
const va=c=>X.calc(R,inp({state:"VA",county:c,price:500000,loan:400000,fees:[]}));
ok(near(line(va("Fairfax"),/congestion/),500)&&line(va("Richmond City"),/congestion/)===0,"VA congestion fee NoVA only");
// FL promulgated premium, simultaneous issue, TRID presentation, Miami-Dade stamps
const fl=X.calc(R,inp({state:"FL",county:"Orange",price:400000,loan:320000,pres:"actual",fees:[]}));
ok(near(fl.premiums.owner,2075),`FL owner's $400k = ${fl.premiums.owner} (69O-186.003 → 2075)`);ok(near(fl.premiums.lenderActual,25),"FL simultaneous lender's $25");
const flT=X.calc(R,inp({state:"FL",county:"Orange",price:400000,loan:320000,pres:"trid",fees:[]}));
ok(near(line(flT,/Lender's Title/),fl.premiums.lenderFull)&&near(line(flT,/Owner's Title/),2075+25-fl.premiums.lenderFull)&&near(flT.total,fl.total),"TRID: lender full, owner = owner+sim−full, same total");
ok(near(line(X.calc(R,inp({state:"FL",county:"Miami-Dade",price:400000,fees:[]})),/Doc stamps on deed/),2400)&&near(line(fl,/Doc stamps on deed/),2800),"FL deed stamps 0.70 / Miami-Dade 0.60");
ok(near(line(fl,/Recording fees – Deed$/),10+2*8.5),"FL recording $10 + $8.50/page (3-page deed default)");
// MD/VA/DC premiums are placeholders → warning, no invented numbers
ok(X.calc(R,inp({})).warnings.some(w=>/premium rates for MD/.test(w)),"MD premium placeholder warning");
// ---------- Lodestar regression (CLA quotes on clatitle.com, Rounded on; deed 3 pages, DOT 30 pages) ----------
// Each quote uses the default-on CLA fees and endorsements, exactly as the page loads them. ±$1 for Lodestar rounding.
const dflt=(st,type)=>X.claFees(R,st,type).filter(f=>f["Default On"]!=="N").map(f=>({name:f["Fee Name"],payer:f["Paid By"],tx:f.Transaction,sec:f["LE Section"],amt:+f.Amount}));
const dEnds=(st,type)=>R.Endorsements.filter(e=>e.State===st&&e["Default On"]==="Y"&&(String(e.Transaction)==="Both"||(type==="refi"?/^refi/i.test(e.Transaction):e.Transaction==="Purchase"))&&!(type==="cash"&&e["Applies To"]==="Lender")).map(e=>e.Code);
const Q=o=>{const type=o.type||"purchase";return X.calc(R,inp(Object.assign({fees:dflt(o.state,type),ends:dEnds(o.state,type)},o)))};
const bs=(r,re,col)=>r.lines.filter(l=>re.test(l.item)).reduce((a,l)=>a+l[col],0);
const expect=(name,r,rows)=>{for(const[re,col,v,t=1]of rows){const got=bs(r,re,col);ok(near(got,v,t),`${name}: ${re.source} ${col==="b"?"buyer":"seller"} ${got} ≈ Lodestar ${v}`)}};
const absent=(name,r,re)=>ok(!r.lines.some(l=>re.test(l.item)),`${name}: no ${re.source} line`);
const CLA_SELLER=[[/Doc Preparation/,"s",205],[/Notary/,"s",150],[/Qualia/,"s",59],[/Settlement Fee/,"s",670],[/Title Review/,"s",75]];
const CLA_BUYER=(cpl)=>[[/CPL \(Lender\)/,"b",cpl],[/Notary/,"b",200],[/Qualia/,"b",59],[/Settlement Fee/,"b",1075],[/Title Review/,"b",75],[/Title Search/,"b",300]];
// Q1 MD Montgomery purchase $450k/$360k owner-occupied
const q1=Q({state:"MD",county:"Montgomery",price:450000,loan:360000});
expect("Q1",q1,[...CLA_BUYER(50),[/Recording fees – Deed$/,"b",60],[/Recording fees – Deed of Trust/,"b",60],[/State transfer/,"b",1125],[/County transfer/,"b",2250],[/County recordation/,"b",1558],...CLA_SELLER]);
ok(q1.warnings.some(w=>/owner's premium rates for MD/.test(w))&&q1.premiums.lenderFull==null,"Q1: MD Fidelity premiums not loaded (Lodestar lender's 1,232 / owner's H 1,775 kept as data points)");
// Q3 MD Montgomery refi $360k loan, $300k payoff
const q3=Q({type:"refi",state:"MD",county:"Montgomery",loan:360000,payoff:300000});
expect("Q3",q3,[[/CPL/,"b",50],[/E-recording/,"b",10],[/Notary/,"b",150],[/Processing Fee/,"b",450],[/Qualia/,"b",59],[/Settlement Fee/,"b",450],[/Shipping/,"b",35],[/Tax Cert/,"b",10],[/Title Review/,"b",150],[/Title Search/,"b",150],[/Recording fees/,"b",110],[/County recordation/,"b",534]]);
ok(q3.seller===0&&!q3.lines.some(l=>/Doc Preparation/.test(l.item)),"Q3: refi bills no seller rows");
ok(near(bs(q3,/E-recording/,"b"),4.75*2),"Q3: e-recording = $4.75 × 2 recorded docs");
// Q4 DC purchase $450k/$360k
const q4=Q({state:"DC",county:"District of Columbia",price:450000,loan:360000});
expect("Q4",q4,[...CLA_BUYER(50),[/Lender's Title/,"b",1554],[/Recording fees – Deed$/,"b",30],[/Recording fees – Deed of Trust/,"b",155],[/Deed recordation/,"b",6525],...CLA_SELLER,[/Deed transfer/,"s",6525]]);
ok(q4.lines.filter(l=>/Qualia/.test(l.item)&&l.b>0).length===1&&q4.lines.filter(l=>/Qualia/.test(l.item)&&l.s>0).length===1,"Q4: DC Qualia charged once to buyer, once to seller");
const q4r=Q({type:"refi",state:"DC",county:"District of Columbia",loan:360000,payoff:300000});ok(q4r.lines.filter(l=>/Qualia/.test(l.item)).length===1&&near(bs(q4r,/Qualia/,"b"),59),"DC refi: Qualia once to borrower");
// Q5 MD Frederick purchase $500k/$400k
const q5=Q({state:"MD",county:"Frederick",price:500000,loan:400000});
expect("Q5",q5,[...CLA_BUYER(50),[/Recording fees – Deed$/,"b",81],[/Recording fees – Deed of Trust/,"b",60],[/County recordation/,"b",3500],[/State transfer/,"b",1250],[/County recordation/,"s",3500],[/State transfer/,"s",1250],...CLA_SELLER]);
absent("Q5",q5,/County transfer/);
// Q6 VA Fairfax purchase $500k/$400k
const q6=Q({state:"VA",county:"Fairfax",price:500000,loan:400000});
expect("Q6",q6,[...CLA_BUYER(35),[/Recording fees – Deed$/,"b",55],[/Recording fees – Deed of Trust/,"b",68],[/State grantee/,"b",1250],[/Local grantee/,"b",417],[/State recordation tax \(deed of trust\)/,"b",1000],[/Local recordation tax \(deed of trust\)/,"b",333],[/Grantor tax/,"s",500],[/congestion|WMATA/,"s",1000],...CLA_SELLER]);
// Q7 FL Orange purchase $400k/$320k
const q7=Q({state:"FL",county:"Orange",price:400000,loan:320000});
expect("Q7",q7,[[/ALTA 8\.1/,"b",25],[/Lender's Title/,"b",1675],[/Notary/,"b",200],[/Qualia/,"b",59],[/Settlement Fee/,"b",1100],[/Title Search/,"b",200],[/Recording fees – Deed$/,"b",27],[/Recording fees – Deed of Trust/,"b",257],[/Doc stamps on note/,"b",1120],[/Intangible/,"b",640],[/Doc stamps on deed/,"s",2800],[/Notary/,"s",200],[/Qualia/,"s",59],[/Settlement Fee/,"s",950]]);
absent("Q7",q7,/CPL/);absent("Q7",q7,/Title Review/);
ok(near(bs(q7,/ALTA 9/,"b"),210),"Q7: FL Form 9 = 10% × (owner's 2,075 + simultaneous 25) = 210 per 69O-186.005(9) (Lodestar 289 uses its 2,490 + 400)");
ok(near(q7.premiums.owner,2075)&&near(q7.premiums.lenderActual,25),"Q7: FL promulgated owner's 2,075 / simultaneous 25 (Lodestar 2,490 / 400 not copied)");
const q7b=Q({state:"FL",county:"Orange",price:400000,loan:320000,buyerPaysSellerTax:true});ok(near(bs(q7b,/Doc stamps on deed/,"b"),2800)&&bs(q7b,/Doc stamps on deed/,"s")===0,"Q7: 'buyer pays seller's deed tax' toggle moves FL deed stamps to buyer (Lodestar default)");
// cash deals: no lender-only charges
for(const[st,co]of[["MD","Montgomery"],["VA","Fairfax"],["DC","District of Columbia"],["FL","Orange"]]){const c=Q({type:"cash",state:st,county:co,price:450000,loan:0});
 ok(!c.lines.some(l=>/CPL|Lender's Title|Deed of Trust|ALTA (8\.1|9)/.test(l.item)),`cash ${st}: no CPL, lender's policy, lender endorsements or DOT recording`)}
// refi: a Seller-paid row is never billed to the borrower
ok(X.calc(R,inp({type:"refi",fees:[{name:"Doc Preparation Fee",payer:"Seller",amt:205},{name:"Notary",payer:"Borrower",amt:150}]})).lines.every(l=>!/Doc Preparation/.test(l.item)),"refi skips Seller-paid fee rows");
ok(X.claFees(R,"MD","refi").every(f=>f["Paid By"]!=="Seller")&&X.claFees(R,"MD","cash").every(f=>!X.lenderOnly(f)),"fee lists: no seller rows on refi, no lender-only rows on cash");
// Processing fee re-added on refis in every state
for(const st of["MD","VA","DC","FL"])ok(X.claFees(R,st,"refi").some(f=>/Processing Fee/.test(f["Fee Name"])&&+f.Amount===450),`${st} refi processing fee $450`);
// no blank LE Section / Default On
ok(R.CLA_Fees.every(f=>String(f["LE Section"]).trim()&&/^[YN]$/.test(String(f["Default On"]).trim())),"CLA_Fees: every active row has LE Section and Default On");
// Lodestar Fidelity premium data points (MD/VA/DC). No public FNTIC MD/VA rate manual and no DC owner's schedule were found,
// so those tiers stay Active=N; DC loan tiers come from DC DISB's published Fidelity National rates. When a schedule is loaded,
// these assertions switch from "not loaded → warning" to "must match Lodestar ±$1".
const LP=[{q:"Q1",state:"MD",county:"Montgomery",price:450000,loan:360000,lenderFull:1232,ownerH:1775},
 {q:"Q3",type:"refi",state:"MD",county:"Montgomery",loan:360000,payoff:300000,lenderFull:758},
 {q:"Q4",state:"DC",county:"District of Columbia",price:450000,loan:360000,lenderFull:1554,ownerH:1530},
 {q:"Q5",state:"MD",county:"Frederick",price:500000,loan:400000,lenderFull:1360,ownerFull:3009,sim:275,ownerH:1924},
 {q:"Q6",state:"VA",county:"Fairfax",price:500000,loan:400000,lenderFull:1247,ownerFull:2517,sim:200,ownerH:1470}];
for(const d of LP){const r=Q(d),P=r.premiums;
 ok(P.lenderFull==null?r.warnings.some(w=>/lender's premium/.test(w)):near(P.lenderFull,d.lenderFull,1),`${d.q} ${d.state} lender's: ${P.lenderFull??"not loaded"} (Lodestar ${d.lenderFull})`);
 if(d.ownerH)ok(P.owner==null?r.warnings.some(w=>/owner's premium/.test(w)):near(bs(r,/Owner's Title/,"b")+bs(r,/Owner's Title/,"s"),d.ownerH,1),`${d.q} ${d.state} owner's (H): ${P.owner==null?"not loaded":bs(r,/Owner's Title/,"b")+bs(r,/Owner's Title/,"s")} (Lodestar ${d.ownerH})`);
 if(d.ownerFull)ok(P.owner==null||near(P.owner,d.ownerFull,1),`${d.q} full owner's ${P.owner??"not loaded"} (Lodestar ${d.ownerFull}, simultaneous ${d.sim})`)}
// every county × transaction calculates
let bad=0,cnt=0;for(const s of["MD","VA","DC","FL"])for(const co of X.allCounties(R,s))for(const type of["purchase","cash","refi"]){cnt++;try{const r=X.calc(R,inp({type,state:s,county:co}));
 if(!(r.total>0)||r.warnings.some(w=>/No (recording|transfer)/.test(w))||!r.lines.every(l=>isFinite(l.b)&&isFinite(l.s)))throw Error(r.warnings.join(";"))}catch(e){bad++;console.error("calc fail",s,co,type,e.message)}}
ok(bad===0,`all ${cnt} county/type calcs succeed`);
// ---------- Seller Net Sheet ----------
// Reuses calc's seller column. Lodestar "Seller's Net Sheet" references (2.5% + 2.5% commissions, no payoff, no taxes, owner's policy NOT paid by seller).
const SN=o=>X.sellerNet(R,Object.assign({state:"MD",county:"Frederick",uw:"Fidelity National Title",price:500000,closing:"2026-10-23",buyerComm:{mode:"pct",val:2.5},sellerComm:{mode:"pct",val:2.5}},o));
const lode=(name,r,[comm,gov,title,total,net],t=1)=>{ok(near(r.totals.commissions,comm,t),`${name}: commissions ${r.totals.commissions} ≈ Lodestar ${comm}`);ok(near(r.totals.gov,gov,t),`${name}: gov't tax & fees ${r.totals.gov} ≈ Lodestar ${gov}`);
 ok(near(r.totals.title,title,t),`${name}: title & closing ${r.totals.title} ≈ Lodestar ${title}`);ok(near(r.totalCosts,total,t),`${name}: total seller costs ${r.totalCosts} ≈ Lodestar ${total}`);ok(near(r.net,net,t),`${name}: net proceeds ${r.net} ≈ Lodestar ${net}`)};
const snMD=SN({}),snVA=SN({state:"VA",county:"Fairfax"}),snFLo=SN({state:"FL",county:"Orange",price:400000,ownerPays:false}),snFL=SN({state:"FL",county:"Orange",price:400000});
lode("SN MD Frederick $500k",snMD,[25000,4750,1159,30909,469091]);
lode("SN VA Fairfax $500k",snVA,[25000,1500,1159,27659,472341]);
lode("SN FL Orange $400k (owner's policy not seller-paid)",snFLo,[20000,2800,1209,24009,375991],0.01);
// FL: our local custom for Orange is seller-paid owner's policy ($2,075 promulgated), which Lodestar's unchecked box omits
ok(X.ownerPayDefault(R,"FL","Orange")==="Seller"&&X.ownerPayDefault(R,"MD","Frederick")==="Buyer"&&X.ownerPayDefault(R,"VA","Fairfax")==="Buyer","owner's policy local custom: FL Orange seller; MD Frederick, VA Fairfax buyer");
ok(near(snFL.totals.title-snFLo.totals.title,2075)&&near(snFL.totalCosts,26084)&&near(snFL.net,373916)&&snFL.title.some(t=>/Owner's Title/.test(t.item)),"SN FL Orange default (local custom) adds seller-paid owner's policy $2,075 → costs 26,084, net 373,916");
ok(near(snFLo.title.find(t=>/Settlement/.test(t.item)).amt,950)&&snFLo.gov.length===1&&/Doc stamps on deed/.test(snFLo.gov[0].item),"SN FL gov't = deed stamps only; title = notary 200 + Qualia 59 + settlement 950");
ok(near(snMD.gov.reduce((a,x)=>a+x.amt,0),4750)&&snMD.gov.length===2,"SN MD Frederick gov't lines = state transfer 1,250 + county recordation 3,500");
// seller costs equal the quote's seller column for the same inputs (same X.calc)
for(const[n,r,st,co,price,ownPay]of[["MD Frederick",snMD,"MD","Frederick",500000,"Buyer"],["VA Fairfax",snVA,"VA","Fairfax",500000,"Buyer"],["FL Orange",snFL,"FL","Orange",400000,"Seller"]]){
 const quote=X.calc(R,inp({state:st,county:co,price,loan:price*.8,pres:"actual",ownPay,fees:dflt(st,"purchase"),ends:dEnds(st,"purchase")}));
 ok(near(r.totals.gov+r.totals.title,quote.seller),`SN ${n}: net-sheet gov't+title ${r.totals.gov+r.totals.title} = quote seller column ${quote.seller}`)}
for(const[st,co]of[["MD","Frederick"],["VA","Fairfax"],["DC","District of Columbia"]]){const quote=Q({state:st,county:co,price:500000,loan:400000}),sn=SN({state:st,county:co});ok(near(sn.totals.gov+sn.totals.title,quote.seller),`SN ${st} ${co}: equals default quote's seller column (TRID presentation) ${quote.seller}`)}
ok(snMD.totalCosts===snMD.sellerColumn+snMD.totals.commissions&&snMD.net===snMD.price-snMD.totalCosts,"SN identity: costs = commissions + calc seller column; net = price − costs");
// release recording on payoff: $50 each in MD (seller-paid row), one per mortgage
const p1=SN({payoff1:300000}),p2=SN({payoff1:300000,payoff2:50000});
ok(near(p1.gov.find(g=>/Release/.test(g.item)).amt,50)&&near(p2.gov.find(g=>/Release/.test(g.item)).amt,100),"SN MD release recording $50 per payoff ($100 with a 2nd mortgage)");
ok(near(p1.net,469091-50-300000)&&near(p2.net,469091-100-350000)&&p2.payoffs.length===2&&near(p2.payoffTotal,350000),"SN net = price − costs − payoffs (payoffs not counted as costs)");
ok(near(p1.totalCosts,30959),"SN total seller costs exclude the payoff itself (30,909 + $50 release)");
// commissions: % vs flat
const cf=SN({buyerComm:{mode:"flat",val:10000},sellerComm:{mode:"pct",val:3}}),cf2=SN({buyerComm:{mode:"flat",val:12500},sellerComm:{mode:"flat",val:12500}});
ok(cf.totals.commissions===25000&&cf.commissions[0].amt===10000&&cf.commissions[1].amt===15000,"SN commissions: $10,000 flat + 3% of $500k = 25,000");
ok(near(cf2.net,snMD.net)&&near(SN({buyerComm:{mode:"pct",val:0},sellerComm:{mode:"pct",val:0}}).totals.commissions,0)&&near(SN({price:333333,buyerComm:{mode:"pct",val:2.25}}).commissions[0].amt,7499.99),"SN flat $12,500 ×2 = 2.5% ×2; 0% = 0; cents round");
// tax proration (closing Oct 23, 2026; buyer owns the day of closing; 365-day year) — worked examples from title-escrow-reference §11
const PR=(state,annual,paidThrough)=>X.prorateTaxes({state,annual,closing:"2026-10-23",paidThrough});
let x=PR("MD",6000,"2027-06-30");ok(x.days===-251&&near(x.amount,-4126.03)&&!x.assumed,"MD paid through 6/30/2027: buyer credits seller 251 days = $4,126.03");
x=PR("MD",6000);ok(x.assumed&&x.days===-70&&near(x.amount,-1150.68)&&x.paidThrough.toISOString().slice(0,10)==="2026-12-31","MD default (1st half paid, due Sep 30): credit 70 days = $1,150.68");
x=PR("DC",5000);ok(x.days===22&&near(x.amount,301.37),"DC default: seller owes Oct 1–22 = 22 days = $301.37");
x=PR("VA",8000);ok(x.days===114&&near(x.amount,2498.63),"VA (Fairfax) default: seller owes Jul 1–Oct 22 = 114 days = $2,498.63");
x=PR("FL",7008);ok(x.days===295&&near(x.amount,5664.00),"FL default: seller owes Jan 1–Oct 22 = 295 days = $5,664.00");
x=PR("MD",3650,"2026-10-22");ok(x.days===0&&x.amount===0,"paid through the day before closing → nothing due (buyer owns closing day)");
x=PR("MD",3650,"2026-10-23");ok(x.days===-1&&near(x.amount,-10),"paid through the closing day → 1 day credit to seller");
x=PR("MD",3650,"2026-10-12");ok(x.days===10&&near(x.amount,100),"override paid-through date: 10 days × $10 = $100 owed");
ok(X.prorateTaxes({state:"MD",annual:0,closing:"2026-10-23"}).amount===0&&X.prorateTaxes({state:"MD",annual:5000,closing:""}).amount===0,"no taxes or no closing date → no proration");
for(const[d,state,pt]of[["2026-07-15","MD","2026-06-30"],["2026-12-31","MD","2027-06-30"],["2027-02-01","MD","2027-06-30"],["2026-03-31","DC","2026-03-31"],["2026-12-10","VA","2026-12-31"],["2026-12-10","FL","2026-12-31"],["2026-02-10","FL","2025-12-31"]])
 ok(X.defaultPaidThrough(state,new Date(d+"T00:00:00Z")).toISOString().slice(0,10)===pt,`default paid-through ${state} closing ${d} → ${pt}`);
// the proration flows into the sheet: $4,800 annual taxes, MD Frederick, $300k payoff, closing Oct 23 2026
const sp=SN({payoff1:300000,annualTax:4800});
ok(sp.prorations.length===1&&near(sp.totals.pro,-4800*70/365)&&near(sp.net,469091-50-300000+4800*70/365,0.02),`SN taxes $4,800 MD: credit to seller ${sp.totals.pro} → net ${sp.net}`);
const sp2=SN({state:"DC",county:"District of Columbia",annualTax:5000});ok(near(sp2.totals.pro,301.37)&&sp2.prorations[0].amt>0,"SN DC taxes: debit to seller $301.37");
// credits / other costs / HOA / warranty
const oc=SN({concession:{mode:"pct",val:2},hoaDues:150,hoaTransfer:300,special:1000,warranty:500,termination:75,other:[{label:"Roof repair",amt:2500},{label:"",amt:100},{label:"x",amt:0}]});
ok(near(oc.totals.pro,10000+150)&&near(oc.totals.other,300+1000+500+75+2500+100)&&oc.other.some(o=>o.item==="Roof repair")&&oc.other.some(o=>o.item==="Other seller cost"),"SN concession 2% = $10,000; HOA dues; other lines (labels, blank label default, zero skipped)");
ok(near(oc.totalCosts,snMD.totalCosts+10150+4475)&&near(oc.net,snMD.net-10150-4475),"SN totals include prorations/credits and other costs");
ok(near(SN({concession:{mode:"flat",val:3000}}).totals.pro,3000)&&SN({other:Array(8).fill({label:"a",amt:10})}).other.length===5,"SN flat concession; other-cost list capped at 5");
// toggles
ok(SN({bpst:true,state:"FL",county:"Orange",price:400000,ownerPays:false}).totals.gov===0,"SN: buyer-pays-seller's-deed-tax toggle removes FL deed stamps from the seller");
ok(SN({fthb:true,price:400000}).gov.some(g=>/State transfer/.test(g.item)&&near(g.amt,1000))&&near(SN({price:400000}).gov.find(g=>/State transfer/.test(g.item)).amt,1000),"SN MD state transfer at $400k = $1,000 (seller share)");
ok(SN({state:"MD",county:"Frederick",ownerPays:true}).warnings.some(w=>/owner's premium/.test(w))&&!snMD.warnings.some(w=>/owner's premium|lender/.test(w)),"SN MD: missing owner's premium only warns when the seller pays it; never lender warnings");
ok(SN({fees:[]}).totals.title===0&&near(SN({fees:[{name:"Custom",payer:"Seller",amt:100,sec:"C"}]}).totals.title,100),"SN fee list is editable (custom seller fee, none)");
// live loader: fallback + success with mocked fetch
(async()=>{
 const fb=await X.loadFees(async()=>({ok:false,status:401,text:async()=>""}));ok(fb.source==="snapshot"&&/401/.test(fb.error),"fetch 401 -> snapshot fallback");
 const html=await X.loadFees(async()=>({ok:true,status:200,text:async()=>"<html>sign in</html>"}));ok(html.source==="snapshot","login page -> snapshot fallback");
 const toCSV=a=>a.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(",")).join("\n");
 const live=await X.loadFees(async u=>{const t=decodeURIComponent(u.match(/sheet=([^&]+)/)[1]);return{ok:true,status:200,text:async()=>toCSV(X.SNAP[t])}});
 ok(live.source==="sheet"&&X.normalize(live.raw).Transfer_Taxes.length===R.Transfer_Taxes.length,"mock live sheet parsed into same structures");
 ok(near(X.calc(X.normalize(live.raw),inp({price:800000,loan:640000,occ:false})).lines.filter(l=>/County recordation/.test(l.item)).reduce((a,l)=>a+l.b+l.s,0),9938),"CSV-loaded data gives same Montgomery result");
 // DOM
 const{JSDOM}=require("jsdom");const page=src.replace(/<script src="https[^>]+><\/script>/,"").replace(/<script src="zip-county.js[^"]*"><\/script>/,"<script>"+zjs+"</script>").replace(/<script src="fee-snapshot.js[^"]*"><\/script>/,"<script>"+sjs+"</script>");
 const d=new JSDOM(page,{runScripts:"dangerously",beforeParse(w){w.fetch=async()=>({ok:false,status:401,text:async()=>""})}});const errs=[];d.window.addEventListener("error",e=>errs.push(e.message));
 await new Promise(r=>setTimeout(r,50));const w=d.window.document;
 ok(/built-in snapshot/i.test(w.getElementById("status").textContent),"DOM shows snapshot warning when sheet unavailable");
 w.getElementById("zip").value="21704";w.getElementById("zip").dispatchEvent(new d.window.Event("input"));ok(w.getElementById("county").value==="Frederick","DOM ZIP 21704 -> Frederick");
 for(const t of["purchase","cash","refi"]){w.querySelector(`[data-t=${t}]`).click();console.log("DOM",t,w.getElementById("tB").textContent,w.getElementById("tS").textContent,w.getElementById("tA").textContent)}
 ok(w.getElementById("fees").querySelectorAll(".fee").length>0,"DOM CLA fees listed");
 // Seller Net Sheet tab
 const ev=n=>new d.window.Event(n,{bubbles:true}),setv=(id,v)=>{const e=w.getElementById(id);e.value=v;e.dispatchEvent(ev("input"));e.dispatchEvent(ev("change"))};
 const qTot=["tB","tS","tA"].map(i=>w.getElementById(i).textContent).join("|");
 w.querySelector("[data-t=purchase]").click();const qBefore=["tB","tS","tA"].map(i=>w.getElementById(i).textContent).join("|");
 w.querySelector("[data-mode=seller]").click();
 ok(w.getElementById("mainQ").hidden&&!w.getElementById("mainS").hidden&&w.getElementById("s_county").value==="Frederick","DOM seller tab shows; shared county carried over (Frederick)");
 setv("s_price","500000");setv("s_close","2026-10-23");
 ok(w.getElementById("s_bbv").value==="2.5"&&w.getElementById("s_slv").value==="2.5"&&w.getElementById("s_own").checked===false,"DOM commissions default 2.5% / 2.5%; owner's policy default follows local custom (MD: buyer)");
 ok(w.getElementById("sNet").textContent==="$469,091.00","DOM MD Frederick $500k net = $469,091.00 (Lodestar 469,091)");
 setv("s_po1","300000");setv("s_tax","4800");
 ok(w.getElementById("sNet").textContent===X_fmt(sp.net)&&/Release/.test(w.getElementById("sLedger").textContent)&&/credit to seller/.test(w.getElementById("sLedger").textContent),"DOM payoff + taxes: net "+w.getElementById("sNet").textContent);
 setv("s_bbm","flat");setv("s_bbv","10000");ok(/Buyer's broker commission \(flat\)/.test(w.getElementById("sLedger").textContent),"DOM flat commission");
 setv("s_zip","32801");ok(w.getElementById("s_state").value==="FL"&&w.getElementById("s_county").value==="Orange"&&w.getElementById("s_own").checked===true,"DOM seller ZIP 32801 → FL Orange; owner's policy defaults to seller");
 w.getElementById("s_own").checked=false;w.getElementById("s_own").dispatchEvent(ev("change"));ok(/Settlement/.test(w.getElementById("sLedger").textContent)&&!/Owner's Title/.test(w.getElementById("sLedger").textContent),"DOM owner's-policy toggle removes the line");
 setv("s_addr","400 W Church St");ok(/400 W Church St/.test(w.getElementById("s_phAddr").textContent)&&/Selling price/.test(w.getElementById("s_phLine").textContent)&&/Closing date/.test(w.getElementById("s_phLine").textContent),"DOM print header has address, price, closing date");
 for(let k=0;k<5;k++)w.getElementById("s_addo").click();ok(w.querySelectorAll("#s_other .orow").length===5&&w.getElementById("s_addo").hidden,"DOM other-cost lines capped at 5");
 w.querySelector("[data-mode=quote]").click();w.querySelector("[data-t=purchase]").click();
 ok(!w.getElementById("mainQ").hidden&&w.getElementById("mainS").hidden&&w.getElementById("state").value==="FL","DOM back to quote tab (state carried)");
 w.getElementById("zip").value="21704";w.getElementById("zip").dispatchEvent(ev("input"));w.getElementById("price").value="450000";w.getElementById("price").dispatchEvent(ev("input"));
 ok(["tB","tS","tA"].map(i=>w.getElementById(i).textContent).join("|")===qBefore,"DOM quote tab numbers unchanged after using the seller tab: "+qBefore);
ok(errs.length===0,"no DOM errors "+errs);
 if(fails){console.error(fails,"FAILED");process.exit(1)}console.log("ALL PASS")})();
