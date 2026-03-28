import { Widget } from "./lib/widget.js";
import { autoStart } from "./lib/autostart.js";

const wdg = new Widget({
  draggable: true,
  resizable: true,
  shortcuts: {
    "ctrl+shift+r": () => location.reload(),
  },
});

wdg.onReady(async () => {
  await loadClips();
  setInterval(refreshTimestamps, 30000);
  readClipEvent();
  await autoStart();
});

const Buffr = new Map();
const timeoutMap = new Map();
let lastText = null;
let lastFingerprint = null;
let ignoreNextChange = false;
const TTL = 3600000;
const HISTORY_LIMIT = 30;

const ICON_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18"/><path d="M3 12h18"/><path d="M3 19h18"/></svg>`;
const ICON_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
const ICON_DELETE = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;

async function readClipEvent() {
  wdg.poll(async () => {
    const format = await Neutralino.clipboard.getFormat();

    if (format === "text") {
      const text = await Neutralino.clipboard.readText();
      if (!text || text === lastText) return;

      if (ignoreNextChange) {
        ignoreNextChange = false;
        lastText = text;
        return;
      }

      lastText = text;
      pushClip({ format: "text", content: text });
    }

    if (format === "image") {
      const img = await Neutralino.clipboard.readImage();
      if (!img) return;

      const fingerprint = `${img.width}_${img.height}_${img.bpr}`;
      if (fingerprint === lastFingerprint) return;

      if (ignoreNextChange) {
        ignoreNextChange = false;
        lastFingerprint = fingerprint;
        return;
      }

      lastFingerprint = fingerprint;

      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas
        .getContext("2d")
        .putImageData(
          new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
          0,
          0
        );

      pushClip({
        format: "image",
        dataUrl: canvas.toDataURL("image/png"),
        raw: img,
      });
    }
  }, 1000);
}

function pushClip(partial) {
  if (Buffr.size >= HISTORY_LIMIT) {
    const oldestId = Buffr.keys().next().value;
    discardClip(oldestId);
  }

  const id = generateClipId();
  const clip = { id, copiedAt: Date.now(), ttl: TTL, ...partial };

  Buffr.set(id, clip);

  if (clip.format === "text") wdg.store.set(id, clip);

  scheduleExpiry(clip);
  renderClips();
}

function scheduleExpiry(clip) {
  const remaining = clip.copiedAt + clip.ttl - Date.now();
  const timeoutId = setTimeout(() => discardClip(clip.id), remaining);
  timeoutMap.set(clip.id, timeoutId);
}

async function discardClip(id) {
  clearTimeout(timeoutMap.get(id));
  timeoutMap.delete(id);
  Buffr.delete(id);
  await wdg.store.remove(id);
  renderClips();
}

async function restoreClip(id) {
  const clip = Buffr.get(id);
  if (!clip) return;

  ignoreNextChange = true;

  if (clip.format === "text") {
    lastText = clip.content;
    await Neutralino.clipboard.writeText(clip.content);
  }

  if (clip.format === "image") {
    lastFingerprint = `${clip.raw.width}_${clip.raw.height}_${clip.raw.bpr}`;
    await Neutralino.clipboard.writeImage(clip.raw);
  }

  clearTimeout(timeoutMap.get(id));
  clip.copiedAt = Date.now();
  Buffr.delete(id);
  Buffr.set(id, clip);

  if (clip.format === "text") await wdg.store.set(id, clip);

  scheduleExpiry(clip);
  renderClips();
}

async function loadClips() {
  let keys;
  try {
    keys = await wdg.store.getKeys();
  } catch {
    return;
  }

  for (const key of keys) {
    if (!key.startsWith("clip_")) continue;

    const clip = await wdg.store.get(key);
    if (!clip) continue;

    if (Date.now() > clip.copiedAt + clip.ttl) {
      await wdg.store.remove(key);
      continue;
    }

    Buffr.set(clip.id, clip);
    scheduleExpiry(clip);
  }

  renderClips();
}

function renderClips() {
  const container = document.getElementById("items-container");
  const badge = document.getElementById("badge");

  container.innerHTML = "";
  badge.textContent = Buffr.size;

  if (Buffr.size === 0) {
    container.innerHTML = `<div class="empty-state">Nothing copied yet</div>`;
    return;
  }

  const clips = [...Buffr.values()].reverse();

  for (const clip of clips) {
    const item = document.createElement("div");
    item.className = "item";
    item.dataset.id = clip.id;

    const preview =
      clip.format === "image"
        ? `<img src="${clip.dataUrl}" class="img-preview" />`
        : `<div class="preview">${escapeHtml(clip.content)}</div>`;

    item.innerHTML = `
      <div class="icon">${
        clip.format === "image" ? ICON_IMAGE : ICON_TEXT
      }</div>
      ${preview}
      <div class="time-slot">
        <div class="timestamp">${timeAgo(clip.copiedAt)}</div>
        <button class="delete-btn" title="Delete">${ICON_DELETE}</button>
      </div>
      <div class="copied-overlay">Copied!</div>
    `;

    item.addEventListener("click", async (e) => {
      if (e.target.closest(".delete-btn")) return;
      await restoreClip(clip.id);
      item.classList.add("copied");
      setTimeout(() => item.classList.remove("copied"), 1200);
    });

    item.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      discardClip(clip.id);
    });

    container.appendChild(item);
  }
}

function refreshTimestamps() {
  document.querySelectorAll(".item").forEach((item) => {
    const id = item.dataset.id;
    const clip = Buffr.get(id);
    if (!clip) return;
    const ts = item.querySelector(".timestamp");
    if (ts) ts.textContent = timeAgo(clip.copiedAt);
  });
}

function generateClipId() {
  return `clip_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
