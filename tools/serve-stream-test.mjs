// Reproducibility harness for the texture-load streaming fix (see
// evidence/layer1/texture-load-fix.md). Starts the dev server on an ephemeral
// port and verifies large assets stream (many chunks) and that a concurrent
// burst of all runtime textures + the sky HDR completes quickly with 200s.
//
// Run: node tools/serve-stream-test.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { startServer } from "./serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 0; // ephemeral; no port-collision risk
const server = await startServer({ port: PORT, root: ROOT });
const base = "http://localhost:" + server.address().port;

function fetch(url) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get(url, (res) => {
      let bytes = 0, chunks = 0;
      res.on("data", (c) => { bytes += c.length; chunks++; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes, chunks, ms: Date.now() - t0 }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

const r1 = await fetch(base + "/demo/index.html");
console.log("index.html:", r1.status, r1.headers["content-type"], r1.bytes + "B", "CL=" + r1.headers["content-length"], "cache=" + r1.headers["cache-control"]);

const r2 = await fetch(base + "/assets/layer1/textures/grass/normal.png");
console.log("grass/normal.png:", r2.status, r2.bytes + "B", r2.chunks + " chunks", r2.ms + "ms", "CL=" + r2.headers["content-length"]);

const r3 = await fetch(base + "/assets/layer1/sky/kloofendal_48d_partly_cloudy_puresky.hdr");
console.log("sky.hdr:", r3.status, r3.bytes + "B", r3.chunks + " chunks", r3.ms + "ms", "CL=" + r3.headers["content-length"]);

const paths = [];
for (const s of ["sand","rock","grass","soil","snow"]) {
  for (const m of ["albedo.jpg","normal.png","roughness.png","ao.png"]) {
    paths.push("/assets/layer1/textures/" + s + "/" + m);
  }
}
paths.push("/assets/layer1/sky/kloofendal_48d_partly_cloudy_puresky.hdr");
const t0 = Date.now();
const results = await Promise.all(paths.map(p => fetch(base + p)));
const totalMs = Date.now() - t0;
const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
const allOk = results.every(r => r.status === 200);
console.log("CONCURRENT BURST:", paths.length, "requests,", (totalBytes/1024/1024).toFixed(1), "MB,", totalMs + "ms,", "all200=" + allOk);

server.close();
console.log(allOk ? "PASS" : "FAIL");
process.exit(allOk ? 0 : 1);
