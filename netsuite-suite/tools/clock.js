// node clock.js get | set <YYYY-MM-DD>  - read or move the coopegsbx2 CCP clock (tenant-wide: always put it back).
const U='https://service-transactional.coopegsbx2.embrix.org/graphql';
const q=async s=>(await (await fetch(U,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:s})})).json());
(async()=>{const [cmd,d]=process.argv.slice(2);
 if(cmd==='set')await q(`mutation { setCcpTime(input:{ccpTime:"${d}"}) { ccpTime } }`);
 console.log((await q('{ getCcpDateTime(dummy:"x") { ccpTime } }')).data.getCcpDateTime.ccpTime);})();
