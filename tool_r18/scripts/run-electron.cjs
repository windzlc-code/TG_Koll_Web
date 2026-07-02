const path = require("node:path");
const { spawn } = require("node:child_process");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

// In Node mode, require("electron") resolves to the executable path, which is
// exactly what we want for a bootstrap launcher.
const electronExecutable = require("electron");

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

function stopExistingProjectElectronWindows() {
  if (process.platform !== "win32") return;
  const escapedRoot = projectRoot.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const script = [
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine -like '*" + escapedRoot + "*'",
    "}",
    "foreach ($target in $targets) {",
    "  try { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop } catch {}",
    "}",
  ].join(" ");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: "ignore",
    });
  } catch {
    // Best-effort cleanup only.
  }
}

stopExistingProjectElectronWindows();

const child = spawn(electronExecutable, ["."], {
  cwd: projectRoot,
  env: childEnv,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
