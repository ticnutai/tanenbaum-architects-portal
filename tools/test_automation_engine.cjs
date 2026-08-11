const { fork } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavat-engine-test-"));
const worker = fork(path.join(__dirname, "..", "automation-engine", "worker.cjs"), [], {
  silent: true,
  env: {
    ...process.env,
    MAVAT_AUTOMATION_PROFILE_DIR: profileDir,
    // Never attach a test run to the user's live Chrome on port 9223.
    MAVAT_CHROME_CDP_PORT: "19223",
  },
});
const timeout = setTimeout(() => {
  worker.kill();
  process.exitCode = 2;
}, 30000);

const page = encodeURIComponent(`
  <label for="committee">ועדה</label>
  <select id="committee" onchange="result.textContent = 'נבחר: ' + this.value">
    <option value="">בחר</option><option>שדות דן</option>
  </select>
  <div id="result"></div>
`);

worker.on("message", (message) => {
  if (message.type === "ready") {
    worker.send({
      id: "run",
      command: "run",
      payload: {
        startUrl: `data:text/html;charset=utf-8,${page}`,
        workflow: {
          name: "dropdown-test",
          steps: [{
            name: "בחירת ועדה", type: "select_option", target: "ועדה", value: "שדות דן",
            postcondition: { text: "נבחר: שדות דן" },
          }],
        },
        records: [{}],
      },
    });
  }
  if (message.type === "run-failed") {
    clearTimeout(timeout);
    console.error(message.error);
    worker.kill();
    process.exitCode = 1;
  }
  if (message.type === "run-completed") worker.send({ id: "close", command: "close-browser" });
  if (message.kind === "reply" && message.id === "close") {
    clearTimeout(timeout);
    console.log("dropdown-test passed");
    worker.kill();
  }
});
worker.on("exit", () => {
  clearTimeout(timeout);
  setTimeout(() => {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch (error) {
      console.warn(`temporary Chrome profile cleanup was deferred: ${error.message}`);
    }
  }, 500);
});
