// Fires many transcode requests against a pre-uploaded file to sustain CPU >80%.
// Usage: TOKEN=.. FILE_ID=.. HOST=ec2-xx.compute.amazonaws.com PORT=3000 C=6 N=200 node tools/load.js
import http from "http";


const HOST = process.env.HOST || "localhost";
const PORT = parseInt(process.env.PORT || "3000", 10);
const TOKEN = process.env.TOKEN || "";
const FILE_ID = process.env.FILE_ID || ""; // uploaded original fileId
const CONCURRENCY = parseInt(process.env.C || "6", 10);
const REQUESTS = parseInt(process.env.N || "200", 10);


if (!TOKEN || !FILE_ID) {
console.error("Set TOKEN and FILE_ID env vars.");
process.exit(1);
}


let sent = 0, done = 0;
function fire() {
if (sent >= REQUESTS) return;
sent++;
const opts = {
hostname: HOST,
port: PORT,
path: `/transcode/${FILE_ID}`,
method: "POST",
headers: { "Authorization": `Bearer ${TOKEN}` }
};
const req = http.request(opts, (res) => { res.resume(); res.on("end", () => { done++; if (sent < REQUESTS) fire(); }); });
req.on("error", () => { done++; if (sent < REQUESTS) fire(); });
req.end();
}
for (let i = 0; i < CONCURRENCY; i++) fire();
const t = setInterval(() => {
process.stdout.write(`\rSent ${sent}/${REQUESTS}, completed ${done}`);
if (done >= REQUESTS) { console.log("\nDone."); clearInterval(t); }
}, 500);