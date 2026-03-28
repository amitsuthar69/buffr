let _meta = null;

async function getMeta() {
  if (_meta) return _meta;
  const config = await Neutralino.app.getConfig();
  _meta = {
    WIDGET_NAME: config.cli.binaryName,
    HOME: await Neutralino.os.getEnv("HOME"),
  };
  return _meta;
}

/**
 * We need to make sure that even if the distributed binaries are moved acorss user directories,
 * the auto start execution logic for each OS always point to a stable directory.
 * In our use case, copyToStableDir() will copy the original downloaded binary to a
 * stable directory:
 *    ~/.local/share/neuwidget/ for linux
 *    %LOCALAPPDATA%\neuwidget\ for windows
 *    ~/Library/Application Support/neuwidget/ for macOS
 */
async function copyToStableDir() {
  // todo: delete original binary after copying to stable dir???

  const currPath = await execPathProvider();
  const dstDir = await getStableDir();

  try {
    await Neutralino.filesystem.createDirectory(dstDir);
    await Neutralino.filesystem.copy(currPath, dstDir);
    if (NL_OS !== "Windows") {
      const exe = currPath.substring(currPath.lastIndexOf("/") + 1);
      await Neutralino.os.execCommand(`chmod +x ${dstDir}/${exe}`);
    }
    Neutralino.debug.log(`Installed to: ${dstDir}`, "INFO");
  } catch (error) {
    Neutralino.debug.log(
      `copyToStableDir failed: ${JSON.stringify(error)}`,
      "ERROR"
    );
  }
}

async function getStableDir() {
  const { WIDGET_NAME, HOME } = await getMeta();
  if (NL_OS === "Linux") {
    return `${HOME}/.local/share/${WIDGET_NAME}`;
  }
  if (NL_OS === "Darwin") {
    return `${HOME}/Library/Application Support/${WIDGET_NAME}`;
  }
  if (NL_OS === "Windows") {
    return `${await Neutralino.os.getEnv("LOCALAPPDATA")}\\${WIDGET_NAME}`;
  }
}

/**
 * Ensures the widget auto-launches on every system login.
 *
 * This function is designed to be called once per session inside `wdg.onReady()`.
 * It is safe to call on every launch — it exits early if autostart is already set up.
 *
 * @export
 * @returns {Promise<void>}
 *
 * @example
 * wdg.onReady(() => autoStart());
 */
export async function autoStart() {
  const { WIDGET_NAME } = await getMeta();

  const execPath = await execPathProvider();
  const dir = await getStableDir();
  if (!execPath.startsWith(dir)) {
    await copyToStableDir();
  }

  const launch = await isAutoStartEnabled();
  if (launch.enabled) return;

  if (launch.status === "denied") {
    await Neutralino.os.showNotification(
      `Permission denied to create auto start entry for ${WIDGET_NAME}!`,
      "ERROR"
    );
    return;
  }

  try {
    await _autoStart();
    Neutralino.debug.log(`Autostart: enabled for ${WIDGET_NAME}`, "INFO");
  } catch (error) {
    Neutralino.debug.log(
      `Autostart: failed to enable for ${WIDGET_NAME}: ${JSON.stringify(
        error
      )}`,
      "ERROR"
    );
  }
}

async function _autoStart() {
  const { WIDGET_NAME, HOME } = await getMeta();

  if (NL_OS === "Linux") return await enableLinux(WIDGET_NAME, HOME);
  if (NL_OS === "Windows") return await enableWindows(WIDGET_NAME);
  if (NL_OS === "Darwin") return await enableMacOS(WIDGET_NAME);
}

async function isAutoStartEnabled() {
  const { WIDGET_NAME, HOME } = await getMeta();

  if (NL_OS === "Linux") return await checkLinux(WIDGET_NAME, HOME);
  if (NL_OS === "Windows") return await checkWindows(WIDGET_NAME);
  if (NL_OS === "Darwin") return await checkMacOS(WIDGET_NAME);
  return { enabled: true, status: "ok" };
}

// -- Linux --

async function checkLinux(WIDGET_NAME, HOME) {
  const PATH = `${HOME}/.config/autostart/${WIDGET_NAME}.desktop`;

  try {
    await Neutralino.filesystem.getStats(PATH);
    return { enabled: true, status: "ok" };
  } catch (error) {
    if (error.code === "NE_FS_NOPATHE") {
      return { enabled: false, status: "not-found" };
    }
    if (
      error.code === "NE_FS_EACCES" ||
      error.code === "EACCES" ||
      error.code === "EPERM"
    ) {
      return { enabled: false, status: "denied" };
    }

    Neutralino.debug.log(
      `Unexpected Error in checkLinux: ${JSON.stringify(error)}`,
      "ERROR"
    );
    return { enabled: false, status: "error" };
  }
}

async function enableLinux(WIDGET_NAME, HOME) {
  const stableDir = await getStableDir();
  const currPath = await execPathProvider();
  const binaryFileName = currPath.substring(currPath.lastIndexOf("/") + 1);
  const execPath = `${stableDir}/${binaryFileName}`;
  const dir = `${HOME}/.config/autostart`;
  const file = `${dir}/${WIDGET_NAME}.desktop`;

  const entry = `[Desktop Entry]
Type=Application
Name=${WIDGET_NAME}
Exec=${execPath}
Hidden=false
Terminal=false
X-GNOME-Autostart-Enabled=true
X-GNOME-Autostart-Delay=0
`;

  try {
    await Neutralino.filesystem
      .createDirectory(`${HOME}/.config`)
      .catch(() => {});
    await Neutralino.filesystem.createDirectory(dir).catch(() => {});
    await Neutralino.filesystem.writeFile(file, entry);
    Neutralino.debug.log(`Desktop entry created: ${file}`, "INFO");
  } catch (error) {
    await Neutralino.os.showNotification(
      `Couldn't create auto start entry for ${WIDGET_NAME}!`,
      "ERROR"
    );
  }
}

// -- Windows --

async function checkWindows(WIDGET_NAME) {
  const cmd = `reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ${WIDGET_NAME}`;
  try {
    const res = await Neutralino.os.execCommand(cmd);
    return {
      enabled: res.exitCode === 0,
      status: res.exitCode === 0 ? "ok" : "not-found",
    };
  } catch (error) {
    Neutralino.debug.log(
      `Unexpected Error in checkWindows: ${JSON.stringify(error)}`,
      "ERROR"
    );
    return { enabled: false, status: "error" };
  }
}

async function enableWindows(WIDGET_NAME) {
  const stableDir = await getStableDir();
  const currPath = await execPathProvider();
  const binaryFileName = currPath.substring(currPath.lastIndexOf("\\") + 1);
  const execPath = `${stableDir}\\${binaryFileName}`;

  const cmd =
    `reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run ` +
    `/v "${WIDGET_NAME}" /t REG_SZ /d "${execPath}" /f`;
  const res = await Neutralino.os.execCommand(cmd);
  if (res.exitCode !== 0) {
    await Neutralino.os.showNotification(
      `Couldn't create auto start entry for ${WIDGET_NAME}!`,
      "ERROR"
    );
  }
}

// -- MacOS --

async function checkMacOS(WIDGET_NAME) {
  const cmd = `osascript -e 'tell application "System Events" to get the name of every login item'`;
  try {
    const res = await Neutralino.os.execCommand(cmd);
    return {
      enabled: res.stdOut.includes(WIDGET_NAME),
      status: res.stdOut.includes(WIDGET_NAME) ? "ok" : "not-found",
    };
  } catch (error) {
    Neutralino.debug.log(
      `Unexpected Error in checkMacOS: ${JSON.stringify(error)}`,
      "ERROR"
    );
    return { enabled: false, status: "denied" };
  }
}

async function enableMacOS(WIDGET_NAME) {
  const stableDir = await getStableDir();
  const currPath = await execPathProvider();
  const binaryFileName = currPath.substring(currPath.lastIndexOf("/") + 1);
  const execPath = `${stableDir}/${binaryFileName}`;

  const cmd =
    `osascript -e 'tell application "System Events" ` +
    `to make login item at end with properties {path:"${execPath}", hidden:false}'`;

  const res = await Neutralino.os.execCommand(cmd);
  if (res.exitCode !== 0) {
    await Neutralino.os.showNotification(
      `Couldn't create auto start entry for ${WIDGET_NAME}!`,
      "ERROR"
    );
  }
}

/**
 * The widget binary distribution is uncertain.
 * If the widget provider expects the end user to download the executable and if the download location of user is not fixed,
 * we must know where the downloaded executable resides in the OS for the auto start script to launch it on startup.
 *
 * As the auto launch entry is created after the program runs for the first time, we can ask the OS to provide us the
 * executable's path based on the OS.
 */

async function getExecPath() {
  const pid = typeof NL_PID !== "undefined" ? NL_PID : null;
  const os = typeof NL_OS !== "undefined" ? NL_OS : null;

  if (!pid || !os) {
    throw new Error(
      `Couldn't get PID or OS, ensure Neutralino.Init() has run.`
    );
  }

  try {
    if (os === "Linux") {
      const res = await Neutralino.os.execCommand(
        `readlink -f /proc/${pid}/exe`
      );
      if (res.exitCode === 0 && res.stdOut) {
        return res.stdOut.trim();
      }
      throw new Error(
        `Unable to locate executable path (linux): exit code = ${res.exitCode}`
      );
    }

    if (os === "Darwin") {
      const res = await Neutralino.os.execCommand(
        `lsof -p ${pid} | awk '/\\btxt\\b/ {print $9; exit}'`
      );
      if (res.exitCode === 0 && res.stdOut && res.stdOut.trim()) {
        const path = res.stdOut.trim();
        if (path.startsWith("/")) return path;
      }

      const res_fallback = await Neutralino.os.execCommand(
        `ps -p ${pid} -ww -o args=`
      );
      if (res_fallback.exitCode === 0 && res_fallback.stdOut) {
        const path = res_fallback.stdOut.trim().split(/\s(?=--?)/)[0];
        if (path.startsWith("/")) return path;
        if (path.startsWith(".")) {
          return `${window.NL_CWD}/${path.replace(/^\.\//, "")}`;
        }
      }

      throw new Error(
        `Unable to locate executable path (MacOS): exit code = ${
          res.exitCode || res_fallback.exitCode
        }`
      );
    }

    if (os === "Windows") {
      const res = await Neutralino.os.execCommand(
        `powershell -NoProfile -NonInteractive -Command "(Get-Process -Id ${pid}).Path"`
      );
      if (res.exitCode === 0 && res.stdOut) {
        const path = res.stdOut.trim().replace(/\r/g, "");
        if (path) return path;
      }

      const res_fallback = await Neutralino.os.execCommand(
        `wmic process where ProcessId=${pid} get ExecutablePath /value`
      );
      if (res_fallback.exitCode === 0 && res_fallback.stdOut) {
        const path = res_fallback.stdOut.match(/ExecutablePath=(.+)/i);
        if (path && path[1]) return path[1].trim();
      }

      throw new Error(
        `Unable to locate executable path (Windows): exit code = ${
          res.exitCode || res_fallback.exitCode
        }`
      );
    }

    throw new Error(`Unsupported Platform: ${os}`);
  } catch (error) {
    throw new Error(`getExecPath failed: ${error}`);
  }
}

async function execPathProvider() {
  const { WIDGET_NAME, HOME } = await getMeta();

  let execPath;
  try {
    execPath = await getExecPath();
  } catch (error) {
    Neutralino.debug.log(
      `failed to getExecPath: ${JSON.stringify(error)}`,
      "ERROR"
    );
    // fallback to most generic path
    execPath = `${HOME}/Downloads/${WIDGET_NAME}`;
  }
  return execPath;
}
