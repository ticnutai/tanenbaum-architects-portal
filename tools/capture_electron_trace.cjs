const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.MAVAT_ELECTRON_DEBUG_PORT || 9333);
const durationMs = Number(process.env.MAVAT_TRACE_DURATION_MS || 8000);
const outputDir = path.resolve(
  process.env.MAVAT_TRACE_OUTPUT_DIR || path.join(__dirname, "..", "artifacts", "electron-live"),
);

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => {
    if (!response.ok) throw new Error(`Electron CDP returned HTTP ${response.status}`);
    return response.json();
  });
  const socket = await connect(version.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  const events = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
      return;
    }
    events.push(message);
  });

  const send = (method, params = {}, timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${method}: ${message.error.message}`));
          else resolve(message.result || {});
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordContinuously",
      includedCategories: [
        "toplevel",
        "blink",
        "devtools.timeline",
        "v8",
        "disabled-by-default-v8.cpu_profiler",
        "disabled-by-default-v8.cpu_profiler.hires",
      ],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  await send("Tracing.end");

  const deadline = Date.now() + 15000;
  let streamHandle = "";
  while (!streamHandle && Date.now() < deadline) {
    const completed = events.find((message) => message.method === "Tracing.tracingComplete");
    streamHandle = completed?.params?.stream || "";
    if (!streamHandle) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!streamHandle) throw new Error("Tracing.tracingComplete did not provide a stream");

  let trace = "";
  while (true) {
    const chunk = await send("IO.read", { handle: streamHandle });
    trace += chunk.data || "";
    if (chunk.eof) break;
  }
  await send("IO.close", { handle: streamHandle }).catch(() => undefined);
  socket.close();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `electron-trace-${stamp}.json`);
  fs.writeFileSync(outputPath, trace, "utf8");
  const parsed = JSON.parse(trace);
  const traceEvents = Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [];
  const processNames = new Map();
  const threadNames = new Map();
  for (const event of traceEvents) {
    if (event.ph !== "M") continue;
    if (event.name === "process_name") processNames.set(event.pid, event.args?.name || "");
    if (event.name === "thread_name") threadNames.set(`${event.pid}:${event.tid}`, event.args?.name || "");
  }
  const durations = traceEvents
    .filter((event) => event.ph === "X" && Number(event.dur) >= 1000)
    .map((event) => ({
      name: event.name,
      durationMs: Math.round((Number(event.dur) / 1000) * 100) / 100,
      process: processNames.get(event.pid) || String(event.pid),
      thread: threadNames.get(`${event.pid}:${event.tid}`) || String(event.tid),
    }))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 40);
  const summaryPath = outputPath.replace(/\.json$/, ".summary.json");
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ outputPath, durationMs, eventCount: traceEvents.length, longestEvents: durations }, null, 2),
    "utf8",
  );
  console.log(JSON.stringify({ outputPath, summaryPath, eventCount: traceEvents.length, longestEvents: durations.slice(0, 12) }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
