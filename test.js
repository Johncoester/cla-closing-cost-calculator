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
ok(near(line(fl,/Recording fees – Deed$/),10+7*8.5),"FL recording $10 + $8.50/page");
// MD/VA/DC premiums are placeholders → warning, no invented numbers
ok(X.calc(R,inp({})).warnings.some(w=>/premium rates for MD/.test(w)),"MD premium placeholder warning");
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
