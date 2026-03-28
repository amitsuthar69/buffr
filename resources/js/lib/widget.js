/**
 * @file widget.js - NeutralinoJS Widget Scaffolding
 *
 * A lightweight class that wraps NeutralinoJS APIs into a clean lifecycle,
 * providing drag, resize, shortcuts, storage, polling, plugins, and more.
 *
 * @example
 * import { Widget } from "./lib/widget.js";
 *
 * const wdg = new Widget({ draggable: true, resizable: true });
 *
 * wdg.onReady(() => wdg.poll(updateUI, 1000));
 * wdg.onQuit(() => wdg.store.set("lastSeen", Date.now()));
 */
export class Widget {
  /**
   * Creates a new Widget instance and initialises the Neutralino runtime.
   *
   * The constructor immediately calls `Neutralino.init()` and listens for the
   * `"ready"` and `"windowClose"` events. Widget boot begins automatically
   * when Neutralino fires `"ready"`.
   *
   * @param {Object}  [options]                       - Widget configuration.
   * @param {boolean} [options.draggable=true]         - Allow the window to be dragged by clicking anywhere.
   * @param {string}  [options.dragTarget="body"]      - CSS selector of the element that initiates drag.
   * @param {boolean} [options.alwaysOnTop=true]       - Keep the widget above all other windows.
   * @param {boolean} [options.resizable=false]        - Inject corner handles to allow manual resizing.
   * @param {Object}  [options.shortcuts={}]           - Additional keyboard shortcuts map `{ "combo": fn }`.
   *                                                     `ctrl+q` to quit is always registered automatically.
   *
   */
  constructor(options = {}) {
    this.opts = {
      draggable: options.draggable ?? true,
      dragTarget: options.dragTarget ?? "body",
      alwaysOnTop: options.alwaysOnTop ?? true,
      resizable: options.resizable ?? false,
      shortcuts: options.shortcuts ?? {},
    };

    this._booted = false;
    this._plugins = [];
    this._readyCallbacks = [];
    this._quitCallbacks = [];
    this._stopPolls = [];

    // overriding the actual quit method with _quit so that before quitting we call onQuit
    this._ogQuit = this.quit.bind(this);
    this.quit = this._quit.bind(this);

    Neutralino.init();
    Neutralino.events.on("ready", () => this._boot());
    Neutralino.events.on("windowClose", () => this.quit());
  }

  // Lifecycle

  async _boot() {
    if (this.opts.alwaysOnTop) await Neutralino.window.setAlwaysOnTop(true);
    if (this.opts.draggable) this.setupDrag();
    if (this.opts.resizable) this.setupResize();

    this.setupShortcuts({
      "ctrl+q": () => this.quit(),
      ...this.opts.shortcuts,
    });

    for (const plugin of this._plugins) await plugin.init?.(this);
    for (const fn of this._readyCallbacks) await fn(this);
    this._booted = true;
  }

  /**
   * Shows the widget window.
   * @returns {Promise<void>}
   */
  async show() {
    await Neutralino.window.show();
  }

  /**
   * Hides the widget window without terminating the process.
   * @returns {Promise<void>}
   */
  async hide() {
    await Neutralino.window.hide();
  }

  /**
   * Minimises the widget window.
   * @returns {Promise<void>}
   */
  async minimize() {
    await Neutralino.window.minimize();
  }

  /**
   * Terminates the Widget process immediately.
   *
   * In normal usage, prefer calling `wdg.quit()` directly - it is automatically
   * overridden at construction time to run `onQuit` callbacks before exiting.
   *
   * @returns {void}
   */
  quit() {
    Neutralino.app.exit();
  }

  /**
   * Registers a callback to run after the widget has fully booted.
   *
   * Each call to `onReady` registers one independent effect - prefer many small
   * focused callbacks over one large callback:
   *
   * ```js
   * wdg.onReady(() => autoStart());
   * wdg.onReady(() => wdg.poll(updateClock, 1000));
   * wdg.onReady(async () => {await wdg.store.set("key", "value")});
   * ```
   *
   * Callbacks are awaited in registration order.
   *
   * @param {function(Widget): (void|Promise<void>)} fn - Effect to run on ready.
   * @returns {Widget} `this` - supports chaining.
   */
  onReady(fn) {
    if (this._booted) {
      Promise.resolve().then(() => fn(this));
    } else {
      this._readyCallbacks.push(fn);
    }
    return this;
  }

  /**
   * Registers a callback to run when the widget is about to quit.
   *
   * Callbacks are run in **reverse registration order** (last-in, first-out).
   * All callbacks are awaited, so async cleanup (e.g. flushing a store,
   * waiting for a network call) is fully supported.
   *
   * Errors thrown inside callbacks are caught and logged - they do not
   * prevent subsequent callbacks or the final `Neutralino.app.exit()` call.
   *
   * @param {function(Widget): (void|Promise<void>)} fn - Cleanup function to run before exit.
   * @returns {Widget} `this` - supports chaining.
   *
   * @example
   * wdg.onQuit(async () => {await wdg.store.set("lastSeen", Date.now())});
   */
  onQuit(fn) {
    this._quitCallbacks.push(fn);
    return this;
  }

  async _quit() {
    for (const stop of this._stopPolls) stop();
    this._stopPolls.length = 0;

    for (const fn of [...this._quitCallbacks].reverse()) {
      try {
        await Promise.resolve(fn(this));
      } catch (error) {
        Neutralino.debug.log(`Error quitting: ${error.message}`, "ERROR");
      }
    }
    this._ogQuit();
  }

  // Drag

  /**
   * Wires native OS window drag to a DOM element.
   *
   * Automatically called during boot when `draggable: true`. Call manually
   * to attach drag to a custom element after boot.
   *
   * @param {string} [selector] - CSS selector of the drag target.
   *                              Defaults to the `dragTarget` option (`"body"`).
   *
   * @example
   * wdg.setupDrag("#header"); // Drag only from the header bar
   */
  setupDrag(selector) {
    const el = document.querySelector(selector ?? this.opts.dragTarget);
    el?.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("--wdg-handle")) return;
      Neutralino.window.beginDrag();
    });
  }

  // Resize

  /**
   * Injects invisible 16×16px corner handles into `document.body` that let
   * the user resize the window by dragging any corner.
   *
   * The widget opens at its natural content size, and the
   * user can drag any corner to grow or shrink it from there. Responsiveness
   * of inner content is the widget author's responsibility.
   *
   * Automatically called during boot when `resizable: true`.
   *
   * @returns {void}
   */
  setupResize() {
    injectResizeStyles();

    // Four corners: which dimension each one controls
    const corners = [
      { id: "nw", cursor: "nwse-resize" },
      { id: "ne", cursor: "nesw-resize" },
      { id: "se", cursor: "nwse-resize" },
      { id: "sw", cursor: "nesw-resize" },
    ];

    for (const corner of corners) {
      const handle = document.createElement("div");
      handle.className = `--wdg-handle --wdg-handle-${corner.id}`;
      handle.style.cursor = corner.cursor;
      document.body.appendChild(handle);
      handle.addEventListener("mousedown", (e) =>
        this._startResize(e, corner.id)
      );
    }
  }

  async _startResize(e, corner) {
    e.preventDefault();
    e.stopPropagation();

    const r = window.devicePixelRatio || 1;

    const startX = e.screenX * r;
    const startY = e.screenY * r;

    const { width: startW, height: startH } = await Neutralino.window.getSize();
    const { x: startPosX, y: startPosY } =
      await Neutralino.window.getPosition();

    const MIN_SIZE = 80;
    const THROTTLE = 40;
    let lastCall = 0;

    const onMouseMove = (e) => {
      const now = Date.now();
      if (now - lastCall < THROTTLE) return;
      lastCall = now;

      const dx = e.screenX * r - startX;
      const dy = e.screenY * r - startY;

      let newW = startW,
        newH = startH,
        newX = startPosX,
        newY = startPosY;

      if (corner === "se") {
        newW = startW + dx;
        newH = startH + dy;
      }
      if (corner === "sw") {
        newW = startW - dx;
        newH = startH + dy;
        newX = startPosX + dx;
      }
      if (corner === "ne") {
        newW = startW + dx;
        newH = startH - dy;
        newY = startPosY + dy;
      }
      if (corner === "nw") {
        newW = startW - dx;
        newH = startH - dy;
        newX = startPosX + dx;
        newY = startPosY + dy;
      }

      newW = Math.max(MIN_SIZE, Math.round(newW));
      newH = Math.max(MIN_SIZE, Math.round(newH));

      Neutralino.window.setSize({ width: newW, height: newH });

      // Move window when dragging from top or left edges to keep opposite edge fixed
      if (corner === "sw")
        Neutralino.window.move(Math.round(newX), Math.round(startPosY));
      if (corner === "ne")
        Neutralino.window.move(Math.round(startPosX), Math.round(newY));
      if (corner === "nw")
        Neutralino.window.move(Math.round(newX), Math.round(newY));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // Shortcuts

  /**
   * Registers keyboard shortcuts that fire when the widget window is focused.
   *
   * Accepts a map of combo strings to handler functions. Modifier keys:
   * `ctrl`, `shift`, `alt`, `meta`.
   *
   *
   * @param {Object.<string, function>} map - Shortcut map `{ "combo": fn }`.
   * @returns {void}
   *
   * @example
   * wdg.setupShortcuts({
   *   "ctrl+shift+r": () => location.reload(),
   *   "ctrl+h":       () => wdg.hide(),
   * });
   */
  setupShortcuts(map) {
    const normalised = {};
    for (const [combo, fn] of Object.entries(map)) {
      normalised[parseCombo(combo)] = fn;
    }
    document.addEventListener("keydown", (e) => {
      const action = normalised[parseEvent(e)];
      if (action) {
        e.preventDefault();
        action();
      }
    });
  }

  /**
   * A simple async key/value store backed by `Neutralino.storage` API.
   *
   * Values are automatically serialised to JSON on write and deserialised on
   * read, so any JSON-serialisable value can be stored.
   *
   * All the items are stored in a `.storage` file on the system, at the place of first execution.
   *
   * @type {{
   *   get:     (key: string) => Promise<any>,
   *   set:     (key: string, value: any) => Promise<store>,
   *   remove:  (key: string) => Promise<void>,
   *   getKeys: () => Promise<string[]>,
   *   clear:   () => Promise<void>
   * }}
   *
   * @example
   * await wdg.store.set("theme", { color: "dark" });
   * const theme = await wdg.store.get("theme"); // { color: "dark" }
   * await wdg.store.remove("theme");
   * const keys = await wdg.store.getKeys();
   */
  get store() {
    if (!this._store) {
      this._store = {
        /**
         * Retrieves and deserialises a value by key.
         * Returns `null` if the key does not exist or on error.
         *
         * @param {string} key
         * @returns {Promise<any>}
         */
        async get(key) {
          try {
            const data = await Neutralino.storage.getData(String(key));
            return data ? JSON.parse(data) : null;
          } catch (error) {
            Neutralino.debug.log(
              `Error getting key: ${key} - ${error}`,
              "ERROR"
            );
            return null;
          }
        },

        /**
         * Serialises and stores a value by key.
         * Returns the store instance for chaining.
         *
         * @param {string} key
         * @param {any} value - Any JSON-serialisable value.
         * @returns {Promise<store>}
         */
        async set(key, value) {
          try {
            await Neutralino.storage.setData(
              String(key),
              JSON.stringify(value)
            );
          } catch (error) {
            Neutralino.debug.log(
              `Error setting key: ${key} - ${error}`,
              "ERROR"
            );
          }
          return this;
        },

        /**
         * Removes a key from the store.
         *
         * @param {string} key
         * @returns {Promise<void>}
         */
        async remove(key) {
          try {
            await Neutralino.storage.removeData(String(key));
          } catch (error) {
            Neutralino.debug.log(
              `Error removing key: ${key} - ${error}`,
              "ERROR"
            );
          }
        },

        /**
         * Returns all keys currently stored.
         *
         * @returns {Promise<string[]>}
         */
        async getKeys() {
          return await Neutralino.storage.getKeys();
        },

        /**
         * Clears all stored keys and values.
         *
         * @returns {Promise<void>}
         */
        async clear() {
          await Neutralino.storage.clear();
        },
      };
    }
    return this._store;
  }

  // Helpers

  /**
   * Runs `fn` immediately, then repeatedly every `ms` milliseconds.
   *
   * Returns a `stop()` function that cancels the interval. All active polls
   * are automatically stopped when `wdg.quit()` is called - the stop function
   * is only needed if you want to cancel a specific poll early.
   *
   * @param {function(): void} fn  - Function to call on each tick.
   * @param {number}           ms  - Interval duration in milliseconds.
   * @returns {function(): void}   Stop function - call it to cancel the poll.
   *
   * @example
   * const stop = wdg.poll(updateClock, 1000);
   */
  poll(fn, ms) {
    fn();
    const id = setInterval(fn, ms);
    const stop = () => clearInterval(id);
    this._stopPolls.push(stop);
    return stop;
  }

  /**
   * Registers a plugin with the widget.
   *
   * A plugin is any object with an optional `async init(wdg)` method.
   * Plugins are initialised in registration order during `_boot()`, before
   * `onReady` callbacks run, so they are available to all ready effects.
   *
   * @param {{ init?: function(Widget): Promise<void> }} plugin
   * @returns {Widget} `this` - supports chaining.
   *
   * @example
   * const myPlugin = {
   *   async init(wdg) {
   *     wdg.log("plugin ready", "INFO");
   *   }
   * };
   *
   * wdg.use(myPlugin);
   */
  use(plugin) {
    this._plugins.push(plugin);
    return this;
  }

  /**
   * Logs values with provided level (`"INFO"`, `"WARNING"`, `"ERROR"`)
   *
   * @param {any} message - Value to log.
   * @param {string} type - Log level
   *
   * @returns {void}
   *
   * @example
   * wdg.log("widget started");             // INFO (default)
   * wdg.log("something failed", "ERROR");  // ERROR
   */
  log(message, type = "INFO") {
    const VALID = ["INFO", "WARNING", "ERROR"];
    const lvl = String(type).toUpperCase();
    Neutralino.debug.log(message, VALID.includes(lvl) ? lvl : "INFO");
  }

  /**
   * Executes a system command via Neutralino.
   *
   * @param {string} cmd - Command to execute.
   * @param {Object} [opts]
   * @param {boolean} [opts.background=false] - Run detached; skips exit-code check.
   * @param {string} [opts.cwd] - Working directory.
   * @param {Object} [opts.envs] - Environment variables as key-value pairs.
   * @param {string} [opts.stdIn] - Standard input passed to the command.
   *
   * @returns {Promise<{
   *   pid: number,
   *   stdOut: string,
   *   stdErr: string,
   *   code: number
   * }>}
   *
   * @throws {Error} If the command fails (non-zero exit) or Neutralino rejects.
   *
   * @example
   * // Basic usage
   * const { stdOut } = await wdg.exec("ls -la");
   * wdg.log(stdOut);
   *
   * // With working directory and env vars
   * const res = await wdg.exec("node build.js", {
   *   cwd: "/home/user/project",
   *   envs: { NODE_ENV: "production" },
   * });
   */
  async exec(cmd, opts = {}) {
    try {
      const res = await Neutralino.os.execCommand(cmd, opts);
      const output = {
        pid: res.pid,
        stdOut: res.stdOut || "",
        stdErr: res.stdErr || "",
        code: res.exitCode,
      };

      if (!opts.background && output.code !== 0) {
        throw new Error(
          `Command failed (exit ${output.code}) : ${cmd}\n${
            output.stdErr || output.stdOut
          }`
        );
      }

      return output;
    } catch (error) {
      const msg = `exec failed for "${cmd}": ${error.message}`;
      Neutralino.debug.log(msg, "ERROR");
      throw new Error(msg);
    }
  }
}

// Resize handle styles
function injectResizeStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .--wdg-handle {
      position: fixed;
      width: 16px;
      height: 16px;
      z-index: 9999;
    }
    .--wdg-handle-nw { top: 0;    left: 0;  }
    .--wdg-handle-ne { top: 0;    right: 0; }
    .--wdg-handle-se { bottom: 0; right: 0; }
    .--wdg-handle-sw { bottom: 0; left: 0;  }
  `;
  document.head.appendChild(style);
}

// Shortcut parsing

function parseCombo(combo) {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((s) => s.trim());
  const mods = ["ctrl", "shift", "alt", "meta"].filter((m) =>
    parts.includes(m)
  );
  const key = parts.find((p) => !["ctrl", "shift", "alt", "meta"].includes(p));
  return [...mods, key].join("+");
}

function parseEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return [...mods, e.key.toLowerCase()].join("+");
}
