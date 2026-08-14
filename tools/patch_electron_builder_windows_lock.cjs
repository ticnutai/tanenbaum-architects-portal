const fs = require("node:fs");
const path = require("node:path");

const target = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "app-builder-lib",
  "out",
  "util",
  "electronGet.js",
);

const marker = "let extractionLockReleased = false;";
const copyMarker = "await fs.cp(tmpDir, dir, { recursive: true, force: true });";
const source = fs.readFileSync(target, "utf8");

if (source.includes(marker) && source.includes(copyMarker)) {
  console.log("electron-builder Windows extraction lock patch already applied");
  process.exit(0);
}

const withState = source.includes(marker)
  ? source
  : source.replace(
      /(^\s*const release = await lockfile\.lock\(tmpDir,[\s\S]*?^\s*\}\);\r?\n)/m,
      `$1    ${marker}\n`,
    );

const withEarlyRelease = withState.includes("extractionLockReleased = true;")
  ? withState
  : withState.replace(
      /(^\s*await fs\.rm\(dir, \{ recursive: true, force: true \}\);\r?\n)(\s*await fs\.rename\(tmpDir, dir\);)/m,
      "$1        // Windows cannot rename tmpDir while proper-lockfile still owns a handle inside it.\n" +
        "        await release();\n" +
        "        extractionLockReleased = true;\n" +
        "$2",
    );

const withWindowsCopy = withEarlyRelease.includes(copyMarker)
  ? withEarlyRelease
  : withEarlyRelease.replace(
      /(^\s*extractionLockReleased = true;\r?\n)/m,
      "$1        if (process.platform === \"win32\") {\n" +
        "            await fs.cp(tmpDir, dir, { recursive: true, force: true });\n" +
        "            await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });\n" +
        "            return;\n" +
        "        }\n",
    );

const patched = withWindowsCopy.replace(
  /(^\s*)await release\(\)\.catch\(err => builder_util_1\.log\.warn\(\{ err \}, "failed to release lockfile"\)\);/m,
  "$1if (!extractionLockReleased) {\n" +
    "$1    await release().catch(err => builder_util_1.log.warn({ err }, \"failed to release lockfile\"));\n" +
    "$1}",
);

if (
  patched === source ||
  !patched.includes(marker) ||
  !patched.includes(copyMarker) ||
  !patched.includes("extractionLockReleased = true;")
) {
  throw new Error(
    "Could not patch electron-builder safely; its extraction implementation changed.",
  );
}

fs.writeFileSync(target, patched, "utf8");
console.log("Applied electron-builder Windows extraction lock patch");
