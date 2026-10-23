const fs=require("fs"),src=fs.readFileSync("index.html","utf8");const js=src.split("<script>")[1].split("</script>")[0];
const m={exports:{}};new Function("module",js)(m);const{SAMPLE,normalize,calc,DOC_DEFAULTS}=m.exports;const R=normalize(SAMPLE);
const fees=t=>R.Settlement_Fees.filter(f=>({purchase:f.Applies!=="Refinance",cash:f.Applies!=="Refinance",refi:f.Applies!=="Purchase"})[t]).map(f=>({name:f.Name,payer:f.Payer,amt:f.Amount}));
for(const [st,co] of [["MD","Montgomery"],["DC","District of Columbia"],["VA","Fairfax"],["FL","Miami-Dade"]])for(const type of ["purchase","cash","refi"])for(const fthb of [false,true]){if(fthb&&type==="refi")continue;
const r=calc(R,{type,state:st,county:co,uw:"Fidelity/Chicago",price:450000,loan:360000,payoff:300000,pol:"enhanced",rate:type==="refi"?"refi":"basic",fthb,ends:["ALTA 8.1","ALTA 9"],fees:fees(type),docs:Object.fromEntries(Object.entries(DOC_DEFAULTS[type]))});
console.log(st,type,fthb?"FTHB":"",r.buyer,r.seller,r.total,r.warnings.join(";"));if(st==="MD"&&!fthb)r.lines.forEach(l=>console.log("   ",l.item,l.b,l.s))}
const XLSX=require("xlsx"),wb=XLSX.utils.book_new();for(const k in SAMPLE)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(SAMPLE[k]),k);XLSX.writeFile(wb,"CLA-Fee-Tables-sample.xlsx");
// DOM test
const{JSDOM}=require("jsdom");const d=new JSDOM(src.replace(/<script src=[^>]+><\/script>/,""),{runScripts:"dangerously"});const errs=[];d.window.addEventListener("error",e=>errs.push(e.message));
const w=d.window.document;for(const t of["purchase","cash","refi"]){w.querySelector(`[data-t=${t}]`).click();console.log("DOM",t,w.getElementById("tB").textContent,w.getElementById("tS").textContent,w.getElementById("tA").textContent)}
w.getElementById("zip").value="20001";w.getElementById("zip").dispatchEvent(new d.window.Event("input"));console.log("zip→",w.getElementById("state").value,w.getElementById("county").value,"errors:",errs);
