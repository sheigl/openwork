import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, request } from "node:http";
import { launchHeadlessWeb } from "/workspace/packages/world/src/headless-web.ts";
import { chrome, localHost } from "/workspace/evals/packages/hosts/src/index.ts";
import { waitUntilInteractive, evalIn } from "/workspace/evals/packages/behaviors/src/index.ts";
import { browserScript } from "/workspace/evals/packages/cdp/src/index.ts";

const root = "/opt/openwork-preview";
/** No response can pause inside the VM, so the viewer never shows its continue button. */
const PAUSED = { held: false, complete: false, streamCount: 0 };
process.env.OPENWORK_WORLD_PLACE = "local";
process.env.pnpm_config_verify_deps_before_run = "false";
process.env.DISPLAY = ":99";
process.env.CHROME_BIN = "/opt/openwork-preview/evidence-chrome";
process.env.GOMEMLIMIT = "512MiB";
const stack = new AsyncDisposableStack();
function service(command, args, name) {
  const fd = openSync(`${root}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, { env: process.env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  stack.defer(() => child.kill("SIGTERM"));
}
async function ready(check, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await delay(250); }
  throw new Error(`${label} did not become ready`);
}
try {
  await mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
  service("Xvfb", [":99", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], "evidence-display");
  await ready(() => access("/tmp/.X11-unix/X99").then(() => true), "display");
  service("x11vnc", ["-display", ":99", "-localhost", "-rfbport", "5900", "-forever", "-shared", "-nopw", "-quiet"], "evidence-vnc");
  service("websockify", ["--web", "/usr/share/novnc", "127.0.0.1:6080", "127.0.0.1:5900"], "evidence-viewer");
  // Everything the viewer shows runs in this VM: the app's development servers
  // serve the checked-out sources and nothing leaves the machine.
  const state = `${root}/state`;
  for (const dir of ["home", "cache", "config/openwork", "config/opencode", "data/openwork", "data/opencode", "workspace"]) {
    await mkdir(`${state}/${dir}`, { recursive: true });
  }
  const world = await launchHeadlessWeb({
    repoRoot: "/workspace", name: "freestyle-evidence", state: "isolated",
    workspace: `${state}/workspace`, browserHostSuffix: ".preview.openwork.software",
    env: {
      PATH: process.env.PATH,
      pnpm_config_verify_deps_before_run: "false",
      HOME: `${state}/home`, XDG_CONFIG_HOME: `${state}/config`, XDG_DATA_HOME: `${state}/data`, XDG_CACHE_HOME: `${state}/cache`,
      OPENWORK_DATA_DIR: `${state}/data/openwork`, OPENWORK_ENV_STORE: `${state}/config/openwork/env.json`,
      OPENWORK_SERVER_STATE_PATH: `${state}/data/openwork/server-state.json`,
      OPENWORK_SERVER_TOKEN_STORE_PATH: `${state}/data/openwork/server-tokens.json`,
      OPENCODE_CONFIG_DIR: `${state}/config/opencode`, OPENCODE_DB: `${state}/data/opencode/opencode.db`,
      VITE_OPENWORK_POSTHOG_KEY: "", VITE_OPENWORK_SENTRY_DSN: "", VITE_DISABLE_OPENWORK_MODELS: "0",
      OPENWORK_PORT: "8778", OPENWORK_WEB_PORT: "5178", HOST: "127.0.0.1", VITE_HOST: "127.0.0.1",
    },
  });
  stack.defer(() => world.stop());
  const browser = stack.use(await chrome({ host: localHost({ repoRoot: "/workspace", log: () => {} }), name: "evidence-web", startUrl: world.manifest.webUrl, headless: false }));
  await waitUntilInteractive(browser);
  // The viewer keeps this tab; a direct app link would open a new document and is
  // deliberately not presented as an exact checkpoint restore. After a checkout,
  // reload the saved tab and wait for the app to accept requests again.
  async function refresh() {
    await evalIn(browser, browserScript(() => { setTimeout(() => location.reload(), 0); return true; }, [])).catch(() => undefined);
    await delay(500);
    await waitUntilInteractive(browser);
  }
  const viewer = createServer((req, res) => {
    if (req.url === "/__evidence/refresh" && req.method === "POST") {
      refresh().then(() => res.end("refreshed"), (error) => { res.writeHead(500); res.end(error instanceof Error ? error.message : String(error)); });
      return;
    }
    if (req.url === "/__evidence/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(PAUSED)); return; }
    if (req.url === "/__evidence/continue" && req.method === "POST") { res.end("no response is paused"); return; }
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><head><title>Saved OpenWork browser</title><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;font:13px system-ui;background:Canvas;color:CanvasText"><header style="display:flex;align-items:center;gap:16px;padding:12px"><strong>Saved browser</strong><button id="continue" hidden>Continue response</button><span id="state" role="status"></span></header><iframe title="Saved browser (noVNC)" src="/vnc.html?autoconnect=1&resize=scale" style="border:0;width:100%;height:calc(100vh - 55px)"></iframe><script>
const button=document.getElementById('continue');const label=document.getElementById('state');
async function state(){try{const s=await fetch('/__evidence/state').then(r=>r.json());button.hidden=!s.held;label.textContent=s.held?'Response paused at checkpoint':s.complete?'Response continued':'';}catch{label.textContent='Connection lost. Reopen this checkpoint from its report.';}}
button.onclick=async()=>{button.disabled=true;try{await fetch('/__evidence/continue',{method:'POST'});await state();}finally{button.disabled=false;}};state();setInterval(state,1000);
</script></body></html>`);
      return;
    }
    const upstream = request({ hostname: "127.0.0.1", port: 6080, path: req.url, method: req.method }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502).end(); }); req.pipe(upstream);
  });
  viewer.on("upgrade", (req, socket, head) => {
    const upstream = request({ hostname: "127.0.0.1", port: 6080, path: req.url, headers: req.headers });
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(peer).pipe(socket); peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy());
    });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise((resolve) => viewer.listen(6081, "127.0.0.1", resolve));
  await writeFile(`${root}/services.json`, JSON.stringify({ desktop: "http://127.0.0.1:6081", cdp: browser.handle.cdpUrl }), { mode: 0o600 });
  await writeFile(`${root}/evidence-ready`, "web-v1");
  await writeFile(`${root}/ready-world`, "ready");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await stack.disposeAsync(); process.exit(0); });
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  await writeFile(`${root}/failed-world`, "failed");
  await stack.disposeAsync(); process.exit(1);
}
