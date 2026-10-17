// Zero-dep static file server for the texture-loading demo.
// Serves the repo root so /demo/index.html can fetch /assets/layer1/... over
// http (file:// would block PBR texture loads via CORS). No third-party deps.
// Run via npm run serve, or import startServer() for tests/harnesses.
//
// Performance: files are streamed via createReadStream+pipe so the event loop
// stays responsive even when 20+ large textures (7-24 MB each) are requested
// concurrently. The previous fs.readFile approach buffered entire files into
// the Node heap, starving other connections and causing 0fps stalls during
// initial texture load over http.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const DEFAULT_PORT = Number(process.env.PORT || 8137);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".hdr": "image/vnd.radiance",
  ".ktx2": "image/ktx2",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function mimeFor(ext) {
  const d = Object.getOwnPropertyDescriptor(MIME, ext);
  return (d || { value: "application/octet-stream" }).value;
}

export function createServer(opts) {
  const root = (opts && opts.root) || DEFAULT_ROOT;
  const ROOT = path.resolve(root);
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    fs.stat(filePath, (err, st) => {
      if (!err && st.isDirectory()) filePath = path.join(filePath, "index.html");
      fs.stat(filePath, (err2, st2) => {
        if (err2 || !st2.isFile()) { res.writeHead(404); res.end("Not found"); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": mimeFor(ext),
          "Content-Length": String(st2.size),
          "Cache-Control": "public, max-age=3600",
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on("error", () => { res.destroy(); });
      });
    });
  });
}

export function startServer(opts) {
  const o = opts || {};
  // Explicit numeric check: port 0 (ephemeral) is valid and must not fall
  // through to DEFAULT_PORT via || (0 is falsy).
  const port = Number.isFinite(o.port) ? o.port : DEFAULT_PORT;
  const root = o.root || DEFAULT_ROOT;
  const server = createServer({ root });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

const scriptPath = process.argv.at(1);
const isMain = scriptPath && path.resolve(scriptPath) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then((server) => {
    const addr = server.address();
    console.log("serving " + path.resolve(DEFAULT_ROOT) + " at http://localhost:" + addr.port + "/demo/index.html");
  }).catch((err) => {
    console.error("serve failed: " + err.message);
    process.exit(1);
  });
}
