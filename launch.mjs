#!/usr/bin/env node
// Beamdesk launcher — one file to set everything up and pick what to run.
//
//   node launch.mjs      (or: npm start)
//
// Shows a menu: full setup, run the agent, run the client, run the tunnel,
// rebuild, or a local agent+client test. Dependency-free and cross-platform.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installService, serviceStatus, uninstallService } from "./scripts/agent-service.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
const AGENT_DATA_DIR = join(ROOT, "agent", ".data");
const AGENT_PID_FILE = join(AGENT_DATA_DIR, "agent.pid");
const AGENT_LOG_FILE = join(AGENT_DATA_DIR, "agent.log");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  amber: "\x1b[38;5;214m", green: "\x1b[38;5;42m", red: "\x1b[38;5;203m", cyan: "\x1b[38;5;80m",
};
const color = (c, s) => `${C[c]}${s}${C.reset}`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Without a listener, readline answers Ctrl-C by emitting 'pause' and nothing
// else -- so the menu could not be interrupted either, only left via `q`.
rl.on("SIGINT", () => {
  rl.close();
  process.exit(130); // 128 + SIGINT, the conventional code for this
});
const ask = (q) => new Promise((res) => rl.question(q, res));

/** Is a CLI tool on PATH? */
function have(cmd, args = ["--version"]) {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", shell: IS_WIN }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Newest modification time under a directory, or 0 if it doesn't exist.
 *
 * Used to compare sources against build output. `existsSync` alone cannot tell
 * a current build from a stale one, and a stale build is the normal state after
 * `git pull` — the directory is right there, just out of date.
 */
function newestMtime(dir, exts) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable or missing; treat as "nothing here"
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          // Raced with a delete; ignore.
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/** Workspaces to check for missing dependencies. */
const WORKSPACES = ["shared", "agent", "client"];

/**
 * True when `shared`'s sources are newer than its compiled output.
 *
 * Only `shared` is checked, because only `shared` is consumed as BUILD OUTPUT
 * at runtime: its package.json points at `dist/`, and both the agent and the
 * client import it that way. The agent itself runs from source via tsx, and the
 * client is served from source by Vite in dev, so their `dist/` directories
 * being stale changes nothing about what actually executes — flagging them
 * would mean a rebuild after every source edit for no benefit.
 *
 * Getting this wrong is quiet rather than loud. A protocol change that is not
 * rebuilt leaves new enum members `undefined`, so frames are labelled 0 (JPEG)
 * instead of 2 (H264) and the client tries to render video as an image: a blank
 * screen that looks like a rendering bug rather than a build problem.
 */
function buildIsStale() {
  const src = join(ROOT, "shared", "src");
  const dist = join(ROOT, "shared", "dist");
  if (!existsSync(src)) return false;
  if (!existsSync(dist)) return true;
  return newestMtime(src, [".ts", ".tsx"]) > newestMtime(dist, [".js", ".d.ts"]);
}

/**
 * Dependencies declared in a workspace but absent from node_modules.
 *
 * A pull that adds a dependency leaves node_modules present but incomplete, so
 * an existence check on the directory passes while the import still fails at
 * runtime with a bare "Cannot find module".
 */
function missingDependencies() {
  const missing = [];
  for (const pkg of ["", ...WORKSPACES]) {
    const manifest = join(ROOT, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    let deps;
    try {
      deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
    } catch {
      continue;
    }
    for (const name of Object.keys(deps)) {
      // Workspace siblings are symlinked by npm and may resolve from the root.
      if (name.startsWith("@bcsa/")) continue;
      if (
        !existsSync(join(ROOT, "node_modules", name)) &&
        !existsSync(join(ROOT, pkg, "node_modules", name))
      ) {
        missing.push(name);
      }
    }
  }
  return [...new Set(missing)];
}

/** Run a command inheriting the terminal. Ctrl-C stops the child, not the menu. */
function run(cmd, args) {
  return new Promise((resolve) => {
    console.log(color("dim", `\n$ ${cmd} ${args.join(" ")}\n`));
    // The menu's readline holds stdin in flowing mode. A child that inherits
    // this terminal and then asks a question — npm's own prompts, a package's
    // postinstall script, `sudo` wanting a password during `npm run setup` —
    // never sees a keystroke, because readline here consumes them first. The
    // child waits on input that can't arrive and the whole run looks frozen
    // until Ctrl-C. Hand stdin over for as long as the child owns the terminal.
    rl.pause();
    // Give the terminal back to the driver, not just to the child.
    //
    // readline puts a TTY into RAW mode when the interface is created, and
    // pause() does not undo that -- only close() does. In raw mode the driver
    // never generates SIGINT: Ctrl-C arrives as a plain 0x03 byte, which the
    // paused readline swallows. So Ctrl-C did nothing at all while a child ran
    // -- `npm run client` and friends could only be stopped by killing the
    // terminal. Cooked mode restores the normal behaviour, which is exactly
    // what this function's contract already promised: Ctrl-C stops the child.
    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    const done = (result) => {
      if (process.stdin.isTTY && wasRaw) process.stdin.setRawMode(true);
      process.stdin.resume();
      rl.resume();
      resolve(result);
    };
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, shell: IS_WIN });
    const swallow = () => {}; // keep the launcher alive while the child runs
    process.on("SIGINT", swallow);
    child.on("close", (code) => {
      process.removeListener("SIGINT", swallow);
      done(code ?? 0);
    });
    child.on("error", (err) => {
      process.removeListener("SIGINT", swallow);
      console.log(color("red", `  failed to start: ${err.message}`));
      done(1);
    });
  });
}

const npm = (script) => run("npm", ["run", script]);

/** One line per prerequisite so the user sees what's ready. */
function printStatus() {
  const missing = missingDependencies();
  const deps = existsSync(join(ROOT, "node_modules")) && missing.length === 0;
  const built = existsSync(join(ROOT, "shared", "dist")) && !buildIsStale();
  const ffmpeg = have("ffmpeg", ["-version"]);
  const cloudflared = have("cloudflared");
  const mark = (ok) => (ok ? color("green", "✓") : color("red", "•"));
  console.log(color("bold", "\n  Beamdesk\n"));
  console.log(
    `  ${mark(deps)} dependencies installed` +
      (missing.length ? color("dim", ` (missing: ${missing.slice(0, 3).join(", ")})`) : ""),
  );
  console.log(
    `  ${mark(built)} packages built ${built ? "" : color("dim", "(sources changed since last build)")}`,
  );
  console.log(`  ${mark(ffmpeg)} ffmpeg ${ffmpeg ? "" : color("dim", "(needed for high-fps video + WebRTC)")}`);
  console.log(`  ${mark(cloudflared)} cloudflared ${cloudflared ? "" : color("dim", "(optional — for tunnel)")}`);
  return { deps, built };
}

async function fullSetup() {
  if (!existsSync(join(ROOT, "node_modules"))) await run("npm", ["install"]);
  await npm("setup");
  await npm("build");
  console.log(color("green", "\n✓ Setup complete.\n"));
}

/**
 * Run only the setup steps whose outputs are missing, so a fresh clone becomes
 * runnable automatically. Skips entirely when everything is already in place.
 */
async function autoBootstrap() {
  // Staleness, not mere existence. After a `git pull` every path below exists
  // and is out of date, which is precisely when running stale code does the
  // most damage and explains the least.
  const needInstall = !existsSync(join(ROOT, "node_modules")) || missingDependencies().length > 0;
  const needFfmpeg = !have("ffmpeg", ["-version"]);
  const needBuild = buildIsStale();

  if (!needInstall && !needFfmpeg && !needBuild) return; // nothing to do

  console.log(color("amber", "\n  Setting up automatically (dependencies or build are out of date)…"));
  if (needInstall) await run("npm", ["install"]);
  // ffmpeg missing ⇒ likely an unconfigured machine: run the full prerequisite
  // installer (ffmpeg + optional cloudflared/audio + macOS native helper).
  if (needFfmpeg) await npm("setup");
  if (needInstall || needBuild) await npm("build");
  console.log(color("green", "\n✓ Ready.\n"));
}

/** Local test: agent in the background + client in the foreground. */
async function localTest() {
  console.log(color("cyan", "\nStarting the agent in the background, then the client…"));
  const agent = spawn("npm", ["run", "agent"], { stdio: "inherit", cwd: ROOT, shell: IS_WIN });
  await new Promise((r) => setTimeout(r, 3000)); // let the agent print its banner
  await npm("client"); // foreground; Ctrl-C returns here
  agent.kill();
}

/**
 * PID of the detached agent, or null if there's no PID file / it's stale.
 *
 * A stale PID file is the normal state after the machine reboots or the
 * process is killed out-of-band, so this also deletes the file when the
 * process it names is gone — callers don't have to remember to clean up.
 */
function backgroundAgentPid() {
  if (!existsSync(AGENT_PID_FILE)) return null;
  const pid = Number(readFileSync(AGENT_PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid)) {
    unlinkSync(AGENT_PID_FILE);
    return null;
  }
  try {
    process.kill(pid, 0); // existence check only; doesn't actually signal the process
    return pid;
  } catch {
    unlinkSync(AGENT_PID_FILE);
    return null;
  }
}

/**
 * Launch `npm run agent` detached on macOS/Linux.
 *
 * `detached: true` + `.unref()` is sufficient here: the child becomes its
 * own session/process group leader and outlives this process once it exits.
 */
function spawnDetachedPosix() {
  const out = openSync(AGENT_LOG_FILE, "a");
  const child = spawn("npm", ["run", "agent"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

/**
 * Launch `npm run agent` hidden on Windows.
 *
 * `detached: true` forces Node to give the child its own console window on
 * Windows, and `windowsHide` does not reliably suppress that once stdio is
 * redirected to real file handles instead of `"ignore"` (nodejs/node#21825,
 * #36808) — that combination is what popped a visible console for this
 * menu option. PowerShell's `Start-Process -WindowStyle Hidden` genuinely
 * hides the window; `-PassThru` hands back the real PID so `taskkill /T`
 * can still stop the whole tree later. Redirection is done by cmd's own
 * `>>`/`2>&1`, not Start-Process's -Redirect* params, because those require
 * stdout/stderr to be different files and we want one shared log.
 */
function spawnHiddenWindows() {
  const cmdLine = `cd /d "${ROOT}" && npm run agent >> "${AGENT_LOG_FILE}" 2>&1`;
  const psCommand =
    `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '${cmdLine.replace(/'/g, "''")}' ` +
    `-WindowStyle Hidden -PassThru; $p.Id`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCommand], {
    encoding: "utf8",
  });
  const pid = Number(result.stdout.trim());
  if (!Number.isInteger(pid)) {
    throw new Error(`Failed to start agent via PowerShell: ${result.stderr || result.stdout}`);
  }
  return pid;
}

/** Service context passed to scripts/agent-service.mjs. */
const SERVICE_CTX = { root: ROOT, logFile: AGENT_LOG_FILE };

/** Is the 007 login-autostart service installed and currently running? */
function bondIsActive() {
  try {
    const svc = serviceStatus(SERVICE_CTX);
    return svc.installed && svc.running;
  } catch {
    return false;
  }
}

/**
 * Both the plain background mode and 007 bind the same port (8443), so only
 * one may run the agent at a time — this is the same EADDRINUSE crash we hit
 * running both together during testing. Callers check this before starting
 * the agent any other way while 007 owns it.
 */
function refuseIfBondActive() {
  if (!bondIsActive()) return false;
  console.log(color("red", "\n  007 is already running the agent (login service). Use 'M (retire 007)' first.\n"));
  return true;
}

/** Run the agent detached so it outlives this launcher and its terminal. */
async function startAgentBackground() {
  if (refuseIfBondActive()) return;
  const running = backgroundAgentPid();
  if (running) {
    console.log(color("amber", `\n  Already running (pid ${running}). Log: ${AGENT_LOG_FILE}\n`));
    return;
  }
  mkdirSync(AGENT_DATA_DIR, { recursive: true });
  const pid = IS_WIN ? spawnHiddenWindows() : spawnDetachedPosix();
  writeFileSync(AGENT_PID_FILE, String(pid));
  console.log(color("green", `\n  Started in background (pid ${pid}). Log: ${AGENT_LOG_FILE}\n`));
}

/** Report whether the background agent is running, via either mechanism. */
function agentStatus() {
  const pid = backgroundAgentPid();
  if (pid) {
    console.log(color("green", `\n  Plain background: running (pid ${pid}). Log: ${AGENT_LOG_FILE}`));
  } else {
    console.log(color("dim", "\n  Plain background: not running."));
  }
  try {
    const svc = serviceStatus(SERVICE_CTX);
    if (svc.installed && svc.running) {
      console.log(color("green", `  007 (login autostart): running${svc.pid ? ` (pid ${svc.pid})` : ""}.\n`));
    } else if (svc.installed) {
      console.log(color("amber", "  007 (login autostart): installed, not currently running.\n"));
    } else {
      console.log(color("dim", "  007 (login autostart): not installed.\n"));
    }
  } catch (err) {
    console.log(color("red", `  007 status check failed: ${err.message}\n`));
  }
}

/** Install 007: stop any plain-background instance, then install + start the login service. */
function installBond() {
  if (backgroundAgentPid()) stopAgentBackground();
  try {
    installService(SERVICE_CTX);
    console.log(
      color("green", `\n  007 is live. Starts automatically at login, restarts if it crashes. Log: ${AGENT_LOG_FILE}\n`),
    );
    if (IS_MAC) {
      console.log(
        color(
          "amber",
          "  macOS note: a permission you granted to Terminal (Accessibility, Screen Recording) doesn't carry over\n" +
            "  to a launchd-run process — it may need granting again to whatever binary shows up in the log below if\n" +
            "  the agent keeps restarting. Check Agent status / the log if it doesn't come up.\n",
        ),
      );
    }
  } catch (err) {
    console.log(color("red", `\n  Failed to install: ${err.message}\n`));
  }
}

/** Retire 007: stop it and remove the login-autostart registration. */
function retireBond() {
  try {
    uninstallService(SERVICE_CTX);
    console.log(color("green", "\n  007 has been retired. No longer starts at login.\n"));
  } catch (err) {
    console.log(color("red", `\n  Failed to retire: ${err.message}\n`));
  }
}

/**
 * Stop the background agent, if any.
 *
 * `npm run agent` spawns further children (npm's own child, then tsx), and
 * npm does not forward SIGTERM to them — signaling only the npm pid we
 * recorded leaves the real agent process running. `detached: true` made that
 * pid a new process group leader, so signaling the whole group (the negative
 * pid) on POSIX reaches every descendant. Windows has no process groups, so
 * `taskkill /T` walks the process tree instead.
 */
function stopAgentBackground() {
  const pid = backgroundAgentPid();
  if (!pid) {
    console.log(color("dim", "\n  Not running.\n"));
    return;
  }
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(-pid);
  }
  unlinkSync(AGENT_PID_FILE);
  console.log(color("green", `\n  Stopped (pid ${pid}).\n`));
}

const MENU = `
  ${color("bold", "What do you want to run?")}

  ${color("amber", "1")}  Full setup            install deps + prerequisites + build ${color("dim", "(run first)")}
  ${color("amber", "2")}  Run agent             ${color("dim", "this machine gets controlled + streamed")}
  ${color("amber", "3")}  Run agent (background)${color("dim", " keeps running after this terminal closes")}
  ${color("amber", "4")}  Agent status          ${color("dim", "is the background agent running?")}
  ${color("amber", "5")}  Stop background agent
  ${color("amber", "6")}  007 James Bond        ${color("dim", "auto-start on login, survives reboot + crashes")}
  ${color("amber", "7")}  M (retire 007)        ${color("dim", "stop + remove the login-autostart service")}
  ${color("amber", "8")}  Run client            ${color("dim", "control another machine from your browser")}
  ${color("amber", "9")}  Run tunnel            ${color("dim", "expose the agent over Cloudflare (remote)")}
  ${color("amber", "10")} Rebuild               ${color("dim", "recompile all packages")}
  ${color("amber", "11")} Local test            ${color("dim", "agent + client on this machine")}
  ${color("amber", "q")}  Quit
`;

async function main() {
  await autoBootstrap(); // install/build/prereqs if anything essential is missing
  printStatus();
  for (;;) {
    console.log(MENU);
    const choice = (await ask(color("amber", "  › "))).trim().toLowerCase();
    switch (choice) {
      case "1": await fullSetup(); break;
      case "2": if (!refuseIfBondActive()) await npm("agent"); break;
      case "3": await startAgentBackground(); break;
      case "4": agentStatus(); break;
      case "5": stopAgentBackground(); break;
      case "6": installBond(); break;
      case "7": retireBond(); break;
      case "8": await npm("client"); break;
      case "9": await npm("tunnel"); break;
      case "10": await npm("build"); break;
      case "11": await localTest(); break;
      case "q": case "quit": case "exit":
        rl.close();
        return;
      default:
        console.log(color("red", "  Pick 1–11 or q."));
    }
  }
}

main().then(() => process.exit(0));
