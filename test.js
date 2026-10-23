const fs=require("fs"),src=fs.readFileSync("index.html","utf8");const js=src.split("<script>")[1].split("</script>")[0];
const zjs=fs.readFileSync("zip-county.js","utf8");const m={exports:{}};new Function("module",zjs.replace(/if\(typeof module[^\n]*/,"")+"\n"+js)(m);const{SAMPLE,normalize,calc,DOC_DEFAULTS,allCounties,usesDefaults,zipLookup}=m.exports;const R=normalize(SAMPLE);
const fees=t=>R.Settlement_Fees.filter(f=>({purchase:f.Applies!=="Refinance",cash:f.Applies!=="Refinance",refi:f.Applies!=="Purchase"})[t]).map(f=>({name:f.Name,payer:f.Payer,amt:f.Amount}));
for(const [st,co] of [["MD","Montgomery"],["DC","District of Columbia"],["VA","Fairfax"],["FL","Miami-Dade"]])for(const type of ["purchase","cash","refi"])for(const fthb of [false,true]){if(fthb&&type==="refi")continue;
const r=calc(R,{type,state:st,county:co,uw:"Fidelity/Chicago",price:450000,loan:360000,payoff:300000,pol:"enhanced",rate:type==="refi"?"refi":"basic",fthb,ends:["ALTA 8.1","ALTA 9"],fees:fees(type),docs:Object.fromEntries(Object.entries(DOC_DEFAULTS[type]))});
console.log(st,type,fthb?"FTHB":"",r.buyer,r.seller,r.total,r.warnings.join(";"));if(st==="MD"&&!fthb)r.lines.forEach(l=>console.log("   ",l.item,l.b,l.s))}
const XLSX=require("xlsx"),wb=XLSX.utils.book_new();for(const k in SAMPLE)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(SAMPLE[k]),k);XLSX.writeFile(wb,"CLA-Fee-Tables-sample.xlsx");
// DOM test
const{JSDOM}=require("jsdom");const d=new JSDOM(src.replace(/<script src="https[^>]+><\/script>/,"").replace('<script src="zip-county.js"></script>',"<script>"+zjs+"</script>"),{runScripts:"dangerously"});const errs=[];d.window.addEventListener("error",e=>errs.push(e.message));
const w=d.window.document;for(const t of["purchase","cash","refi"]){w.querySelector(`[data-t=${t}]`).click();console.log("DOM",t,w.getElementById("tB").textContent,w.getElementById("tS").textContent,w.getElementById("tA").textContent)}
w.getElementById("zip").value="20001";w.getElementById("zip").dispatchEvent(new d.window.Event("input"));console.log("zip→",w.getElementById("state").value,w.getElementById("county").value,"errors:",errs);

// ---- county list / ZIP / every-county checks ----
const assert=require("assert");let fails=0;const ok=(c,msg)=>{if(!c){fails++;console.error("FAIL",msg)}else console.log("ok",msg)};
for(const[st,n]of[["MD",24],["VA",133],["DC",1],["FL",67]]){const l=allCounties(R,st);ok(l.length===n,`${st} has ${n} counties (got ${l.length})`);ok(l.join()===[...l].sort((a,b)=>a.localeCompare(b)).join(),`${st} sorted`)}
for(const[z,st,co]of[["20850","MD","Montgomery"],["21201","MD","Baltimore City"],["22030","VA","Fairfax"],["20001","DC","District of Columbia"],["33101","FL","Miami-Dade"],["32801","FL","Orange"],["20147","VA","Loudoun"],["22314","VA","Alexandria City"],["23219","VA","Richmond City"]]){const r=zipLookup(z);ok(r&&r.state===st&&r.county===co,`ZIP ${z} -> ${co}, ${st} (got ${r&&r.county}, ${r&&r.state}${r&&r.also.length?"; also "+r.also:""})`)}
ok(zipLookup("90210")===null,"out-of-area ZIP 90210 -> null");ok(zipLookup("abc")===null,"invalid ZIP -> null");
ok(usesDefaults(R,"MD","Garrett")&&!usesDefaults(R,"MD","Montgomery"),"default-rate flag");
let bad=0,cnt=0;for(const st of["MD","VA","DC","FL"])for(const co of allCounties(R,st))for(const type of["purchase","cash","refi"]){cnt++;try{const r=calc(R,{type,state:st,county:co,uw:"Fidelity/Chicago",price:450000,loan:360000,payoff:300000,pol:"enhanced",rate:type==="refi"?"refi":"basic",fthb:false,ends:[],fees:fees(type),docs:DOC_DEFAULTS[type]});
 if(!(r.total>0)||r.warnings.some(w=>/No (recording|transfer)/.test(w)))throw Error(r.warnings.join(";"))}catch(e){bad++;console.error("calc fail",st,co,type,e.message)}}
ok(bad===0,`all ${cnt} county/type calcs succeed`);
// workbook missing a county in Jurisdictions still lists it
const S2=JSON.parse(JSON.stringify(SAMPLE));S2.Jurisdictions=S2.Jurisdictions.slice(0,1);ok(allCounties(normalize(S2),"MD").length===24,"workbook w/o Jurisdictions rows still lists all MD counties");
// DOM ZIP flow
for(const[z,st,co]of[["21201","MD","Baltimore City"],["32801","FL","Orange"],["20147","VA","Loudoun"]]){w.getElementById("zip").value=z;w.getElementById("zip").dispatchEvent(new d.window.Event("input"));ok(w.getElementById("state").value===st&&w.getElementById("county").value===co,`DOM ZIP ${z} -> ${w.getElementById("county").value}, ${w.getElementById("state").value}; note: "${w.getElementById("cntyNote").textContent}" msg: "${w.getElementById("zipMsg").textContent}"`)}
w.getElementById("zip").value="90210";w.getElementById("zip").dispatchEvent(new d.window.Event("input"));ok(/don't have/.test(w.getElementById("zipMsg").textContent),"DOM unknown ZIP message");
ok(w.getElementById("county").options.length===133&&w.getElementById("county").value==="Loudoun","DOM unknown ZIP leaves selection");
ok(errs.length===0,"no DOM errors "+errs);if(fails){console.error(fails,"FAILED");process.exit(1)}console.log("ALL PASS");
