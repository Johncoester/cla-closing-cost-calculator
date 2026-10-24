const fs=require("fs"),assert=require("assert");const src=fs.readFileSync("index.html","utf8");
const js=src.split("<script>")[1].split("</script>")[0];const zjs=fs.readFileSync("zip-county.js","utf8"),sjs=fs.readFileSync("fee-snapshot.js","utf8");
const strip=s=>s.replace(/if\(typeof module[^\n]*/,"");const m={exports:{}};new Function("module",strip(zjs)+"\n"+strip(sjs)+"\n"+js)(m);
const X=m.exports,R=X.normalize(X.SNAP);let fails=0;const ok=(c,msg)=>{if(!c){fails++;console.error("FAIL",msg)}else console.log("ok",msg)};
const near=(a,b,t=0.01)=>Math.abs(a-b)<=t;
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
 ok(w.getElementById("fees").querySelectorAll(".fee").length>0,"DOM CLA fees listed");ok(errs.length===0,"no DOM errors "+errs);
 if(fails){console.error(fails,"FAILED");process.exit(1)}console.log("ALL PASS")})();
