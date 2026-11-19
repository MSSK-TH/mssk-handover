import fs from 'node:fs';
const BASE='https://chatgpt.com';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const cookie=fs.readFileSync(process.argv[2]||'/app/web-cookie.txt','utf8').trim();
const r=await fetch(BASE+'/api/auth/session',{headers:{cookie,'user-agent':UA,accept:'application/json','accept-language':'en-US,en;q=0.9'}});
console.log('status:',r.status);
try{const d=await r.json();const u=d.user||{};console.log('email:',u.email,'| plan:',u.planType||u.plan,'| token:',!!d.accessToken);}catch(e){console.log('body:',(await r.text()).slice(0,120));}