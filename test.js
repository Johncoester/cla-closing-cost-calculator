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
// MD FTHB: state transfer 0.25% (the sheet's reduced rate); who pays is NOT changed by the first-time-buyer box
const f=X.calc(R,inp({price:400000,fthb:true}));const st=f.lines.find(l=>/State transfer/.test(l.item));ok(st&&near(st.b,500)&&near(st.s,500)&&/first-time buyer/.test(st.item),"MD FTHB state transfer: 0.25% rate (reduced amount $1,000), paid 50/50 by default");
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
// MD, DC and VA Fidelity (FNTIC) premiums are loaded (MD manual eff. 1/7/2026 V2, DC manual eff. 12/6/2023, VA manual eff. 11/6/2024): no premium warnings
ok(!X.calc(R,inp({})).warnings.some(w=>/premium rates for MD/.test(w)),"MD premiums loaded: no MD premium-rate warning");
ok(!X.calc(R,inp({state:"VA",county:"Fairfax"})).warnings.some(w=>/premium rates for VA/.test(w)),"VA premiums loaded: no VA premium-rate warning");
{const pm=(o)=>X.premiums(R,inp(Object.assign({fees:[],pres:"actual"},o)));
 // hand calcs from the FNTIC manuals (basic/reissue/loan bands, $275 MD / $150 DC simultaneous, homeowner's = 120% of basic, to the cent)
 const mdS=pm({price:400000,loan:320000,pol:"standard"}),mdH=pm({price:400000,loan:320000}),mdR=pm({price:400000,loan:320000,pol:"standard",rate:"reissue"}),mdF=pm({type:"refi",loan:360000,payoff:300000});
 ok(near(mdS.owner,2045.5)&&near(mdS.lenderFull,1104)&&near(mdS.lenderActual,275),"MD $400k/$320k standard: owner 2,045.50, loan 1,104.00, simultaneous 275");
 ok(near(mdH.owner,2454.6),"MD $400k homeowner's = 120% of 2,045.50 = 2,454.60 (cents, not rounded up)");ok(near(mdR.owner,1224.5),"MD $400k reissue owner's = 1,224.50");ok(near(mdF.lenderFull,757.5),"MD refi $360k residential refinance = 757.50");
 ok(near(pm({price:400000,loan:450000,pol:"standard"}).lenderActual,435),"MD loan > price: 275 + 160 excess at basic loan rates");ok(near(pm({type:"refi",loan:50000,payoff:40000}).lenderFull,300),"MD loan minimum $300");
 const dS=pm({state:"DC",county:"District of Columbia",price:360000,loan:288000,pol:"standard"}),dH=pm({state:"DC",county:"District of Columbia",price:360000,loan:288000}),dF=pm({state:"DC",county:"District of Columbia",type:"refi",loan:288000,payoff:250000});
 ok(near(dS.owner,1986)&&near(dS.lenderFull,1273.2)&&near(dS.lenderActual,150),"DC $360k/$288k standard: owner 1,986.00, loan 1,273.20, simultaneous 150");
 ok(near(dH.owner,2383.2),"DC homeowner's = 120% of 1,986 = 2,383.20 (cents, not rounded up)");ok(near(dF.lenderFull,763.92),"DC refi $288k residential refinance = 763.92");
 ok(near(pm({state:"DC",county:"District of Columbia",price:360000,loan:288000,pol:"standard",rate:"reissue"}).owner,1191.6),"DC owner's reissue $360k = 1,191.60")}
{const vp=(o)=>X.premiums(R,inp(Object.assign({state:"VA",county:"Fairfax",fees:[],pres:"actual"},o)));
 // hand calcs from the FNTIC VA manual eff. 11/6/2024: owner 4.31/4.08/3.75/2.49/2.21/1.93/1.79, loan 3.20/2.98/2.54/2.05/1.66/1.32/1.16, reissue + refinance = 70%, homeowner's = 120% (to the cent to whole $), simultaneous $200, minimums $250 (homeowner's $300)
 const vS=vp({price:500000,loan:400000,pol:"standard"}),vH=vp({price:500000,loan:400000}),vR=vp({price:500000,loan:400000,pol:"standard",rate:"reissue"}),vF=vp({type:"refi",loan:400000,payoff:350000}),vBig=vp({price:1500000,loan:1200000,pol:"standard"});
 ok(near(vS.owner,2097.5)&&near(vS.lenderFull,1247)&&near(vS.lenderActual,200),"VA $500k/$400k standard: owner 2,097.50, loan 1,247.00, simultaneous 200");
 ok(near(vH.owner,2517),"VA $500k homeowner's = 120% of 2,097.50 = 2,517");ok(near(vR.owner,1468.25),"VA owner's reissue $500k = 70% = 1,468.25");ok(near(vF.lenderFull,872.9),"VA refi $400k residential refinance = 70% of 1,247 = 872.90");
 ok(near(vBig.owner,5217.5)&&near(vBig.lenderFull,3225),"VA $1.5M/$1.2M standard: owner 5,217.50 (1M+ bands), loan 3,225.00");
 ok(near(vp({price:400000,loan:450000,pol:"standard"}).lenderActual,349),"VA loan > price: 200 + 149 excess at loan rates");
 ok(near(vp({price:50000,loan:40000,pol:"standard"}).owner,250)&&near(vp({price:50000,loan:40000}).owner,300)&&near(vp({type:"refi",loan:50000,payoff:40000}).lenderFull,250),"VA minimums: owner 250, homeowner's 300, loan 250")}
// ---------- Melissa Gamble (CLA) 2026-10-26: MD lien certificates, VA paper-filing and open-space fees, MD principal residence ----------
{const rf=(o,re)=>line(X.calc(R,inp(Object.assign({fees:[]},o))),re);
 // MD lien/tax certificate (county treasurer; paid at recording, shown in the deed's recording line): only these counties charge; Anne Arundel is not ordered by CLA
 for(const[co,add]of[["Frederick",25],["Charles",25],["Howard",50],["Harford",50],["Baltimore",55],["Baltimore City",55],["Carroll",40],["Anne Arundel",0],["Montgomery",0],["Prince George's",0],["Calvert",0],["Washington",0]])
  ok(near(rf({county:co},/Recording fees – Deed$/),60+add),`MD ${co}: deed recording = $60 + lien certificate $${add}`);
 // VA $5 clerk paper-filing fee only in the paper-filing localities; $3 open-space fee in the localities she listed (and, for now, everywhere else in the sheet)
 const vaD=co=>rf({state:"VA",county:co},/Recording fees – Deed$/),vaT=co=>rf({state:"VA",county:co},/Recording fees – Deed of Trust/);
 for(const co of["Appomattox","Amelia","Amherst","Alleghany","Bath","Bland","Buchanan","Charlotte","Cumberland","Highland","Lee","Lunenburg","Mathews","Nelson","Patrick","Rappahannock","Russell","Surry"])
  ok(near(vaD(co),26+20+3+1+5)&&near(vaT(co),40+20+3+5),`VA ${co} (paper-filing): deed $55 and deed of trust $68 include the $5`);
 for(const co of["Fairfax","Loudoun","Prince William","Albemarle","Hanover","Henrico","Chesterfield","Fauquier","Culpeper","Rockingham","Augusta","Roanoke","Rockbridge","Frederick","Richmond City","Lynchburg City","Virginia Beach City"])
  ok(near(vaD(co),26+20+3+1)&&near(vaT(co),40+20+3),`VA ${co} (e-recorded, $3 open-space): deed $50 and deed of trust $63, no $5`);
 // Maryland principal residence: an instrument of 10+ pages that is not solely a principal residence records for $115 instead of $60
 const D=(dp,tp)=>({Deed:[1,dp],"Deed of Trust":[1,tp],Release:[0,3],"Power of Attorney":[0,3]});
 const md=(o)=>X.calc(R,inp(Object.assign({fees:[]},o)));
 let r=md({docs:D(3,30)});ok(near(line(r,/Recording fees – Deed$/),60)&&near(line(r,/Recording fees – Deed of Trust/),60),"MD principal residence (default): deed $60, deed of trust (30 pp) $60");
 r=md({occ:false,docs:D(3,30)});ok(near(line(r,/Recording fees – Deed$/),60)&&near(line(r,/Recording fees – Deed of Trust/),115)&&r.lines.some(l=>/10\+ pages, not a principal residence/.test(l.item)),"MD not a principal residence: 3-page deed stays $60; 30-page deed of trust $115, labelled");
 r=md({occ:false,docs:D(9,9)});ok(near(line(r,/Recording fees – Deed$/),60)&&near(line(r,/Recording fees – Deed of Trust/),60),"MD not a principal residence, 9 pages: $60 (the $115 starts at 10 pages)");
 r=md({occ:false,docs:D(10,10)});ok(near(line(r,/Recording fees – Deed( \(|$)/),115)&&near(line(r,/Recording fees – Deed of Trust/),115),"MD not a principal residence, 10 pages: deed $115 and deed of trust $115");
 r=md({occ:true,docs:D(12,40)});ok(near(line(r,/Recording fees – Deed$/),60)&&near(line(r,/Recording fees – Deed of Trust/),60),"MD principal residence stays $60 at any length");
 r=md({county:"Frederick",occ:false,docs:D(12,30)});ok(near(line(r,/Recording fees – Deed( \(|$)/),115+25),"MD Frederick not a principal residence, 12-page deed: $115 + $25 lien certificate");
 r=md({type:"refi",occ:false,docs:X.DOC_DEFAULTS.refi});ok(near(line(r,/Recording fees – Deed of Trust/),115)&&near(line(r,/Recording fees – Release/),50),"MD refinance not a principal residence: deed of trust $115; release unchanged $50");
 r=md({type:"refi",docs:X.DOC_DEFAULTS.refi});ok(near(line(r,/Recording fees – Deed of Trust/),60),"MD refinance of a principal residence: deed of trust $60");
 r=md({occ:false,docs:D(12,30),state:"VA",county:"Fairfax"});ok(!r.lines.some(l=>/not a principal residence/.test(l.item)),"principal-residence rule is Maryland only (VA unchanged)");
 r=md({occ:false,docs:D(12,30),state:"DC",county:"District of Columbia"});ok(!r.lines.some(l=>/not a principal residence/.test(l.item)),"principal-residence rule is Maryland only (DC unchanged)");
}
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
ok(!q1.warnings.some(w=>/premium rates for MD/.test(w))&&near(q1.premiums.lenderFull,1232,1)&&near(bs(q1,/Owner's Title/,"b")+bs(q1,/Owner's Title/,"s"),1775,1),"Q1: MD Fidelity premiums loaded from the FNTIC MD manual: lender's 1,232 and TRID owner's H 1,775 match Lodestar");
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
expect("Q5",q5,[...CLA_BUYER(50),[/Recording fees – Deed$/,"b",85],[/Recording fees – Deed of Trust/,"b",60],[/County recordation/,"b",3500],[/State transfer/,"b",1250],[/County recordation/,"s",3500],[/State transfer/,"s",1250],...CLA_SELLER]);
absent("Q5",q5,/County transfer/);
// Q6 VA Fairfax purchase $500k/$400k
const q6=Q({state:"VA",county:"Fairfax",price:500000,loan:400000});
expect("Q6",q6,[...CLA_BUYER(35),[/Recording fees – Deed$/,"b",50],[/Recording fees – Deed of Trust/,"b",63],[/State grantee/,"b",1250],[/Local grantee/,"b",417],[/State recordation tax \(deed of trust\)/,"b",1000],[/Local recordation tax \(deed of trust\)/,"b",333],[/Grantor tax/,"s",500],[/congestion|WMATA/,"s",1000],...CLA_SELLER]);
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
// Lodestar Fidelity premium data points (MD/VA/DC). MD (FNTIC manual eff. 1/7/2026), DC (FNTIC manual eff. 12/6/2023) and VA (FNTIC manual eff. 11/6/2024)
// are loaded and must match Lodestar ±$1.
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
// ---- per-line payer for transfer / recordation taxes: Seller, Split 50/50 or Buyer ----
{const tl=(r,re)=>r.lines.filter(l=>re.test(l.item));const one=(r,re)=>{const a=tl(r,re);return a.length===1?a[0]:null};
 const tp=(o,pay)=>X.calc(R,inp(Object.assign({state:"MD",county:"Montgomery",price:450000,loan:360000},o,{taxPayers:pay})));
 // defaults are unchanged: MD (non first-time buyer) already comes from the sheet as a 50/50 split; first-time buyer goes to the seller; DC/VA/FL as before
 const d0=tp({}),dTT=one(d0,/County transfer tax/);ok(dTT&&near(dTT.b,2250)&&near(dTT.s,2250)&&/\(split 50\/50\)$/.test(dTT.item),"TS default MD transfer tax stays 50/50 and is labelled (split 50/50)");
 const f0=tp({fthb:true});ok(near(one(f0,/County transfer tax/).s,2250)&&near(one(f0,/County transfer tax/).b,2250)&&near(one(f0,/County recordation tax/).b,1557.5)&&near(one(f0,/State transfer tax/).b,562.5)&&near(one(f0,/State transfer tax/).s,562.5),"FTHB: first-time buyer no longer moves the taxes to the seller: all three MD taxes stay 50/50");
 ok(f0.taxes.every(t=>t.payer==="split"&&t.def==="split")&&JSON.stringify(f0.taxes.map(t=>t.payer))===JSON.stringify(d0.taxes.map(t=>t.payer)),"FTHB: the default payer of every tax is identical with the box ticked or not");
 ok(f0.taxes.every(t=>t.fthbPayer==="seller")&&d0.taxes.every(t=>!t.fthbPayer),"FTHB: the sheet's 'FTHB Paid By = Seller' is only reported (fthbPayer), never applied");
 ok(near(f0.taxes.find(t=>t.name==="State transfer tax").amt,1125)&&near(d0.taxes.find(t=>t.name==="State transfer tax").amt,2250)&&near(f0.taxes.find(t=>t.name==="County transfer tax").amt,4500)&&f0.taxes.find(t=>t.name==="State transfer tax").fthb&&!f0.taxes.find(t=>t.name==="County transfer tax").fthb,"FTHB: the sheet's reduced state transfer rate (0.25%) is kept; amounts without a first-time rate are unchanged and carry no first-time label");
 {const fs0=tp({fthb:true},{"County transfer tax":"seller","State transfer tax":"buyer"});ok(near(one(fs0,/County transfer tax/).s,4500)&&one(fs0,/County transfer tax/).b===0&&near(one(fs0,/State transfer tax/).b,1125)&&one(fs0,/State transfer tax/).s===0,"FTHB: with the box ticked each line can still be set to Seller, Split or Buyer")}
 {const ce=(f)=>X.calc(R,inp({state:"MD",county:"Cecil",price:300000,loan:240000,fthb:f})),ca=(f)=>X.calc(R,inp({state:"MD",county:"Caroline",price:300000,loan:240000,fthb:f})),amt=(r,n)=>r.taxes.find(t=>t.name===n).amt;
  ok(amt(ce(false),"County transfer tax")===1500&&amt(ce(true),"County transfer tax")===750&&ce(true).taxes.every(t=>t.payer==="split"),"FTHB Cecil: the sheet's 0.25% county transfer rate is kept ($1,500 -> $750), still 50/50");
  ok(amt(ca(false),"County transfer tax")===1375&&amt(ca(true),"County transfer tax")===1000&&ca(true).taxes.every(t=>t.payer==="split"),"FTHB Caroline: the sheet's extra $75,000 exemption is kept ($1,375 -> $1,000), still 50/50")}
 {const dcA=X.calc(R,inp({state:"DC",county:"District of Columbia",price:500000,loan:400000,fthb:true,fees:[]})),dcB=X.calc(R,inp({state:"DC",county:"District of Columbia",price:500000,loan:400000,fthb:false,fees:[]}));
  ok(dcA.taxes.find(t=>t.name==="Deed recordation tax").amt===3625&&dcB.taxes.find(t=>t.name==="Deed recordation tax").amt===7250&&dcA.taxes.every((t,k)=>t.payer===dcB.taxes[k].payer)&&dcA.taxes.find(t=>t.name==="Deed recordation tax").payer==="buyer"&&dcA.taxes.find(t=>t.name==="Deed transfer tax").payer==="seller"&&!dcA.taxes.find(t=>t.name==="Deed transfer tax").fthb,"FTHB DC: reduced recordation rate kept ($7,250 -> $3,625), buyer still pays recordation and seller transfer, no label on the transfer tax");
  for(const[st,co]of[["VA","Fairfax"],["FL","Miami-Dade"]]){const a=X.calc(R,inp({state:st,county:co,price:500000,loan:400000,fthb:true})),b=X.calc(R,inp({state:st,county:co,price:500000,loan:400000,fthb:false}));ok(JSON.stringify(a.lines)===JSON.stringify(b.lines)&&a.taxes.every(t=>!t.fthb),`FTHB ${st}: ticking first-time buyer changes nothing (amounts, payers, labels)`)}}
 ok(!d0.taxes.some(t=>t.payer==="buyer")&&d0.taxes.every(t=>t.adjustable),"TS result lists each tax line with its payer; MD deed taxes are adjustable");
 // each choice, on each tax, for each state
 for(const[st,co,price,loan]of[["MD","Montgomery",450000,360000],["MD","Baltimore City",300000,240000],["DC","District of Columbia",450000,360000],["VA","Fairfax",450000,360000],["FL","Orange",450000,360000]]){
  const base=X.calc(R,inp({state:st,county:co,price,loan})),names=base.taxes.filter(t=>t.adjustable).map(t=>t.name);ok(names.length>=1,`TS ${st} ${co}: adjustable tax lines found (${names.join(", ")})`);
  for(const n of names){const tot=base.taxes.find(t=>t.name===n).amt;
   for(const v of["seller","split","buyer"]){const r=X.calc(R,inp({state:st,county:co,price,loan,taxPayers:{[n]:v}})),l=r.lines.find(x=>x.item.startsWith(n));
    const sellerOnly=v==="seller",buyerOnly=v==="buyer";
    ok(l&&near(l.b+l.s,tot,0.0001)&&(sellerOnly?l.b===0:buyerOnly?l.s===0:near(l.b,l.s,0.011)),`TS ${st} ${co} ${n} -> ${v}: ${l&&l.b}/${l&&l.s} adds up to ${tot}`);
    if(v==="split")ok(/\(split 50\/50\)$/.test(l.item),`TS ${st} ${n} split label`);
    // nothing else moves
    const rest=x=>x.lines.filter(y=>!y.item.startsWith(n)).map(y=>y.item+y.b+"|"+y.s).join(";");ok(rest(r)===rest(base),`TS ${st} ${n} ${v}: all other lines unchanged`)}}}
 // totals follow the choice: buyer, seller and all-parties
 {const a=tp({},{"County transfer tax":"seller"}),b=tp({},{"County transfer tax":"buyer"}),c=tp({},{"County transfer tax":"split"});
  ok(near(a.buyer-d0.buyer,-2250)&&near(a.seller-d0.seller,2250)&&near(b.buyer-d0.buyer,2250)&&near(b.seller-d0.seller,-2250)&&near(c.buyer,d0.buyer)&&near(c.seller,d0.seller),"TS buyer/seller totals move by the right amount");
  ok(near(a.total,d0.total)&&near(b.total,d0.total)&&near(c.total,d0.total),"TS all-parties total never changes with who pays");
  ok(one(b,/County transfer tax/).item==="County transfer tax (paid by buyer)"&&one(a,/County transfer tax/).item==="County transfer tax (paid by seller)","TS non-default choices are labelled with who pays")}
 // FL deed stamps: default seller; split makes both pay; existing "buyer pays seller's tax" toggle unchanged and the line choice wins over it
 {const fl=o=>X.calc(R,inp(Object.assign({state:"FL",county:"Orange",price:400000,loan:320000},o))),line=r=>r.lines.find(l=>/Doc stamps on deed/.test(l.item));
  ok(line(fl({})).b===0&&near(line(fl({})).s,2800),"TS FL deed stamps default: seller");
  ok(near(line(fl({taxPayers:{"Doc stamps on deed":"split"}})).b,1400)&&near(line(fl({taxPayers:{"Doc stamps on deed":"split"}})).s,1400)&&/split 50\/50/.test(line(fl({taxPayers:{"Doc stamps on deed":"split"}})).item),"TS FL deed stamps split 1,400 / 1,400");
  ok(near(line(fl({buyerPaysSellerTax:true})).b,2800)&&/buyer paying seller's tax/.test(line(fl({buyerPaysSellerTax:true})).item),"TS old buyer-pays-seller's-tax toggle still moves it to the buyer");
  ok(near(line(fl({buyerPaysSellerTax:true,taxPayers:{"Doc stamps on deed":"split"}})).s,1400),"TS an explicit line choice wins over the old toggle");
  ok(line(fl({taxPayers:{"Doc stamps on note":"seller"}})).s===2800&&fl({taxPayers:{"Doc stamps on note":"seller"}}).lines.find(l=>/Doc stamps on note/.test(l.item)).s===0,"TS loan-based mortgage taxes cannot be moved (note stamps stay with the buyer)");
  ok(fl({taxPayers:{"Doc stamps on deed":"bogus"}}).lines.find(l=>/Doc stamps on deed/.test(l.item)).s>0,"TS an unknown choice is ignored")}
 // refinance: nothing to choose, everything stays with the borrower
 {const rf=X.calc(R,inp({type:"refi",state:"MD",county:"Montgomery",loan:360000,payoff:300000,taxPayers:{"County recordation tax":"split"}}));ok(rf.seller===0&&rf.taxes.every(t=>!t.adjustable),"TS refinance: taxes stay with the borrower; no payer choice")}
 // odd cents: the two halves always add up to the exact total (the odd cent goes to the seller)
 for(const[amt,b,sl]of[[1557.51,778.75,778.76],[0.01,0,0.01],[100.01,50,50.01],[2250,1125,1125],[1000.03,500.01,500.02]]){const h=X.halves(amt);ok(near(h[0],b,1e-9)&&near(h[1],sl,1e-9)&&Math.round((h[0]+h[1])*100)===Math.round(amt*100),`TS halves(${amt}) = ${h}`)}
 {let bad=0;for(let p=100000;p<=100000+4000;p+=37){const r=X.calc(R,inp({state:"MD",county:"Frederick",price:p+0.37,loan:80000,taxPayers:{"State transfer tax":"split","County transfer tax":"split","County recordation tax":"split"}}));for(const t of r.taxes){const l=r.lines.find(x=>x.item.startsWith(t.name));if(Math.round((l.b+l.s)*100)!==Math.round(t.amt*100))bad++}}ok(bad===0,"TS split halves add up to the exact tax for 100+ odd prices (no lost or extra cent)")}
 // seller net sheet: the seller's share of a split tax is half; the choice moves the net by the right amount; buyer choice removes it
 {const sn=SN({county:"Montgomery",price:450000}),sp=SN({county:"Montgomery",price:450000,taxPayers:{"County transfer tax":"seller"}}),sb=SN({county:"Montgomery",price:450000,taxPayers:{"County transfer tax":"buyer"}}),ss=SN({county:"Montgomery",price:450000,taxPayers:{"County transfer tax":"split"}});
  const g=(r,re)=>{const x=r.gov.find(y=>re.test(y.item));return x?x.amt:0};
  ok(near(g(sn,/County transfer/),2250)&&near(g(ss,/County transfer/),2250)&&near(g(sp,/County transfer/),4500)&&g(sb,/County transfer/)===0,"SN transfer tax: default split 2,250; seller 4,500; buyer 0");
  ok(/County transfer tax \(split 50\/50\)/.test(ss.gov.map(x=>x.item).join("|"))&&near(sp.net,sn.net-2250)&&near(sb.net,sn.net+2250),"SN net moves by the seller's share; label says split 50/50");
  ok(sn.calc.taxes.length>=2&&sn.calc.taxes.every(t=>t.payer===t.def),"SN result exposes the tax lines for the payer control")}
}
// toggles
ok(SN({bpst:true,state:"FL",county:"Orange",price:400000,ownerPays:false}).totals.gov===0,"SN: buyer-pays-seller's-deed-tax toggle removes FL deed stamps from the seller");
ok(SN({fthb:true,price:400000}).gov.some(g=>/State transfer/.test(g.item)&&near(g.amt,500))&&near(SN({price:400000}).gov.find(g=>/State transfer/.test(g.item)).amt,1000),"SN MD state transfer at $400k: seller share $1,000 (50/50 of $2,000); first-time buyer: $500 (50/50 of the reduced $1,000), not all on the seller");
ok(!SN({state:"VA",county:"Fairfax",ownerPays:true}).warnings.some(w=>/premium|lender/.test(w))&&!snVA.warnings.some(w=>/premium|lender/.test(w))&&!snMD.warnings.some(w=>/premium/.test(w)),"SN VA + MD (premiums loaded): no premium warnings, even when the seller pays the owner's policy");
ok(SN({fees:[]}).totals.title===0&&near(SN({fees:[{name:"Custom",payer:"Seller",amt:100,sec:"C"}]}).totals.title,100),"SN fee list is editable (custom seller fee, none)");
// live loader: fallback + success with mocked fetch
(async()=>{
 const fb=await X.loadFees(async()=>({ok:false,status:401,text:async()=>""}));ok(fb.source==="snapshot"&&/401/.test(fb.error),"fetch 401 -> snapshot fallback");
 const html=await X.loadFees(async()=>({ok:true,status:200,text:async()=>"<html>sign in</html>"}));ok(html.source==="snapshot","login page -> snapshot fallback");
 const toCSV=a=>a.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(",")).join("\n");
 const live=await X.loadFees(async u=>{const t=decodeURIComponent(u.match(/sheet=([^&]+)/)[1]);return{ok:true,status:200,text:async()=>toCSV(X.SNAP[t])}});
 ok(live.source==="sheet"&&X.normalize(live.raw).Transfer_Taxes.length===R.Transfer_Taxes.length,"mock live sheet parsed into same structures");
 ok(near(X.calc(X.normalize(live.raw),inp({price:800000,loan:640000,occ:false})).lines.filter(l=>/County recordation/.test(l.item)).reduce((a,l)=>a+l.b+l.s,0),9938),"CSV-loaded data gives same Montgomery result");
 // ---- per-rep special SETTLEMENT fee (migration 16): only "Settlement Fee to CLA Title & Escrow" can change; premiums and recording stay byte-for-byte ----
 {const ovMD=[{state:"MD",transaction:"purchase",paidBy:"buyer",amount:900},{state:"MD",transaction:"purchase",paidBy:"seller",amount:500}],ovAll=[{state:"*",transaction:"purchase",paidBy:"buyer",amount:925.5},{state:"*",transaction:"purchase",paidBy:"seller",amount:0},{state:"*",transaction:"refi",paidBy:"buyer",amount:300}];
  const SF="Settlement Fee to CLA Title & Escrow",ro=(ov,st,ty,n,p)=>X.repFeeOverride(ov,st,ty,n,p);
  ok(ro(ovMD,"MD","purchase",SF,"Buyer")===900&&ro(ovMD,"MD","cash",SF,"Seller")===500&&ro(ovMD,"MD","purchase",SF,"buyer")===900,"override: settlement fee matched by state / purchase-or-cash / payer (Buyer, Seller)");
  ok(ro(ovMD,"VA","purchase",SF,"Buyer")===null&&ro(ovMD,"MD","refi",SF,"Borrower")===null&&ro([],"MD","purchase",SF,"Buyer")===null&&ro(null,"MD","purchase",SF,"Buyer")===null,"override: no row for that state / transaction, or no overrides at all = null (standard fee)");
  ok(ro(ovAll,"FL","purchase",SF,"Buyer")===925.5&&ro(ovAll,"VA","refi",SF,"Borrower")===300&&ro(ovAll,"DC","cash",SF,"Seller")===0,"override: '*' row applies to every state; a refi 'Borrower' is the buyer side; 0 (waived) is honoured");
  ok(ro(ovAll.concat(ovMD),"MD","purchase",SF,"Buyer")===900&&ro(ovAll.concat(ovMD),"FL","purchase",SF,"Buyer")===925.5,"override: a state row beats the all-states row (either order)");
  // multi-state fee sets: one set's rows repeat per chosen state; a state's own set beats the all-states set as a whole (a null amount = that line is standard)
  {const set=(sts,b,sl)=>sts.flatMap(st=>[{state:st,transaction:"purchase",paidBy:"buyer",amount:b},{state:st,transaction:"purchase",paidBy:"seller",amount:sl}]),mdva=set(["MD","VA"],900,500),fl=set(["FL"],1000,800),both=mdva.concat(fl);
   ok([["MD",900,500],["VA",900,500],["FL",1000,800]].every(([st,b,sl])=>ro(both,st,"purchase",SF,"Buyer")===b&&ro(both,st,"purchase",SF,"Seller")===sl)&&ro(both,"DC","purchase",SF,"Buyer")===null,"multi-state set: MD+VA set and FL set each apply to their own states; DC (in no set) is standard");
   const fb=[{state:"*",transaction:"purchase",paidBy:"buyer",amount:950},{state:"*",transaction:"purchase",paidBy:"seller",amount:600}],mdOnly=[{state:"MD",transaction:"purchase",paidBy:"buyer",amount:900},{state:"MD",transaction:"purchase",paidBy:"seller",amount:null}];
   ok(ro(fb.concat(mdOnly),"MD","purchase",SF,"Buyer")===900&&ro(fb.concat(mdOnly),"MD","purchase",SF,"Seller")===null&&ro(mdOnly.concat(fb),"MD","purchase",SF,"Seller")===null&&ro(fb.concat(mdOnly),"VA","purchase",SF,"Seller")===600,"multi-state set: a state's own set beats the all-states set as a whole: its empty line (null amount) is STANDARD, not the all-states fee; other states use the fallback");
   ok(ro([{state:"MD",transaction:"purchase",paidBy:"buyer",amount:0}].concat(fb),"MD","purchase",SF,"Buyer")===0,"multi-state set: 0 is a real fee (waived), unlike null");
   const base0=fees("MD","purchase"),e=X.applyRepFees(base0,fb.concat(mdOnly),"MD","purchase"),sfs=e.map((f,k)=>[f,base0[k]]).filter(([f])=>X.isSettlementFee(f.name)),sp=sfs.filter(([f])=>f.special);
   ok(e.length===base0.length&&sp.length>=1&&sfs.some(([f,b0])=>!f.special&&JSON.stringify(f)===JSON.stringify(b0)),"multi-state set: with an empty (null) seller line in the MD set, the buyer settlement line is overridden and the seller line stays exactly standard");}
  for(const n of["Notary Fee to CLA Title & Escrow","Doc Preparation Fee","Processing Fee to CLA Title & Escrow","Title Search and Abstract","Secure Document Storage to Qualia","CPL (Lender)","Title – Lender's Title Policy","Owner's Title Policy","Recording fees – Deed","E-recording Fee to Simplifile","County transfer tax","Title Insurance Settlement Fee"])
   ok(ro([{state:"*",transaction:"purchase",paidBy:"buyer",amount:1},{state:"*",transaction:"refi",paidBy:"buyer",amount:1},{state:"*",transaction:"purchase",paidBy:"seller",amount:1}],"MD","purchase",n,"Buyer")===null,"override can never touch: "+n);
  ok(ro([{state:"*",transaction:"purchase",paidBy:"buyer",amount:-5}],"MD","purchase",SF,"Buyer")===null&&ro([{state:"*",transaction:"purchase",paidBy:"buyer",amount:"abc"}],"MD","purchase",SF,"Buyer")===null&&ro([{state:"*",transaction:"purchase",paidBy:"buyer",amount:null}],"MD","purchase",SF,"Buyer")===null&&ro([{state:"*",transaction:"purchase",paidBy:"buyer",amount:"$1,000"}],"MD","purchase",SF,"Buyer")===1000,"override: a negative / non-numeric amount is ignored (standard fee), a '$1,000' string is read");
  ok(ro(ovAll,"MD","purchase",SF,"Split")===null&&ro(ovAll,"MD","purchase",SF,"Lender")===null,"override: only buyer / borrower / seller payers");
  // the whole quote, every state and transaction: only the settlement lines move; everything else is identical to the character
  const isSF=l=>/^Title – Settlement Fee to CLA Title & Escrow/.test(l.item),keep=r=>JSON.stringify(r.lines.filter(l=>!isSF(l)));
  let combos=0;
  for(const[st,co,ty,ov]of[["MD","Montgomery","purchase",ovMD],["MD","Montgomery","cash",ovMD],["VA","Fairfax","purchase",ovAll],["DC","District of Columbia","refi",ovAll],["FL","Orange","purchase",ovAll],["FL","Miami-Dade","refi",ovAll],["MD","Frederick","refi",ovAll],["VA","Fairfax","cash",ovAll.concat(ovMD)]]){
   const base=fees(st,ty),over=X.applyRepFees(base,ov,st,ty),b=X.calc(R,inp({type:ty,state:st,county:co,fees:base,price:620000,loan:496000,payoff:310000,ends:[]})),a=X.calc(R,inp({type:ty,state:st,county:co,fees:over,price:620000,loan:496000,payoff:310000,ends:[]}));
   const sfB=b.lines.filter(isSF),sfA=a.lines.filter(isSF),want=over.filter(f=>f.special).length;combos++;
   ok(over.filter(f=>f.special).every(f=>X.isSettlementFee(f.name))&&over.length===base.length&&over.filter((f,i)=>!f.special).every(f=>JSON.stringify(f)===JSON.stringify(base[over.indexOf(f)])),`${st} ${co} ${ty}: only settlement fee rows are marked special; every other fee row is the same object content`);
   ok(keep(a)===keep(b),`${st} ${co} ${ty}: every non-settlement line (premiums, endorsements, recording, taxes, other CLA fees) identical byte for byte`);
   ok(JSON.stringify(a.premiums)===JSON.stringify(b.premiums)&&JSON.stringify(a.warnings)===JSON.stringify(b.warnings),`${st} ${co} ${ty}: premium amounts and warnings identical byte for byte`);
   ok(JSON.stringify(a.lines.filter(l=>/Title Policy|Endorsement/.test(l.item)))===JSON.stringify(b.lines.filter(l=>/Title Policy|Endorsement/.test(l.item)))&&JSON.stringify(a.lines.filter(l=>/^Recording fees/.test(l.item)))===JSON.stringify(b.lines.filter(l=>/^Recording fees/.test(l.item)))&&b.lines.some(l=>/^Recording fees/.test(l.item)),`${st} ${co} ${ty}: title insurance lines and recording fee lines identical byte for byte`);
   const dB=r2=>sfB.reduce((x,l)=>x+l.b+l.s,0)-sfA.reduce((x,l)=>x+l.b+l.s,0);
   ok(sfA.length<=sfB.length&&want>0&&near(b.total-a.total,dB()),`${st} ${co} ${ty}: total changes by exactly the settlement-fee difference (${dB()})`);
  }
  ok(combos===8,"override: eight state / transaction combinations checked");
  // default pricing is unchanged for everyone without an override: same lines as before the feature
  const noOv=X.applyRepFees(fees("MD","purchase"),[],"MD","purchase");ok(JSON.stringify(noOv)===JSON.stringify(fees("MD","purchase"))&&X.applyRepFees(fees("MD","purchase"),null,"MD","purchase").every(f=>!f.special),"override: no overrides = the fee list comes back untouched (default pricing unchanged)");
  const dflt=X.calc(R,inp({fees:fees("MD","purchase")}));ok(near(line(dflt,/Settlement Fee to CLA/),1745),"default MD settlement fees still 1,075 buyer + 670 seller");
  // an override row with extra / hostile properties still only ever replaces the settlement amount
  const hostile=[{state:"*",transaction:"purchase",paidBy:"buyer",amount:10,feeKey:"premium",name:"Owner's Title Policy",item:"Recording fees – Deed"}];
  const hb=X.calc(R,inp({fees:fees("MD","purchase")})),ha=X.calc(R,inp({fees:X.applyRepFees(fees("MD","purchase"),hostile,"MD","purchase")}));ok(keep(ha)===keep(hb)&&near(hb.total-ha.total,1065),"override: extra properties on a row (feeKey / name) change nothing: still only the settlement fee moves");
  // seller net sheet: the seller's settlement fee follows, nothing else
  const sB=X.sellerNet(R,{state:"MD",county:"Montgomery",uw:"Fidelity National Title",price:500000,payoff1:300000,closing:"2026-11-20"}),sA=X.sellerNet(R,{state:"MD",county:"Montgomery",uw:"Fidelity National Title",price:500000,payoff1:300000,closing:"2026-11-20",fees:X.sellerFeeInputs(R,"MD",ovMD)});
  const sKeep=r=>JSON.stringify([r.gov,r.commissions,r.title.filter(x=>!/Settlement Fee to CLA/.test(x.item)),r.payoffs,r.prorations,r.other]);
  ok(sKeep(sA)===sKeep(sB)&&near(sA.net-sB.net,170)&&JSON.stringify(X.sellerFeeInputs(R,"MD"))===JSON.stringify(X.sellerFeeInputs(R,"MD",[])),"seller net sheet: seller settlement fee 670 -> 500 raises net by 170; recording, premiums, commissions, everything else identical");}
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
 // special settlement fee in the page: the fee panel and the quote show it, nothing else moves, and clearing it restores the exact default
 {const win=d.window,API=win.CLA_QUOTE_API,ledger=()=>[...w.querySelectorAll("#ledger tr")].map(r=>r.textContent.trim()),tot=()=>["tB","tS","tA"].map(i=>w.getElementById(i).textContent).join("|"),feeRow=n=>[...w.querySelectorAll("#fees .fee")].filter(r=>r.children[0].dataset.name===n);
  ok(typeof API.setFeeOverrides==="function"&&w.querySelectorAll("#fees input[data-special]").length===0,"DOM: setFeeOverrides exists; no special rate shown by default");
  setv("zip","21704");w.querySelector("[data-t=purchase]").click();const t0=tot(),l0=ledger(),sf0=feeRow("Settlement Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",");
  ok(sf0==="1075,670","DOM default MD purchase settlement fee inputs 1075 / 670");
  API.setFeeOverrides([{state:"MD",transaction:"purchase",paidBy:"buyer",amount:900},{state:"MD",transaction:"purchase",paidBy:"seller",amount:500}]);
  ok(feeRow("Settlement Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",")==="900,500"&&w.querySelectorAll("#fees input[data-special]").length===2&&/special rate, standard \$1,075\.00/.test(w.getElementById("fees").textContent),"DOM fee panel shows 900 / 500 with 'special rate, standard $1,075.00'");
  ok(w.querySelectorAll("#fees .fee").length===[...w.querySelectorAll("#fees .fee")].length&&[...w.querySelectorAll("#fees .fee")].filter(r=>!/Settlement Fee to CLA/.test(r.children[0].dataset.name)).every(r=>!r.querySelector("[data-special]")&&!r.children[0].dataset.special),"DOM only the two settlement rows are flagged special");
  const l1=ledger(),pick=a=>a.filter(x=>!/Settlement Fee to CLA|^(Section C total|Total)/.test(x)&&!/Section C total/.test(x));
  ok(JSON.stringify(pick(l1))===JSON.stringify(pick(l0)),"DOM every other ledger row (insurance, recording, taxes, other fees) identical text");
  ok(l1.some(x=>/Settlement Fee to CLA.*\$900\.00/.test(x))&&l1.some(x=>/Settlement Fee to CLA.*\$500\.00/.test(x))&&!l1.some(x=>/special|standard/i.test(x)),"DOM ledger shows $900.00 and $500.00 on the settlement lines with no 'special' wording on the printed quote");
  const [b0,s0]=t0.split("|").map(x=>+x.replace(/[$,]/g,"")),[b1,s1]=tot().split("|").map(x=>+x.replace(/[$,]/g,""));ok(near(b0-b1,175)&&near(s0-s1,170),`DOM buyer total drops 175 and seller total 170 (${t0} -> ${tot()})`);
  ok(/Settlement Fee to CLA Title & Escrow: Buyer \$900\.00/.test(API.snapshot().results.text)&&API.snapshot().inputs.fees.filter(f=>f.special).length===2&&API.snapshot().inputs.fees.filter(f=>f.special).every(f=>/^Settlement Fee to CLA/.test(f.name)&&f.std>f.amt),"DOM saved snapshot text has the special amount; inputs mark just the two settlement fees special (with the standard amount)");
  setv("zip","32801");ok(w.getElementById("state").value==="FL"&&w.querySelectorAll("#fees input[data-special]").length===0&&feeRow("Settlement Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",")==="1100,950","DOM a Maryland-only override does not touch Florida (1100 / 950)");
  setv("zip","21704");API.setFeeOverrides([{state:"*",transaction:"purchase",paidBy:"buyer",amount:900}]);ok(feeRow("Settlement Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",")==="900,670","DOM buyer-only override leaves the seller fee standard");
  w.querySelector("[data-t=refi]").click();ok(feeRow("Settlement Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",")==="450"&&w.querySelectorAll("#fees input[data-special]").length===0,"DOM a purchase override does not touch the refinance fee (450)");
  API.setFeeOverrides([{state:"*",transaction:"refi",paidBy:"buyer",amount:300}]);ok(feeRow("Settlement Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",")==="300"&&feeRow("Processing Fee to CLA Title & Escrow").map(r=>r.children[2].value).join(",")==="450","DOM refinance override: settlement 300; the separate Processing Fee stays 450");
  w.querySelector("[data-t=purchase]").click();API.setFeeOverrides([]);ok(tot()===t0&&JSON.stringify(ledger())===JSON.stringify(l0)&&w.querySelectorAll("#fees input[data-special]").length===0,"DOM clearing the overrides restores the exact default quote: "+t0);
  API.setFeeOverrides(null);ok(tot()===t0,"DOM setFeeOverrides(null) = standard");
  // seller tab
  w.querySelector("[data-mode=seller]").click();setv("s_zip","21704");setv("s_price","500000");setv("s_close","2026-10-23");const sn0=w.getElementById("sNet").textContent,sl0=[...w.querySelectorAll("#sLedger tr")].map(r=>r.textContent.trim());
  API.setFeeOverrides([{state:"MD",transaction:"purchase",paidBy:"seller",amount:500},{state:"MD",transaction:"purchase",paidBy:"buyer",amount:1}]);
  const sn1=w.getElementById("sNet").textContent,sl1=[...w.querySelectorAll("#sLedger tr")].map(r=>r.textContent.trim());
  ok(near(+sn1.replace(/[$,]/g,"")-+sn0.replace(/[$,]/g,""),170)&&sl1.some(x=>/Settlement.*\$500\.00/.test(x))&&sl1.length===sl0.length&&/special rate, standard \$670\.00/.test(w.getElementById("s_fees").textContent),`DOM seller net sheet: seller settlement fee 670 -> 500 raises net by 170 (${sn0} -> ${sn1})`);
  const pickS=a=>a.filter(x=>!/Settlement|Title & settlement fees|Net seller|Total/i.test(x));ok(JSON.stringify(pickS(sl1))===JSON.stringify(pickS(sl0)),"DOM seller net sheet: every other row identical");
  API.setFeeOverrides([]);ok(w.getElementById("sNet").textContent===sn0,"DOM seller net sheet back to the default net "+sn0);
  w.querySelector("[data-mode=quote]").click();w.querySelector("[data-t=purchase]").click();}
 // per-tax payer control in the page (quote tab and seller net sheet)
 {const clickPay=(box,name,v)=>[...w.querySelectorAll(`#${box} button[data-tax]`)].find(b=>b.dataset.tax===name&&b.dataset.v===v).click(),pressed=(box,name)=>[...w.querySelectorAll(`#${box} button[data-tax]`)].filter(b=>b.dataset.tax===name&&b.getAttribute("aria-pressed")==="true").map(b=>b.dataset.v).join(),led=()=>w.getElementById("ledger").textContent;
  setv("state","MD");setv("zip","20850");w.querySelector("[data-t=purchase]").click();ok(w.getElementById("county").value==="Montgomery","DOM tax payer: ZIP 20850 -> Montgomery");
  ok(!w.getElementById("taxPay").hidden&&pressed("taxPay","County transfer tax")==="split"&&/default: split 50\/50/.test(w.getElementById("taxPay").textContent),"DOM tax payer: control shown; MD transfer tax default is Split");
  const dBuyer=w.getElementById("tB").textContent,dSeller=w.getElementById("tS").textContent,dAll=w.getElementById("tA").textContent;
  clickPay("taxPay","County transfer tax","seller");ok(pressed("taxPay","County transfer tax")==="seller"&&w.getElementById("tA").textContent===dAll&&w.getElementById("tB").textContent!==dBuyer&&/County transfer tax \(paid by seller\)/.test(led()),"DOM tax payer: Seller moves the tax to the seller column; all-parties total unchanged");
  const q1=w.getElementById("copy");clickPay("taxPay","County transfer tax","buyer");ok(pressed("taxPay","County transfer tax")==="buyer"&&/County transfer tax \(paid by buyer\)/.test(led()),"DOM tax payer: Buyer");
  clickPay("taxPay","County transfer tax","split");ok(w.getElementById("tB").textContent===dBuyer&&w.getElementById("tS").textContent===dSeller&&/County transfer tax \(split 50\/50\)/.test(led()),"DOM tax payer: back to Split restores the exact default totals");
  // the choice is in the saved-quote snapshot and in the copied text; it does not change anything for other counties
  clickPay("taxPay","County recordation tax","buyer");const snap=d.window.CLA_QUOTE_API.snapshot();
  ok(snap.inputs.taxPayers&&snap.inputs.taxPayers["County recordation tax"]==="buyer"&&snap.inputs.taxPayers["County transfer tax"]==="split"&&!snap.inputs.taxPayers["State transfer tax"],"DOM tax payer: saved-quote snapshot keeps the lines the person chose (and not the untouched ones)");
  ok(snap.results.lines.some(l=>/County recordation tax \(paid by buyer\)/.test(l.item)&&l.s===0&&l.b>0)&&snap.results.lines.some(l=>/County transfer tax \(split 50\/50\)/.test(l.item)&&l.b>0&&l.s>0)&&/County transfer tax \(split 50\/50\)/.test(snap.results.text),"DOM tax payer: snapshot lines and Copy quote text carry the labels and both columns");
  // first-time homebuyer box: lowers the state transfer rate where the sheet says so, but never changes who pays
  clickPay("taxPay","County recordation tax","split");const fb0=w.getElementById("tB").textContent,fs0=w.getElementById("tS").textContent,fa0=w.getElementById("tA").textContent;
  w.getElementById("fthb").click();
  ok(w.getElementById("fthb").checked&&["State transfer tax","County recordation tax","County transfer tax"].every(n=>pressed("taxPay",n)==="split")&&/default: split 50\/50/.test(w.getElementById("taxPay").textContent)&&!/default: seller/.test(w.getElementById("taxPay").textContent),"DOM FTHB: ticking first-time homebuyer leaves every MD tax on Split (the default payer is not changed)");
  ok(/State transfer tax \(first-time buyer\) \(split 50\/50\)/.test(led())&&/County transfer tax \(split 50\/50\)/.test(led())&&!/County transfer tax \(first-time buyer\)/.test(led())&&w.getElementById("tA").textContent!==fa0,"DOM FTHB: the reduced state transfer tax is labelled first-time buyer; the all-parties total drops only by the sheet's rate cut");
  ok(!!w.querySelector("#taxPay .tpf")&&/fee sheet lists the seller/.test(w.querySelector("#taxPay .tpf").textContent)&&/does not change who pays/.test(w.querySelector("#taxPay .tpf").textContent)&&!/\$/.test(w.querySelector("#taxPay .tpf").textContent),"DOM FTHB: a short note explains the sheet's seller note without changing the default (no amounts in the note)");
  clickPay("taxPay","County transfer tax","seller");ok(pressed("taxPay","County transfer tax")==="seller"&&/County transfer tax \(paid by seller\)/.test(led()),"DOM FTHB: the person can still choose Seller for a line");clickPay("taxPay","County transfer tax","split");
  w.getElementById("fthb").click();ok(!w.getElementById("fthb").checked&&!w.querySelector("#taxPay .tpf")&&w.getElementById("tB").textContent===fb0&&w.getElementById("tS").textContent===fs0&&w.getElementById("tA").textContent===fa0,"DOM FTHB: unticking restores the exact totals and removes the note");
  ok(Math.round((snap.results.totals.buyer+snap.results.totals.seller)*100)===Math.round(snap.results.totals.total*100),"DOM tax payer: snapshot totals add up");
  setv("county","Frederick");ok(!w.getElementById("county").value||pressed("taxPay","County recordation tax")==="split","DOM tax payer: choices reset when the county changes");
  setv("zip","20850");
  // seller net sheet
  w.querySelector("[data-mode=seller]").click();setv("s_zip","20850");ok(!w.getElementById("s_taxPay").hidden&&pressed("s_taxPay","County transfer tax")==="split","DOM seller net: control shown, default Split");
  const net0=w.getElementById("sNet").textContent;clickPay("s_taxPay","County transfer tax","buyer");ok(w.getElementById("sNet").textContent!==net0&&!/County transfer tax/.test(w.getElementById("sLedger").textContent),"DOM seller net: Buyer removes the tax from the seller's costs");
  clickPay("s_taxPay","County transfer tax","split");ok(w.getElementById("sNet").textContent===net0&&/County transfer tax \(split 50\/50\)/.test(w.getElementById("sLedger").textContent),"DOM seller net: Split restores the net and shows the label");
  const sSnap=d.window.CLA_QUOTE_API.snapshot();ok(sSnap.quoteType==="seller_net"&&/County transfer tax \(split 50\/50\)/.test(sSnap.results.text)&&sSnap.results.lines.some(l=>/County transfer tax \(split 50\/50\)/.test(l.item)),"DOM seller net: snapshot and Copy summary carry the split label");
  w.querySelector("[data-mode=quote]").click();w.querySelector("[data-t=refi]").click();ok(w.getElementById("taxPay").hidden,"DOM tax payer: no control on a refinance");w.querySelector("[data-t=purchase]").click()}
ok(errs.length===0,"no DOM errors "+errs);
 if(fails){console.error(fails,"FAILED");process.exit(1)}console.log("ALL PASS")})();
