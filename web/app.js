"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const stage = $("#stage");
const screenEl = $("#screen");
const imageMode = new URLSearchParams(location.search).get("mode") === "images";
const libraryApi = imageMode ? "/api/images" : "/api";
const mediaName = imageMode ? "图片" : "视频";
const feedTitle = mediaName + "流";
const imageCache = new Map();
const imageBatches = new Map();
const imageBatchSize = 20;
const imageGrid = $("#image-grid");
const imagePreview = $("#image-preview");
const previewImage = imagePreview.querySelector("img");
let imagesPerPage = 1;
let imageStart = 0;
let visibleImages = [];
const slideshowButton = $("#slideshow");
const slideInterval = $("#slide-interval");
const folderDialog = $("#folder-dialog");
const settingsDialog = $("#settings-dialog");
const mobileSource = $("#mobile-source");
const sourceDialog = $("#source-dialog");
const seekControl = $("#seek");
const seekRow = seekControl.closest(".seek-row");
const seekMarkers = $("#seek-markers");
const seekPreview = $("#seek-preview");
const timelineToggle = $("#timeline-toggle");
const rates = { base: [0.5, 1, 1.25, 1.5, 2], hold: [1.5, 2, 2.5, 3, 4] };
function readPreference(key) {
  try { return localStorage.getItem("flow." + key); } catch { return null; }
}
const savedShowStats = readPreference("showStats");
const preferences = {
  sidebarCollapsed: readPreference("sidebarCollapsed") === "true",
  base: Number(readPreference("base")) || 1,
  hold: Number(readPreference("hold")) || 2,
  muted: readPreference("muted") === "true",
  joined: readPreference("joined") !== "false",
  showStats: savedShowStats === null ? !window.matchMedia("(max-width: 740px)").matches : savedShowStats === "true",
};
for (const key of ["base", "hold"]) {
  if (!rates[key].includes(preferences[key])) preferences[key] = key === "base" ? 1 : 2;
}
function savePreference(key, value) {
  preferences[key] = value;
  try { localStorage.setItem("flow." + key, String(value)); } catch { /* 可在当前页面继续使用 */ }
}

function readPlayback() {
  try {
    const record = JSON.parse(readPreference("playback"));
    if (Number.isSafeInteger(record?.id) && record.id > 0
        && Number.isFinite(record.time) && record.time >= 0) return record;
  } catch { /* 从默认视频流开始 */ }
  return null;
}

let sources = [];
let ffmpeg = false;
let sourceId = 0;
let active = null;
let feedEntry = null;
let video = null;
let resumeRecord = imageMode ? null : readPlayback();
let pendingSeek = 0;
let streamStart = 0;
let compatiblePlayback = false;
let sourceDuration = 0;
let folderTimeline = null;
let timelineRequest = null;
let timelinePreview = null;
let lastPlaybackSave = 0;
let playbackEvents = null;
let epoch = 0;
let moving = false;
let slideshowPlaying = false;
let slideTimer = 0;
let queue = { next: [], prev: [] };
let gesture = null;
let libraryRequest = 0;
let pollTimer = 0;
let toastTimer = 0;
let loadingTimer = 0;
let tapTimer = 0;
let zoomHudTimer = 0;
let autoMuted = false;
let seekingSlider = false;
let lastTap = { time: 0, x: 0, y: 0, timer: 0 };
const activeTouches = new Map();
let pinchState = null;
let imageZoom = { scale: 1, x: 0, y: 0 };

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#i-" + name);
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}
function iconState(button, name, label) {
  button.querySelector("use").setAttribute("href", "#i-" + name);
  button.setAttribute("aria-label", label);
  button.title = label;
}
async function api(path, body, signal) {
  const response = await fetch(path, body === undefined ? { signal } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败，请重试");
  return result;
}
function toast(message) {
  clearTimeout(toastTimer);
  const node = $("#toast");
  node.textContent = message;
  node.hidden = true;
  void node.offsetWidth;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}
function scanning(source) { return ["queued", "scanning"].includes(source.state); }
function currentSource() { return sources.find((item) => item.id === sourceId); }
function videoCount(source) { return preferences.joined ? source.joined_total ?? source.total : source.total; }
function total() {
  return sources.reduce((sum, item) => sum + videoCount(item), 0);
}
function title() { return currentSource()?.name || feedTitle; }

function playbackPosition() { return pendingSeek || streamStart + video.currentTime; }
function clipLength() {
  return compatiblePlayback && validDuration(sourceDuration) ? sourceDuration : streamStart + video.duration;
}
function savePlayback() {
  if (!active || !video) return;
  const record = { id: active.id, sourcePath: currentSource()?.path || "", time: playbackPosition() };
  lastPlaybackSave = performance.now();
  try { localStorage.setItem("flow.playback", JSON.stringify(record)); } catch { /* 仍可继续播放 */ }
}
window.addEventListener("pagehide", savePlayback);
document.addEventListener("visibilitychange", () => { if (document.hidden) savePlayback(); });

function renderNavigation() {
  mobileSource.hidden = !sources.length;
  mobileSource.classList.toggle("selected", sourceId !== 0);
  $("#view-title").textContent = title();
  const headerMeta = $("#header-meta");
  const activeSource = currentSource();
  const viewTotal = activeSource ? videoCount(activeSource) : total();
  headerMeta.hidden = viewTotal === 0;
  const countUnit = imageMode ? " 张图片" : " 个视频";
  headerMeta.textContent = viewTotal ? viewTotal.toLocaleString() + countUnit : "";
  $("#home-button").hidden = sourceId === 0;
  document.title = title() + " · Flow";
  const tabVideos = $("#mobile-tab-videos");
  const tabImages = $("#mobile-tab-images");
  tabVideos.classList.toggle("active", !imageMode);
  tabVideos.setAttribute("aria-selected", String(!imageMode));
  tabImages.classList.toggle("active", imageMode);
  tabImages.setAttribute("aria-selected", String(imageMode));
  const folderChip = $("#mobile-folder-chip");
  folderChip.hidden = !activeSource;
  if (activeSource) $("#mobile-folder-name").textContent = activeSource.name;
  currentFeed.classList.toggle("selected", !sourceId);
  currentFeed.setAttribute("aria-pressed", String(!sourceId));
  $('[data-count="total"]').textContent = total().toLocaleString();
  const list = $("#source-list");
  list.replaceChildren();
  if (!sources.length) list.append(element("p", "no-folders", "尚未引入文件夹"));
  sources.forEach((source) => {
    const row = element("div", "source-row");
    const open = element("button", "source-open");
    open.classList.toggle("selected", sourceId === source.id);
    const isScanning = scanning(source);
    const isError = source.state === "error";
    open.title = source.path + " · " + videoCount(source) + countUnit + (source.detail ? "\n" + source.detail : "");
    const metaText = isScanning ? "扫描中" : isError ? "失败" : videoCount(source).toLocaleString();
    const metaClass = "source-meta" + (isScanning ? " is-scanning" : isError ? " is-error" : "");
    open.append(icon("folder"), element("span", "source-name", source.name), element("span", metaClass, metaText));
    open.onclick = () => selectSource(source.id);
    const refresh = element("button", "icon-button" + (isScanning ? " is-spinning" : ""));
    refresh.title = "重新扫描 " + source.name;
    refresh.setAttribute("aria-label", refresh.title);
    refresh.disabled = isScanning;
    refresh.append(icon("refresh"));
    refresh.onclick = async () => {
      try {
        await api(libraryApi + "/sources", { path: source.path });
        toast("已开始重新扫描");
        await syncLibrary();
      } catch (error) { toast(error.message); }
    };
    row.append(open, refresh);
    list.append(row);
  });
}

function renderSourceChoices() {
  const list = $("#source-choices");
  list.replaceChildren();
  for (const source of [{ id: 0, name: "全部文件夹" }, ...sources]) {
    const entry = element("button", "folder-entry");
    const selected = sourceId === source.id;
    if (selected) entry.setAttribute("aria-current", "true");
    const count = source.id ? videoCount(source) : total();
    entry.append(
      icon(source.id ? "folder" : "library"),
      element("span", "", source.name),
      element("span", "choice-count", count.toLocaleString()),
    );
    if (selected) {
      const check = icon("check");
      check.classList.add("choice-check");
      entry.append(check);
    }
    entry.onclick = () => {
      sourceDialog.close();
      if (!selected) selectSource(source.id);
    };
    list.append(entry);
  }
}

function emptyState(connectionError = "") {
  if (active) return;
  const selected = currentSource();
  const relevant = selected ? [selected] : sources;
  let heading = "引入你的第一个文件夹";
  let hintText = imageMode ? "支持 JPG、JPEG、PNG、WebP、GIF、AVIF 与 BMP 格式" : "支持 MP4、MKV、MOV、AVI 与 TS 格式";
  let errorMessage = connectionError;
  let action = "选择文件夹";
  let callback = openFolders;
  let isScanningState = false;
  if (connectionError) {
    heading = "暂时无法读取" + mediaName + "库";
    hintText = "";
    action = "重新连接";
    callback = syncLibrary;
  } else if (relevant.some(scanning)) {
    heading = "正在查找" + mediaName;
    hintText = imageMode ? "找到首批图片后即可开始浏览" : "发现首批视频后即可立即播放，无需等待全部扫描完成";
    action = "";
    isScanningState = true;
  } else if (relevant.length) {
    heading = "还没有找到" + mediaName;
    if (!imageMode) hintText = "请确认文件夹中包含 MP4、MKV、MOV、AVI 或 TS 视频文件";
    errorMessage = relevant.find((s) => s.detail)?.detail || "";
    action = "选择文件夹";
  }
  $("#empty-view").classList.toggle("is-scanning", isScanningState);
  $("#empty-title").textContent = heading;
  const hint = $("#empty-hint");
  hint.textContent = hintText;
  hint.hidden = !hintText;
  const error = $("#empty-error");
  error.textContent = errorMessage;
  error.hidden = !errorMessage;
  const button = $("#empty-action");
  button.hidden = !action;
  button.querySelector("span").textContent = action;
  button.onclick = callback;
}

function updateSources(nextSources) {
  const previousImageCount = imageMode ? imageCount() : 0;
  const paths = new Map(nextSources.map((source) => [source.id, source.path]));
  const removed = new Set(sources.filter((source) => paths.get(source.id) !== source.path).map((source) => source.id));
  const foldersChanged = removed.size > 0 || sources.length !== nextSources.length;
  sources = nextSources;
  if (removed.size) {
    epoch++;
    moving = false;
    queue = { next: [], prev: [] };
    if (removed.has(sourceId)) sourceId = 0;
    if (removed.has(active?.source_id)) clearVideo();
  }
  if (imageMode && (foldersChanged || previousImageCount !== imageCount())) {
    imageBatches.clear();
    if (moving || (active && (removed.size || imageCount() < previousImageCount || visibleImages.length < imagesPerPage))) {
      epoch++;
      moving = false;
      move("current");
    }
  }
  renderNavigation();
  emptyState();
  if (foldersChanged && sourceDialog.open) renderSourceChoices();
  if (foldersChanged && folderDialog.open && folderPage && $("#folder-path").value === folderPage.path) {
    browse(folderPage.path);
  }
}

async function syncLibrary() {
  const request = ++libraryRequest;
  clearTimeout(pollTimer);
  try {
    const status = await api(libraryApi + (preferences.joined && !imageMode ? "/status?joined=1" : "/status"));
    if (request !== libraryRequest) return;
    ffmpeg = status.ffmpeg;
    if (resumeRecord) {
      const source = status.sources.find((item) => item.path === resumeRecord.sourcePath);
      if (resumeRecord.sourcePath && !source) resumeRecord = null;
      sourceId = source?.id || 0;
    }
    updateSources(status.sources);
    const count = currentSource()?.total ?? total();
    if (!active && !moving && count > 0) await move("next");
  } catch (error) {
    if (request === libraryRequest) emptyState(error.message);
  } finally {
    if (request === libraryRequest) {
      pollTimer = setTimeout(syncLibrary, sources.some(scanning) ? 1200 : 15000);
    }
  }
}

function showLoading() {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    if (video && !video.paused && video.readyState < 3) $("#video-loading").hidden = false;
  }, 180);
}
function hideLoading() {
  clearTimeout(loadingTimer);
  $("#video-loading").hidden = true;
}
function flashTapFeedback(iconName) {
  const feedback = $("#tap-feedback");
  clearTimeout(tapTimer);
  feedback.querySelector("use").setAttribute("href", "#i-" + iconName);
  feedback.hidden = false;
  feedback.classList.remove("animate");
  void feedback.offsetWidth;
  feedback.classList.add("animate");
  tapTimer = setTimeout(() => {
    feedback.hidden = true;
    feedback.classList.remove("animate");
  }, 480);
}
function renderVideoMeta() {
  const nameNode = $("#video-name");
  const badgesNode = $("#video-meta-badges");
  badgesNode.replaceChildren();
  if (!active) {
    nameNode.textContent = "";
    nameNode.removeAttribute("title");
    return;
  }
  const cleanName = active.name.replace(/\.[^.]+$/, "") || active.name;
  nameNode.textContent = cleanName;
  nameNode.title = active.name;
  if (active.format) badgesNode.append(element("span", "video-badge format", active.format));
  if (compatiblePlayback) badgesNode.append(element("span", "video-badge accent",
    compatiblePlayback === "audio" ? "音频转码" : "转码播放"));
  if (active.folder) {
    const folderLabel = active.folder.replace(/[\\/]\.$/, "");
    badgesNode.append(element("span", "video-badge folder", folderLabel));
  }
}

function setCleanMode(enabled) {
  stage.classList.toggle("clean-mode", enabled);
  $("#clean-exit").hidden = !enabled;
}
function showZoomHud(scale) {
  const hud = $("#zoom-hud");
  clearTimeout(zoomHudTimer);
  const pct = Math.round(scale * 100);
  hud.textContent = scale > 1.02 ? pct + "% · 双击还原" : "100%";
  hud.hidden = false;
  zoomHudTimer = setTimeout(() => { hud.hidden = true; }, 1100);
}
function activeSingleImage() {
  if (!imageMode || imagesPerPage !== 1) return null;
  return imageGrid.querySelector(".image-cell img");
}
function clampImagePan(scale, x, y) {
  const maxX = Math.max(0, (stage.clientWidth * (scale - 1)) / 2);
  const maxY = Math.max(0, (stage.clientHeight * (scale - 1)) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y)),
  };
}
function applyImageZoom(animate = false) {
  const img = activeSingleImage();
  if (!img) return;
  const clamped = clampImagePan(imageZoom.scale, imageZoom.x, imageZoom.y);
  imageZoom.x = clamped.x;
  imageZoom.y = clamped.y;
  img.classList.toggle("is-zoom-anim", animate);
  img.style.transform = imageZoom.scale <= 1.001
    ? ""
    : "translate(" + imageZoom.x.toFixed(1) + "px, " + imageZoom.y.toFixed(1) + "px) scale(" + imageZoom.scale.toFixed(3) + ")";
}
function resetImageZoom(animate = false) {
  imageZoom = { scale: 1, x: 0, y: 0 };
  applyImageZoom(animate);
}

function clearVideo() {
  finishHold();
  hideLoading();
  setCleanMode(false);
  resetImageZoom();
  autoMuted = false;
  $("#unmute-banner").hidden = true;
  if (imageMode) {
    if (slideshowPlaying) setSlideshowPlaying(false);
    if (imagePreview.open) imagePreview.close();
    visibleImages = [];
    imageStart = 0;
    imageGrid.replaceChildren();
    imageBatches.clear();
    trimImageCache([]);
  }
  clearFolderTimeline();
  playbackEvents?.abort();
  playbackEvents = null;
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    video.classList.remove("is-revealing");
  }
  active = null;
  feedEntry = null;
  video = null;
  renderVideoMeta();
  $("#joined-badge").hidden = true;
  $("#zoom-setting").hidden = true;
  stage.classList.add("empty");
  $("#empty-view").hidden = false;
  $("#video-ui").hidden = true;
}
function selectSource(id = 0, record = null) {
  resumeRecord = record;
  epoch++;
  moving = false;
  sourceId = id;
  queue = { next: [], prev: [] };
  clearVideo();
  renderNavigation();
  emptyState();
  move("next");
}
function groupFeed() { return !imageMode && preferences.joined; }
function page(direction, anchor, { group = 0, clip = 0, signal, offset = 0 } = {}) {
  const params = new URLSearchParams({
    dir: direction, anchor: String(anchor), source: String(sourceId),
  });
  if (offset) params.set("offset", String(offset));
  if (group) {
    params.set("group", String(group));
    if (signal) params.set("duration", "1");
  } else if (groupFeed()) {
    params.set("joined", "1");
    if (clip) params.set("clip", String(clip));
  }
  return api((imageMode ? "/api/images?" : "/api/videos?") + params, undefined, signal);
}
function orderGroupClips(clips) {
  const numbered = clips.map((item) => ({ item, number: /^(\d+)\.[^.]+$/.exec(item.name)?.[1] }));
  if (numbered.some(({ number }) => number === undefined)) return clips;
  const byNumber = new Intl.Collator(undefined, { numeric: true });
  numbered.sort((left, right) => byNumber.compare(left.number, right.number));
  return numbered.map(({ item }) => item);
}
async function move(direction, fromSlideshow = false) {
  if (moving) return;
  moving = true;
  if (slideshowPlaying) clearTimeout(slideTimer);
  const version = epoch;
  const record = resumeRecord;
  const entry = feedEntry || active;
  try {
    if (imageMode) {
      const start = imagePageStart(direction);
      if (fromSlideshow && start === imageStart) {
        setSlideshowPlaying(false);
        return;
      }
      const items = await imagePageAt(start);
      if (version !== epoch || (fromSlideshow && !slideshowPlaying)) return;
      if (!items.length) {
        clearVideo();
        emptyState();
        return;
      }
      imageStart = start;
      showImages(items, direction === "current" ? active?.id : null, direction);
      return;
    }
    if (!queue[direction].length) {
      // 分页锚点不包含自身，从上一编号查询即可取回记录及其后续视频。
      let items = record && groupFeed()
        ? await page(direction, 0, { clip: record.id })
        : await page(direction, record ? record.id - 1 : entry?.id || 0);
      if (version !== epoch) return;
      if (!items.length && (active || record)) {
        items = await page(direction, 0);
        if (version !== epoch) return;
      }
      queue[direction] = items;
    }
    const item = queue[direction].shift();
    if (!item) {
      resumeRecord = null;
      clearVideo();
      emptyState();
      return;
    }
    if (entry?.id === item.id) {
      if (slideshowPlaying) setSlideshowPlaying(false);
      return;
    }
    let clip = item;
    let clips = null;
    if (item.group_size > 1) {
      const members = await page("next", 0, { group: item.id });
      if (version !== epoch) return;
      if (!members.length) throw new Error("此拼接视频已不存在");
      clips = orderGroupClips(members);
      clip = clips.find((member) => member.id === record?.id) ?? clips[0];
    }
    resumeRecord = null;
    const opposite = queue[direction === "next" ? "prev" : "next"];
    if (entry) {
      opposite.unshift(entry);
      if (opposite.length > 20) opposite.pop();
    }
    clearFolderTimeline();
    feedEntry = item;
    if (clips?.length > 1) {
      const segments = clips.map((member, index) => ({ item: member, index, start: index }));
      const byId = new Map(segments.map((segment) => [segment.item.id, segment]));
      folderTimeline = { segments, byId, duration: null };
    }
    showVideo(clip, clip.id === record?.id ? record.time : 0, record?.paused !== true);
    if (folderTimeline) loadGroupTimeline(item);
  } catch (error) {
    if (version === epoch) {
      if (slideshowPlaying) setSlideshowPlaying(false);
      if (active) toast(error.message);
      else emptyState(error.message);
    }
  } finally {
    if (version === epoch) {
      moving = false;
      if (slideshowPlaying) scheduleNextSlide();
    }
  }
}

function scheduleNextSlide() {
  clearTimeout(slideTimer);
  if (slideshowPlaying && active && !moving && !imagePreview.open && !stage.classList.contains("image-pending")) {
    slideTimer = setTimeout(() => move("next", true), Number(slideInterval.value) * 1000);
  }
}
function setSlideshowPlaying(playing) {
  slideshowPlaying = playing;
  const label = playing ? "暂停幻灯片" : "幻灯片播放";
  iconState(slideshowButton, playing ? "pause" : "play", label);
  slideshowButton.querySelector("span").textContent = label;
  scheduleNextSlide();
}

function cachedImage(item) {
  let entry = imageCache.get(item.id);
  if (!entry) {
    const node = new Image();
    node.decoding = "async";
    node.alt = item.name;
    node.src = "/image/" + item.id;
    entry = { node, ready: node.decode().then(() => true, () => false) };
    imageCache.set(item.id, entry);
  }
  return entry;
}
function trimImageCache(keep) {
  for (const [id, { node }] of imageCache) {
    if (keep.includes(id)) continue;
    if (!node.isConnected) node.removeAttribute("src");
    imageCache.delete(id);
  }
}
function imageCount() {
  return currentSource()?.total ?? total();
}
function imagePageStart(direction) {
  const last = Math.floor(Math.max(0, imageCount() - 1) / imagesPerPage) * imagesPerPage;
  if (!visibleImages.length) return 0;
  if (direction === "current") {
    const selected = imageStart + Math.max(0, visibleImages.indexOf(active));
    return Math.min(last, selected - selected % imagesPerPage);
  }
  if (direction === "prev") return imageStart > 0 ? imageStart - imagesPerPage : last;
  return imageStart < last ? imageStart + imagesPerPage : 0;
}
function imagePageBlocks(start) {
  const block = start - start % imageBatchSize;
  const next = block + imageBatchSize;
  return next < start + imagesPerPage && next < imageCount() ? [block, next] : [block];
}
function imageBatchAt(block) {
  let request = imageBatches.get(block);
  if (!request) {
    request = page("next", 0, { offset: block });
    imageBatches.set(block, request);
    request.catch(() => { if (imageBatches.get(block) === request) imageBatches.delete(block); });
  }
  return request;
}
async function imagePageAt(start) {
  const offset = start % imageBatchSize;
  const end = offset + imagesPerPage;
  const batches = await Promise.all(imagePageBlocks(start).map(imageBatchAt));
  return batches.flat().slice(offset, end);
}
async function preloadImagePages(items, direction) {
  const next = imagePageStart(direction === "prev" ? "prev" : "next");
  const back = imagePageStart(direction === "prev" ? "next" : "prev");
  const blocks = [imageStart, next, back].flatMap(imagePageBlocks);
  for (const block of imageBatches.keys()) {
    if (!blocks.includes(block)) imageBatches.delete(block);
  }
  const version = epoch;
  try {
    const [ahead, behind] = await Promise.all([imagePageAt(next), imagePageAt(back)]);
    if (version !== epoch || visibleImages !== items) return;
    const currentIds = new Set(items.map((item) => item.id));
    const nearby = [...ahead.slice(0, 8), ...behind.slice(0, 1)].filter((item) => !currentIds.has(item.id));
    trimImageCache([...items, ...nearby].map((item) => item.id));
    nearby.forEach(cachedImage);
  } catch { /* 翻页时重新读取 */ }
}
function selectImage(item) {
  active = item;
  for (const button of imageGrid.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.id === String(item.id)));
  }
  renderVideoMeta();
}
async function showImages(items, selectedId, direction = "next") {
  finishHold();
  resetImageZoom();
  clearTimeout(slideTimer);
  trimImageCache([...visibleImages, ...items].map((item) => item.id));
  visibleImages = items;
  active = items.find((item) => item.id === selectedId) || items[0];
  const size = imagesPerPage;
  const cells = items.map((item) => {
    const cell = element("button", "image-cell");
    cell.dataset.id = String(item.id);
    cell.title = item.name;
    cell.setAttribute("aria-label", "放大查看 " + item.name);
    cell.setAttribute("aria-haspopup", "dialog");
    cell.onclick = () => {
      if (visibleImages !== items || imagePreview.open) return;
      selectImage(item);
      const img = cell.querySelector("img");
      if (!img) return;
      if (moving) {
        epoch++;
        moving = false;
      }
      clearTimeout(slideTimer);
      previewImage.alt = item.name;
      previewImage.src = img.currentSrc || img.src;
      imagePreview.showModal();
    };
    return cell;
  });
  stage.classList.remove("empty");
  stage.classList.add("image-pending");
  $("#empty-view").hidden = true;
  $("#video-ui").hidden = false;
  playbackMessage("");
  hideLoading();
  loadingTimer = setTimeout(() => { $("#video-loading").hidden = false; }, 180);
  await Promise.all(items.map(async (item, index) => {
    const entry = cachedImage(item);
    const ready = await entry.ready;
    if (visibleImages !== items) return;
    if (cells[0].parentNode !== imageGrid) {
      hideLoading();
      imageGrid.dataset.size = String(size);
      imageGrid.replaceChildren(...cells);
      selectImage(active);
    }
    if (ready) cells[index].append(entry.node);
    else {
      imageCache.delete(item.id);
      if (size === 1) playbackMessage("图片无法显示，可以重新加载或继续滑动。");
      else cells[index].textContent = "图片无法显示";
    }
  }));
  if (visibleImages !== items) return;
  hideLoading();
  stage.classList.remove("image-pending");
  if (slideshowPlaying) scheduleNextSlide();
  preloadImagePages(items, direction);
}

function playbackMessage(message) {
  $("#play-message p").textContent = message;
  $("#play-message").hidden = !message;
}
async function play(node, allowMute = true) {
  if (!node || node !== video) return;
  const session = playbackEvents;
  try {
    await node.play();
  } catch (error) {
    if (session.signal.aborted || error.name !== "NotAllowedError") return;
    if (allowMute && !node.muted) {
      node.muted = true;
      autoMuted = true;
      $("#unmute-banner").hidden = false;
      return play(node, false);
    }
    playbackMessage("播放已暂停");
  }
}
function startCompatible(position, autoplay = true, mode = compatiblePlayback || "1") {
  compatiblePlayback = mode;
  streamStart = position;
  pendingSeek = 0;
  renderVideoMeta();
  showLoading();
  video.src = "/media/" + active.id + "?compatible=" + mode + (position ? "&start=" + position.toFixed(3) : "");
  if (autoplay) play(video);
}
function missingAudio(node, codec) {
  if (node.webkitAudioDecodedByteCount > 0) return false;
  if (node.audioTracks?.length === 0) return true;
  const mp4Codec = { ac3: "ac-3", eac3: "ec-3", dts: "dtsc", truehd: "mlpa" }[codec];
  return mp4Codec && (node.webkitAudioDecodedByteCount === 0 || !node.canPlayType('audio/mp4; codecs="' + mp4Codec + '"'));
}
function watchPlaybackStats(node, signal) {
  const stats = $("#playback-stats");
  let previous = null;
  const reset = () => {
    previous = null;
    stats.textContent = "— Mbps";
  };
  reset();
  node.addEventListener("loadstart", reset, { signal });
  for (const event of ["pause", "seeking", "waiting"]) {
    node.addEventListener(event, () => { previous = null; }, { signal });
  }
  document.addEventListener("visibilitychange", () => { previous = null; }, { signal });
  node.addEventListener("timeupdate", () => {
    if (document.hidden || node.paused || node.seeking || node.readyState < 2) return;
    const time = performance.now();
    if (previous && time - previous.time < 1000) return;
    const bytes = node.webkitVideoDecodedByteCount + (node.webkitAudioDecodedByteCount ?? 0);
    if (previous) {
      const seconds = (time - previous.time) / 1000;
      const mbps = bytes > 0 && bytes >= previous.bytes
        ? ((bytes - previous.bytes) * 8 / seconds / 1e6).toFixed(2) : "—";
      stats.textContent = mbps + " Mbps";
    }
    previous = { time, bytes };
  }, { signal });
}
function watchSubtitles(node, id, signal) {
  const caption = $("#subtitles");
  let pages = [];
  let loading = false;
  let retryAfter = 0;
  const covers = (page, time) => page.start <= time && (page.end === null || time < page.end);
  function update() {
    if (signal.aborted) return;
    const time = playbackPosition();
    const page = pages.find((part) => covers(part, time));
    const text = page?.cues.filter(([start, end]) => start <= time && time < end)
      .map((cue) => cue[2]).join("\n") || "";
    if (caption.textContent !== text) caption.textContent = text;
    const target = page ? page.end : Math.floor(time);
    if (loading || target === null || target - time > 5 || pages.some((part) => covers(part, target))
        || performance.now() < retryAfter) return;
    loading = true;
    api("/media/" + id + "/subtitles?at=" + target, undefined, signal).then((result) => {
      if (signal.aborted) return;
      pages = [result, ...pages].slice(0, 2);
      loading = false;
      update();
    }).catch(() => { loading = false; retryAfter = performance.now() + 15000; });
  }
  signal.addEventListener("abort", () => { caption.textContent = ""; }, { once: true });
  for (const name of ["loadedmetadata", "timeupdate", "seeking", "seeked"]) {
    node.addEventListener(name, update, { signal });
  }
  update();
}
function showVideo(item, position = 0, autoplay = true) {
  finishHold();
  playbackEvents?.abort();
  const node = $("#player");
  node.pause();
  playbackEvents = new AbortController();
  const { signal } = playbackEvents;
  video = node;
  if (active?.id !== item.id) setVideoZoom(100);
  $("#zoom-setting").hidden = false;
  active = item;
  pendingSeek = position;
  streamStart = 0;
  compatiblePlayback = false;
  sourceDuration = 0;
  autoMuted = false;
  $("#unmute-banner").hidden = true;
  node.hidden = false;
  node.classList.remove("is-revealing");
  void node.offsetWidth;
  node.classList.add("is-revealing");
  node.src = "/media/" + item.id;
  node.load();
  node.muted = preferences.muted;
  node.defaultPlaybackRate = preferences.base;
  node.playbackRate = preferences.base;
  watchPlaybackStats(node, signal);
  watchSubtitles(node, item.id, signal);
  savePlayback();
  stage.classList.remove("empty");
  $("#empty-view").hidden = true;
  $("#video-ui").hidden = false;
  const segment = currentSegment();
  const joinedBadge = $("#joined-badge");
  joinedBadge.hidden = !segment;
  joinedBadge.textContent = segment ? "拼接 " + (segment.index + 1) + "/" + folderTimeline.segments.length : "";
  renderVideoMeta();
  playbackMessage("");
  showLoading();
  let audioCodec = null;
  let audioCheckFrom = null;
  if (ffmpeg) {
    api("/media/" + item.id + "/info", undefined, signal).then((info) => {
      if (signal.aborted) return;
      audioCodec = info.audio;
      sourceDuration = Number(info.duration);
      updateTransport();
    }).catch(() => { /* 无法读取音轨信息时继续原文件播放 */ });
  }
  node.addEventListener("waiting", showLoading, { signal });
  ["canplay", "playing", "pause", "error"].forEach((name) => {
    node.addEventListener(name, hideLoading, { signal });
  });
  function onError() {
    if (node !== video || !node.error) return;
    if (compatiblePlayback !== "1" && ffmpeg && [3, 4].includes(node.error.code)) {
      startCompatible(playbackPosition(), autoplay || !node.paused, "1");
      return;
    }
    playbackMessage(!ffmpeg && [3, 4].includes(node.error.code)
      ? "浏览器无法解码此视频，服务端的 FFmpeg 不可用。"
      : "视频无法播放。");
  }
  node.addEventListener("error", onError, { signal });
  function restoreTime() {
    if (node !== video || !pendingSeek || node.readyState < 1) return;
    node.currentTime = Number.isFinite(node.duration) ? Math.min(pendingSeek, node.duration) : pendingSeek;
  }
  node.addEventListener("loadedmetadata", restoreTime, { signal });
  node.addEventListener("durationchange", () => {
    const part = currentSegment();
    if (part && !compatiblePlayback && !validDuration(part.item.duration) && validDuration(node.duration)) {
      part.item.duration = node.duration;
      refreshGroupSeek();
    }
  }, { signal });
  let checkFrom = null;
  node.addEventListener("seeked", () => {
    if (node !== video) return;
    pendingSeek = 0;
    checkFrom = null;
    audioCheckFrom = null;
    savePlayback();
  }, { signal });
  node.addEventListener("pause", savePlayback, { signal });
  let firstFrameShown = false;
  if (node.requestVideoFrameCallback) {
    let frame = null;
    const cancelFrame = () => { if (frame !== null) node.cancelVideoFrameCallback(frame); };
    node.addEventListener("loadedmetadata", () => {
      cancelFrame();
      firstFrameShown = false;
      frame = node.requestVideoFrameCallback(() => { firstFrameShown = true; });
    }, { signal });
    signal.addEventListener("abort", cancelFrame, { once: true });
  }
  document.addEventListener("visibilitychange", () => { checkFrom = null; }, { signal });
  node.addEventListener("timeupdate", () => {
    if (performance.now() - lastPlaybackSave >= 3000) savePlayback();
    if (!compatiblePlayback && audioCodec && !node.paused && !node.muted && !node.seeking && node.readyState >= 2) {
      if (audioCheckFrom === null || node.currentTime < audioCheckFrom) audioCheckFrom = node.currentTime;
      if (node.currentTime - audioCheckFrom >= 2 && missingAudio(node, audioCodec)) {
        startCompatible(playbackPosition(), true, "audio");
        return;
      }
    }
    if (firstFrameShown || (!node.requestVideoFrameCallback && node.videoWidth > 0)) return;
    if (document.hidden || node.paused || node.seeking || node.readyState < 2) {
      checkFrom = null;
      return;
    }
    if (checkFrom === null || node.currentTime < checkFrom) checkFrom = node.currentTime;
    if (node.currentTime - checkFrom < 2) return;
    checkFrom = null;
    if (ffmpeg && compatiblePlayback !== "1") {
      startCompatible(playbackPosition(), true, "1");
    } else {
      node.pause();
      playbackMessage("暂时无法显示视频画面。");
    }
  }, { signal });
  node.addEventListener("playing", () => {
    checkFrom = node.currentTime;
    playbackMessage("");
  }, { signal });
  ["play", "pause", "volumechange", "loadedmetadata", "durationchange", "timeupdate"].forEach((name) => {
    node.addEventListener(name, updateTransport, { signal });
  });
  node.addEventListener("ended", () => {
    if (node !== video) return;
    const segment = currentSegment();
    if (segment && folderTimeline.segments.length > 1) {
      const next = folderTimeline.segments[(segment.index + 1) % folderTimeline.segments.length];
      showVideo(next.item);
      return;
    }
    if (compatiblePlayback) return startCompatible(0);
    node.currentTime = 0;
    play(node);
  }, { signal });
  updateTransport();
  if (node.error) onError();
  else {
    restoreTime();
    if (autoplay) play(node);
  }
}
function clockTime(seconds) {
  const value = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
}
function currentSegment() {
  return folderTimeline?.byId.get(active?.id);
}
function validDuration(duration) {
  return Number.isFinite(duration) && duration > 0;
}
function segmentAt(position) {
  const { segments, duration } = folderTimeline;
  if (duration === null) return segments[Math.min(Math.floor(position), segments.length - 1)];
  return segments.find(({ start, item }) => position < start + item.duration) ?? segments[segments.length - 1];
}
function timelineStatus(message = "", failed = false) {
  const status = $("#timeline-status");
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle("error-text", failed);
  const badge = $("#timeline-progress");
  badge.textContent = message;
  badge.hidden = !message;
}
function clearFolderTimeline() {
  timelineRequest?.abort();
  timelineRequest = null;
  folderTimeline = null;
  timelinePreview = null;
  seekControl.max = "1000";
  seekControl.step = "1";
  seekControl.style.setProperty("--progress", "0%");
  seekRow?.style.setProperty("--progress", "0%");
  seekControl.removeAttribute("aria-valuetext");
  seekMarkers.hidden = true;
  seekMarkers.replaceChildren();
  seekPreview.hidden = true;
  timelineStatus();
}
function refreshGroupSeek() {
  const timeline = folderTimeline;
  if (!timeline || timeline.duration !== null || timelinePreview !== null) return;
  const complete = timeline.segments.every(({ item }) => validDuration(item.duration));
  if (!complete && !seekMarkers.hidden) return;

  let extent = timeline.segments.length;
  if (complete) {
    extent = 0;
    for (const segment of timeline.segments) {
      segment.start = extent;
      extent += segment.item.duration;
    }
    timeline.duration = extent;
    timelineStatus();
  }
  seekControl.max = String(extent);
  seekControl.step = "any";
  const markers = document.createDocumentFragment();
  for (const segment of timeline.segments.slice(1)) {
    const marker = element("span", "seek-marker");
    marker.style.left = (segment.start / extent * 100) + "%";
    markers.append(marker);
  }
  seekMarkers.replaceChildren(markers);
  seekMarkers.hidden = false;
}
async function loadGroupTimeline(entry) {
  const timeline = folderTimeline;
  refreshGroupSeek();
  updateTransport();
  if (timeline.duration !== null) return;
  const request = new AbortController();
  timelineRequest = request;
  const count = timeline.segments.length;
  let checked = 0;
  let anchor = 0;
  timelineStatus("读取时长 0/" + count);
  try {
    while (!request.signal.aborted && timeline.duration === null && checked < count) {
      const items = await page("next", anchor, { group: entry.id, signal: request.signal });
      if (request.signal.aborted) return;
      if (!items.length) break;
      for (const item of items) {
        const segment = timeline.byId.get(item.id);
        if (!segment) continue;
        checked++;
        if (validDuration(item.duration)) segment.item.duration = item.duration;
      }
      anchor = items[items.length - 1].id;
      if (timeline.duration === null) timelineStatus("读取时长 " + checked + "/" + count);
    }
    refreshGroupSeek();
    if (timeline.duration === null) timelineStatus("按片段定位");
    updateTransport();
  } catch (error) {
    if (request.signal.aborted) return;
    if (timeline.duration !== null) return;
    timelineStatus("按片段定位", true);
    if (!settingsDialog.open) toast(error.message);
  } finally {
    if (timelineRequest === request) timelineRequest = null;
  }
}
function updateTransport() {
  if (!video) return;
  const segment = currentSegment();
  const groupDuration = segment ? folderTimeline.duration : null;
  const clipDuration = clipLength();
  const clipPosition = !segment && timelinePreview !== null ? timelinePreview : playbackPosition();
  const duration = groupDuration ?? clipDuration;
  const position = groupDuration === null ? clipPosition
    : timelinePreview ?? segment.start + Math.min(clipPosition, segment.item.duration);
  const seekable = validDuration(duration);
  let sliderValue = seekable ? Math.round(position / duration * 1000) : 0;
  if (segment) {
    sliderValue = groupDuration !== null ? position
      : timelinePreview ?? segment.index + (seekable ? Math.min(clipPosition / clipDuration, 1) : 0);
  }
  seekControl.disabled = !segment && !seekable;
  seekControl.value = String(sliderValue);
  const maxVal = Number(seekControl.max) || 1;
  const pct = Math.max(0, Math.min(seekControl.valueAsNumber / maxVal * 100, 100));
  const progress = pct + "%";
  seekControl.style.setProperty("--progress", progress);
  seekRow?.style.setProperty("--progress", progress);
  const showPreview = (seekingSlider && (seekable || segment)) || (segment && timelinePreview !== null);
  seekPreview.hidden = !showPreview;
  if (segment) {
    const target = timelinePreview === null ? segment : segmentAt(timelinePreview);
    const label = "第 " + (target.index + 1) + " / " + folderTimeline.segments.length + " 段";
    if (showPreview) {
      seekPreview.textContent = groupDuration === null ? label : clockTime(position) + " · " + label;
    }
    seekControl.setAttribute("aria-valuetext", groupDuration === null ? label : clockTime(position) + "，" + label);
  } else if (showPreview && seekable) {
    seekPreview.textContent = clockTime(position) + " / " + clockTime(duration);
  }
  $("#time").textContent = clockTime(position) + (seekable ? " / " + clockTime(duration) : "");
  iconState($("#play"), video.paused ? "play" : "pause", video.paused ? "播放" : "暂停");
  const volumeButton = $("#volume");
  volumeButton.classList.toggle("muted", video.muted);
  iconState(volumeButton, video.muted ? "mute" : "volume", video.muted ? "开启声音" : "静音");
  const mobileMute = $("#mobile-mute");
  if (mobileMute) {
    mobileMute.classList.toggle("muted", video.muted);
    iconState(mobileMute, video.muted ? "mute" : "volume", video.muted ? "开启声音" : "静音");
    $("#mobile-mute-label").textContent = video.muted ? "静音" : "声音";
  }
  if (!video.muted && autoMuted) {
    autoMuted = false;
    $("#unmute-banner").hidden = true;
  }
}
function togglePlay() {
  if (!video) return;
  if (video.paused) {
    flashTapFeedback("play");
    play(video);
  } else {
    flashTapFeedback("pause");
    video.pause();
  }
}
function setVideoZoom(percent) {
  const slider = $("#video-zoom");
  slider.value = String(percent);
  slider.style.setProperty("--progress", Math.max(0, Math.min((percent - 100) / 200 * 100, 100)) + "%");
  $("#zoom-value").value = percent + "%";
  $("#player").style.setProperty("--video-size", percent + "%");
}
$("#video-zoom").oninput = (event) => setVideoZoom(event.target.valueAsNumber);

function renderSettings() {
  timelineToggle.setAttribute("aria-pressed", String(preferences.joined));
  const statsToggle = $("#stats-toggle");
  if (statsToggle) statsToggle.setAttribute("aria-pressed", String(preferences.showStats));
  document.body.classList.toggle("hide-stats", !preferences.showStats);
  for (const key of ["base", "hold"]) {
    const group = $("#" + key + "-options");
    group.replaceChildren();
    rates[key].forEach((rate) => {
      const button = element("button", "", rate + "×");
      button.setAttribute("aria-pressed", String(preferences[key] === rate));
      button.onclick = () => {
        savePreference(key, rate);
        if (video) {
          video.defaultPlaybackRate = preferences.base;
          video.playbackRate = preferences.base;
        }
        renderSettings();
        group.querySelector('[aria-pressed="true"]').focus();
      };
      group.append(button);
    });
  }
  const speedText = preferences.base + "×";
  const modified = preferences.base !== 1;
  const speedButton = $("#speed");
  speedButton.textContent = speedText;
  speedButton.classList.toggle("modified", modified);
  const mobileSpeed = $("#mobile-speed");
  if (mobileSpeed) {
    mobileSpeed.classList.toggle("modified", modified);
    $("#mobile-speed-val").textContent = speedText;
  }
  const sideSpeed = $("#side-speed");
  if (sideSpeed) {
    sideSpeed.textContent = speedText;
    sideSpeed.classList.toggle("modified", modified);
  }
}
function resetScreenDrag(animate = true) {
  screenEl.classList.toggle("is-spring", animate);
  screenEl.style.transform = "";
  screenEl.style.opacity = "";
  $("#swipe-hint").hidden = true;
}
function seekToGlobalPosition(target) {
  if (!video) return;
  const segment = currentSegment();
  if (segment && folderTimeline?.duration !== null) {
    const dest = segmentAt(target);
    const pos = Math.max(0, Math.min(target - dest.start, dest.item.duration - 0.01));
    if (dest.item.id !== active.id) showVideo(dest.item, pos, !video.paused);
    else if (compatiblePlayback) startCompatible(pos, !video.paused);
    else if (video.readyState < 1) pendingSeek = pos;
    else {
      pendingSeek = 0;
      video.currentTime = pos;
    }
    updateTransport();
    return;
  }
  const duration = clipLength();
  if (!validDuration(duration)) return;
  const clamped = Math.max(0, Math.min(target, duration - 0.05));
  if (compatiblePlayback) startCompatible(clamped, !video.paused);
  else video.currentTime = clamped - streamStart;
  updateTransport();
}
function finishHold() {
  if (gesture) {
    clearTimeout(gesture.timer);
    if (gesture.held && video) {
      video.playbackRate = preferences.base;
      if (gesture.wasPaused) video.pause();
    }
    if (gesture.axis === "y") resetScreenDrag(true);
    if (gesture.axis === "x") $("#scrub-hud").hidden = true;
  }
  gesture = null;
  $("#hold-badge").hidden = true;
  $("#swipe-hint").hidden = true;
  $("#scrub-hud").hidden = true;
}
function startPinch() {
  const pts = Array.from(activeTouches.values());
  if (pts.length < 2) return;
  finishHold();
  clearTimeout(lastTap.timer);
  const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
  pinchState = {
    startDist: dist,
    startScale: imageZoom.scale,
    startX: imageZoom.x,
    startY: imageZoom.y,
    midX: (pts[0].x + pts[1].x) / 2,
    midY: (pts[0].y + pts[1].y) / 2,
  };
}
stage.addEventListener("pointerdown", (event) => {
  if (!active || event.button !== 0 || event.target.closest("button:not(.image-cell), input, select, .play-message")) return;
  if (event.pointerType === "touch") {
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (imageMode && imagesPerPage === 1 && activeTouches.size === 2) {
      stage.setPointerCapture(event.pointerId);
      startPinch();
      return;
    }
  }
  if (!event.isPrimary || pinchState) return;
  finishHold();
  stage.setPointerCapture(event.pointerId);
  const segment = currentSegment();
  const groupDuration = segment ? folderTimeline.duration : null;
  const clipDuration = video ? clipLength() : 0;
  const scrubDuration = !imageMode && video ? (groupDuration ?? (validDuration(clipDuration) ? clipDuration : 0)) : 0;
  const scrubStartPos = !imageMode && video
    ? (groupDuration !== null ? segment.start + Math.min(playbackPosition(), segment.item.duration) : playbackPosition())
    : 0;
  const pointer = {
    id: event.pointerId, x: event.clientX, y: event.clientY,
    held: false, moved: false, axis: "",
    wasPaused: video?.paused,
    cell: event.target.closest("button.image-cell"),
    panStartX: imageZoom.x, panStartY: imageZoom.y,
    scrubDuration, scrubStartPos, scrubTarget: scrubStartPos,
  };
  gesture = pointer;
  if (imageMode) return;
  pointer.timer = setTimeout(() => {
    if (gesture !== pointer || !video || pointer.moved) return;
    pointer.held = true;
    video.playbackRate = preferences.hold;
    if (video.paused) play(video);
    $("#hold-badge-text").textContent = preferences.hold + "× 倍速播放";
    $("#hold-badge").hidden = false;
  }, 380);
});
stage.addEventListener("pointermove", (event) => {
  if (activeTouches.has(event.pointerId)) {
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  if (pinchState && activeTouches.size >= 2) {
    const pts = Array.from(activeTouches.values());
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    imageZoom.scale = Math.max(1, Math.min(4, pinchState.startScale * (dist / pinchState.startDist)));
    imageZoom.x = pinchState.startX + (midX - pinchState.midX);
    imageZoom.y = pinchState.startY + (midY - pinchState.midY);
    applyImageZoom(false);
    showZoomHud(imageZoom.scale);
    return;
  }
  if (gesture?.id !== event.pointerId || gesture.held) return;
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (!gesture.moved && Math.hypot(dx, dy) > 10) {
    gesture.moved = true;
    clearTimeout(gesture.timer);
    if (imageMode && imageZoom.scale > 1.02) {
      gesture.axis = "pan";
    } else if (!imageMode && gesture.scrubDuration > 0 && Math.abs(dx) > Math.abs(dy) * 1.15 && Math.abs(dx) > 12) {
      gesture.axis = "x";
    } else {
      gesture.axis = "y";
    }
  }
  if (!gesture.moved) return;
  if (gesture.axis === "pan") {
    imageZoom.x = gesture.panStartX + dx;
    imageZoom.y = gesture.panStartY + dy;
    applyImageZoom(false);
    return;
  }
  if (gesture.axis === "y") {
    const damped = Math.sign(dy) * Math.min(Math.abs(dy) * 0.44, 112);
    const scale = 1 - Math.min(Math.abs(damped) / 2400, 0.045);
    screenEl.classList.remove("is-spring");
    screenEl.style.transform = "translateY(" + damped.toFixed(1) + "px) scale(" + scale.toFixed(4) + ")";
    const hint = $("#swipe-hint");
    const ready = Math.abs(dy) > 44;
    hint.textContent = dy < 0
      ? (ready ? "松手切换下一条" : "继续上滑下一条")
      : (ready ? "松手切换上一条" : "继续下滑上一条");
    hint.className = "swipe-hint " + (dy < 0 ? "at-bottom" : "at-top") + (ready ? " ready" : "");
    hint.hidden = false;
    return;
  }
  if (gesture.axis === "x" && gesture.scrubDuration > 0) {
    const span = Math.min(gesture.scrubDuration, 90);
    const delta = (dx / Math.max(stage.clientWidth, 300)) * span;
    const target = Math.max(0, Math.min(gesture.scrubDuration, gesture.scrubStartPos + delta));
    gesture.scrubTarget = target;
    const hud = $("#scrub-hud");
    $("#scrub-time").textContent = clockTime(target) + " / " + clockTime(gesture.scrubDuration);
    const rounded = Math.round(target - gesture.scrubStartPos);
    let extra = (rounded >= 0 ? "+" : "") + rounded + "s";
    if (currentSegment() && folderTimeline?.duration !== null) {
      const seg = segmentAt(target);
      extra += " · 第 " + (seg.index + 1) + "/" + folderTimeline.segments.length + " 段";
    }
    $("#scrub-delta").textContent = extra;
    hud.hidden = false;
    const pct = (target / gesture.scrubDuration * 100) + "%";
    seekControl.style.setProperty("--progress", pct);
    seekRow?.style.setProperty("--progress", pct);
  }
});
stage.addEventListener("pointerup", (event) => {
  activeTouches.delete(event.pointerId);
  if (pinchState) {
    if (activeTouches.size < 2) {
      pinchState = null;
      if (imageZoom.scale < 1.06) resetImageZoom(true);
      else applyImageZoom(true);
    }
    return;
  }
  if (gesture?.id !== event.pointerId) return;
  const { x, y, held, moved, axis, cell, wasPaused, scrubTarget, scrubDuration } = gesture;
  clearTimeout(gesture.timer);
  gesture = null;
  $("#hold-badge").hidden = true;
  $("#swipe-hint").hidden = true;
  $("#scrub-hud").hidden = true;
  if (held) {
    if (video) {
      video.playbackRate = preferences.base;
      if (wasPaused) video.pause();
    }
    return;
  }
  if (axis === "pan") return;
  if (axis === "x" && scrubDuration > 0) {
    seekToGlobalPosition(scrubTarget);
    return;
  }
  const dy = event.clientY - y;
  if (axis === "y" && Math.abs(dy) > 44 && Math.abs(dy) > Math.abs(event.clientX - x)) {
    screenEl.classList.add("is-spring");
    screenEl.style.transform = "translateY(" + (dy < 0 ? "-72px" : "72px") + ")";
    screenEl.style.opacity = "0.25";
    setTimeout(() => { resetScreenDrag(false); }, 150);
    move(dy < 0 ? "next" : "prev");
    return;
  }
  if (axis === "y") {
    resetScreenDrag(true);
    return;
  }
  if (moved) return;
  if (cell) {
    cell.click();
    return;
  }
  if (stage.classList.contains("clean-mode")) {
    setCleanMode(false);
    return;
  }
  if (imageMode && imagesPerPage === 1) {
    const now = performance.now();
    const isDouble = (now - lastTap.time) < 260 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 48;
    if (isDouble) {
      clearTimeout(lastTap.timer);
      lastTap.time = 0;
      if (imageZoom.scale > 1.05) {
        resetImageZoom(true);
        showZoomHud(1);
      } else {
        const rect = stage.getBoundingClientRect();
        const cx = event.clientX - (rect.left + rect.width / 2);
        const cy = event.clientY - (rect.top + rect.height / 2);
        imageZoom = { scale: 2.2, x: -cx * 0.9, y: -cy * 0.9 };
        applyImageZoom(true);
        showZoomHud(imageZoom.scale);
      }
      return;
    }
    lastTap = {
      time: now, x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        if (active && imageMode && imagesPerPage === 1 && imageZoom.scale <= 1.05) {
          setCleanMode(!stage.classList.contains("clean-mode"));
        }
      }, 260),
    };
    return;
  }
  togglePlay();
});
["pointercancel", "lostpointercapture"].forEach((name) => stage.addEventListener(name, (event) => {
  activeTouches.delete(event.pointerId);
  if (activeTouches.size < 2) pinchState = null;
  finishHold();
}));
stage.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("blur", finishHold);
let wheelSum = 0;
let lastWheel = 0;
let lastWheelStep = 0;
let wheelUsed = false;
stage.addEventListener("wheel", (event) => {
  if (!active || event.target.closest("select") || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.ctrlKey) return;
  event.preventDefault();
  const now = performance.now();
  if (now - lastWheel > 160 || Math.sign(wheelSum) !== Math.sign(event.deltaY) ||
      (wheelUsed && now - lastWheelStep > 480 && Math.abs(event.deltaY) >= 25)) {
    wheelSum = 0;
    wheelUsed = false;
  }
  lastWheel = now;
  wheelSum += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
  if (!wheelUsed && Math.abs(wheelSum) >= 32) {
    wheelUsed = true;
    lastWheelStep = now;
    move(wheelSum > 0 ? "next" : "prev");
  }
}, { passive: false });
document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]") || !active || event.target.closest("input,textarea,select") ||
      event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    if (!event.repeat) move(event.key === "ArrowUp" ? "prev" : "next");
  }
  if (event.key === "Escape" && stage.classList.contains("clean-mode")) {
    setCleanMode(false);
    return;
  }
  if (video && event.code === "Space" && !event.target.closest("button")) {
    event.preventDefault();
    if (!event.repeat) togglePlay();
  }
});

let folderRequest = 0;
let folderPage = null;
let loadedFolders = 0;
let importing = false;
function folderError(message = "") {
  $("#folder-error").textContent = message;
  $("#folder-error").hidden = !message;
}
function importButton() {
  const path = $("#folder-path").value.trim();
  const existing = sources.some((s) => s.path === path);
  $("#import-folder").disabled = !path || importing;
  $("#import-folder").textContent = importing ? "正在引入…" : existing ? "重新扫描此文件夹" : "引入此文件夹";
}
function folderEntry(name, path) {
  const source = sources.find((item) => item.path === path);
  const button = element("button", "folder-entry");
  const label = element("span", "", name);
  if (source) label.append(element("span", "folder-tag", "已引入"));
  button.append(icon("folder"), label, icon("right"));
  button.onclick = () => browse(path);
  if (!source) return button;

  const row = element("div", "imported-folder");
  const current = sourceId === source.id;
  const switchButton = element("button", "text-button", current ? "当前" : "切换");
  switchButton.disabled = current;
  switchButton.setAttribute("aria-label", (current ? "当前文件夹 " : "切换到 ") + name);
  switchButton.onclick = () => {
    folderDialog.close();
    selectSource(source.id);
  };
  const remove = element("button", "text-button danger", "移除");
  remove.setAttribute("aria-label", "移除 " + name);
  remove.onclick = async () => {
    if (!window.confirm("从" + mediaName + "库移除文件夹“" + source.name + "”？")) return;
    remove.disabled = true;
    try {
      await api(libraryApi + "/sources/remove", { path });
      updateSources(sources.filter((item) => item.path !== path));
      await syncLibrary();
    } catch (error) {
      folderError(error.message);
      remove.disabled = false;
    }
  };
  row.append(button, switchButton, remove);
  return row;
}
async function browse(path, more = false) {
  const request = ++folderRequest;
  const list = $("#folder-list");
  folderError();
  if (!more) {
    folderPage = null;
    $("#folder-path").value = path;
    $("#parent-folder").hidden = true;
    list.replaceChildren(element("p", "", "正在读取目录…"));
    importButton();
  }
  try {
    const result = await api("/api/folders?" + new URLSearchParams({ path, offset: more ? loadedFolders : 0 }));
    if (request !== folderRequest || !folderDialog.open) return;
    folderPage = result;
    if (!more) {
      list.replaceChildren();
      list.scrollTop = 0;
      loadedFolders = 0;
      $("#folder-path").value = result.path;
      $("#folder-heading").textContent = result.path ? "子文件夹" : "可选目录";
      if (!result.path) {
        sources.filter((s) => !result.folders.some((f) => f.path === s.path))
          .forEach((s) => list.append(folderEntry(s.name, s.path)));
      }
    }
    list.querySelector(".load-more")?.remove();
    result.folders.forEach((entry) => list.append(folderEntry(entry.name, entry.path)));
    loadedFolders += result.folders.length;
    if (result.more) {
      const button = element("button", "folder-entry load-more", "显示更多文件夹");
      button.onclick = () => browse(result.path, true);
      list.append(button);
    }
    if (!list.children.length) list.append(element("p", "", "此处没有子文件夹"));
    $("#parent-folder").hidden = result.parent === null;
    importButton();
  } catch (error) {
    if (request !== folderRequest) return;
    if (!more) list.replaceChildren();
    folderError(error.message);
  }
}
function openFolders() {
  if (slideshowPlaying) setSlideshowPlaying(false);
  folderDialog.showModal();
  browse("");
}
$("#parent-folder").onclick = () => { if (folderPage) browse(folderPage.parent); };
$("#folder-path").oninput = () => { folderRequest++; folderError(); importButton(); };
$("#path-form").onsubmit = (event) => { event.preventDefault(); browse($("#folder-path").value.trim()); };
$("#import-folder").onclick = async () => {
  if (importing) return;
  const path = $("#folder-path").value.trim();
  importing = true;
  importButton();
  folderError();
  try {
    await api(libraryApi + "/sources", { path });
    folderDialog.close();
    selectSource();
    await syncLibrary();
    toast("文件夹已加入扫描");
  } catch (error) { folderError(error.message); }
  finally { importing = false; importButton(); }
};
$$("[data-close]").forEach((button) => { button.onclick = () => button.closest("dialog").close(); });
$$("[data-open]").forEach((button) => {
  button.onclick = button.dataset.open === "folders" ? openFolders : () => settingsDialog.showModal();
});
const currentMode = imageMode ? "images" : "videos";
const currentFeed = $('[data-mode="' + currentMode + '"]');
currentFeed.append($('[data-count="total"]'));
currentFeed.onclick = () => selectSource();
const otherFeed = $('[data-mode]:not([data-mode="' + currentMode + '"])');
otherFeed.classList.remove("selected");
const switchMode = () => location.assign(imageMode ? "/" : "/?mode=images");
otherFeed.onclick = switchMode;
$("#mode-switch").onclick = switchMode;
if (imageMode) {
  document.body.classList.add("image-mode");
  imagePreview.addEventListener("close", () => {
    if (imagePreview.open) return;
    previewImage.removeAttribute("src");
    if (slideshowPlaying) scheduleNextSlide();
  });
  imageGrid.hidden = false;
  $("#image-layout").hidden = false;
  const layouts = $$("#image-layout button");
  layouts.forEach((button) => {
    button.onclick = () => {
      const size = Number(button.dataset.images);
      if (size === imagesPerPage) return;
      imagesPerPage = size;
      layouts.forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
      for (const control of $$("[data-move]")) {
        const prev = control.dataset.move === "prev";
        const unit = size === 1 ? "张图片" : "组图片";
        iconState(control, prev ? "left" : "right", (prev ? "上一" : "下一") + unit);
      }
      epoch++;
      moving = false;
      move("current");
    };
  });
  slideshowButton.hidden = false;
  slideshowButton.onclick = () => setSlideshowPlaying(!slideshowPlaying);
  const savedInterval = readPreference("slideInterval");
  if (Array.from(slideInterval.options).some((option) => option.value === savedInterval)) {
    slideInterval.value = savedInterval;
  }
  slideInterval.hidden = false;
  slideInterval.onchange = () => {
    savePreference("slideInterval", slideInterval.value);
    scheduleNextSlide();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && slideshowPlaying) setSlideshowPlaying(false);
  });
  stage.setAttribute("aria-label", "图片浏览器");
  document.title = feedTitle + " · Flow";
  $("#view-title").textContent = feedTitle;
  $("#folder-dialog h2").textContent = "引入图片文件夹";
  $("#retry").textContent = "重新加载";
  iconState($("#mode-switch"), "flow", "视频流");
  $("#mode-switch span").textContent = "视频流";
  $$("[data-move]").forEach((button) => {
    const prev = button.dataset.move === "prev";
    iconState(button, prev ? "left" : "right", prev ? "上一张图片" : "下一张图片");
  });
  emptyState();
}
$("#mobile-tab-videos").onclick = () => {
  if (imageMode) switchMode();
  else if (sourceId) selectSource();
};
$("#mobile-tab-images").onclick = () => {
  if (!imageMode) switchMode();
  else if (sourceId) selectSource();
};
$("#mobile-folder-chip").onclick = () => selectSource();
$$("[data-move]").forEach((button) => { button.onclick = () => move(button.dataset.move); });
$("#home-button").onclick = () => selectSource();
const sidebarToggle = $("#sidebar-toggle");
function renderSidebar() {
  const collapsed = preferences.sidebarCollapsed;
  $("#sidebar").hidden = collapsed;
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  iconState(sidebarToggle, "sidebar", collapsed ? "展开侧栏" : "收起侧栏");
}
sidebarToggle.onclick = () => {
  savePreference("sidebarCollapsed", !preferences.sidebarCollapsed);
  renderSidebar();
};
renderSidebar();
mobileSource.onclick = () => {
  if (slideshowPlaying) setSlideshowPlaying(false);
  renderSourceChoices();
  sourceDialog.showModal();
  sourceDialog.querySelector('[aria-current="true"]')?.focus();
};
function enableSheetInteractions(dialog) {
  let downOnBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => { downOnBackdrop = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (downOnBackdrop && event.target === dialog) dialog.close();
    downOnBackdrop = false;
  });
  let dragStart = null;
  let dragDy = 0;
  dialog.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || window.innerWidth > 740) return;
    if (!event.target.closest(".sheet-handle, .dialog-head") || event.target.closest("button")) return;
    dragStart = event.clientY;
    dragDy = 0;
    dialog.style.transition = "none";
  });
  dialog.addEventListener("pointermove", (event) => {
    if (dragStart === null) return;
    dragDy = Math.max(0, event.clientY - dragStart);
    dialog.style.transform = dragDy ? "translateY(" + dragDy + "px)" : "";
  });
  const endSheetDrag = () => {
    if (dragStart === null) return;
    const shouldClose = dragDy > 68;
    dragStart = null;
    dragDy = 0;
    dialog.style.transition = "";
    dialog.style.transform = "";
    if (shouldClose) dialog.close();
  };
  dialog.addEventListener("pointerup", endSheetDrag);
  dialog.addEventListener("pointercancel", endSheetDrag);
}
[sourceDialog, folderDialog, settingsDialog].forEach(enableSheetInteractions);
$("#play").onclick = togglePlay;
$("#retry").onclick = () => {
  if (!active) return;
  if (imageMode) showImages([...visibleImages], active.id);
  else showVideo(active, playbackPosition());
};
timelineToggle.onclick = () => {
  const record = active ? { id: active.id, sourcePath: currentSource()?.path || "",
    time: playbackPosition(), paused: video.paused } : null;
  savePreference("joined", !preferences.joined);
  renderSettings();
  selectSource(sourceId, record);
  syncLibrary();
};
$("#stats-toggle").onclick = () => {
  savePreference("showStats", !preferences.showStats);
  renderSettings();
};
function toggleMute() {
  if (!video) return;
  video.muted = !video.muted;
  savePreference("muted", video.muted);
  if (!video.muted) {
    autoMuted = false;
    $("#unmute-banner").hidden = true;
  }
}
$("#volume").onclick = toggleMute;
$("#mobile-mute").onclick = toggleMute;
$("#unmute-banner").onclick = () => {
  if (!video) return;
  video.muted = false;
  autoMuted = false;
  savePreference("muted", false);
  $("#unmute-banner").hidden = true;
  updateTransport();
};
$("#mobile-clean").onclick = () => setCleanMode(true);
const fullscreenButton = $("#fullscreen");
fullscreenButton.onclick = async () => {
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen();
    else await stage.requestFullscreen();
  } catch { toast("浏览器未能切换全屏"); }
};
let fullscreenTimer = 0;
function showFullscreenControls(event) {
  clearTimeout(fullscreenTimer);
  stage.classList.remove("fullscreen-idle");
  if (document.fullscreenElement !== stage || video?.paused || event?.target?.closest?.(".transport, .seek-row")) return;
  fullscreenTimer = setTimeout(() => stage.classList.add("fullscreen-idle"), 2500);
}
document.addEventListener("fullscreenchange", () => {
  const enabled = document.fullscreenElement === stage;
  setCleanMode(false);
  iconState(fullscreenButton, enabled ? "restore" : "clean", enabled ? "退出全屏" : "全屏");
  showFullscreenControls();
});
for (const name of ["pointermove", "pointerdown", "keydown", "focusin", "play", "pause"]) {
  stage.addEventListener(name, (event) => {
    if (document.fullscreenElement === stage) showFullscreenControls(event);
  }, true);
}
$("#clean-exit").onclick = () => setCleanMode(false);
seekControl.addEventListener("pointerdown", () => {
  seekingSlider = true;
  seekRow?.classList.add("is-seeking");
  updateTransport();
});
const finishSliderSeek = () => {
  if (!seekingSlider) return;
  seekingSlider = false;
  seekRow?.classList.remove("is-seeking");
  updateTransport();
};
seekControl.addEventListener("pointerup", finishSliderSeek);
seekControl.oninput = (event) => {
  seekingSlider = true;
  seekRow?.classList.add("is-seeking");
  if (currentSegment()) {
    timelinePreview = event.target.valueAsNumber;
    updateTransport();
    return;
  }
  if (!video || !validDuration(clipLength())) return;
  const target = clipLength() * Number(event.target.value) / 1000;
  if (compatiblePlayback) timelinePreview = target;
  else video.currentTime = target - streamStart;
  updateTransport();
};
seekControl.onchange = () => {
  seekingSlider = false;
  seekRow?.classList.remove("is-seeking");
  if (!folderTimeline && compatiblePlayback && video && timelinePreview !== null) {
    const target = timelinePreview;
    timelinePreview = null;
    startCompatible(target, !video.paused);
  }
  if (!folderTimeline || timelinePreview === null || !video) {
    updateTransport();
    return;
  }
  const target = timelinePreview;
  timelinePreview = null;
  const segment = segmentAt(target);
  const position = folderTimeline.duration === null ? 0
    : Math.max(0, Math.min(target - segment.start, segment.item.duration - 0.01));
  if (segment.item.id !== active.id) showVideo(segment.item, position, !video.paused);
  else if (compatiblePlayback) startCompatible(position, !video.paused);
  else if (video.readyState < 1) pendingSeek = position;
  else {
    pendingSeek = 0;
    video.currentTime = position;
  }
  refreshGroupSeek();
  updateTransport();
};
seekControl.onpointercancel = seekControl.onblur = () => {
  seekingSlider = false;
  seekRow?.classList.remove("is-seeking");
  if (timelinePreview === null) {
    updateTransport();
    return;
  }
  timelinePreview = null;
  refreshGroupSeek();
  updateTransport();
};
renderSettings();
renderNavigation();
syncLibrary();

const pageRevision = document.querySelector('meta[name="flow-revision"]')?.content;
if (pageRevision) {
  const checkRevision = async () => {
    try {
      const { revision } = await api("/api/revision");
      if (revision && revision !== pageRevision) {
        window.location.reload();
        return;
      }
    } catch { /* 等待服务重新上线 */ }
    setTimeout(checkRevision, 1000);
  };
  setTimeout(checkRevision, 1000);
}
