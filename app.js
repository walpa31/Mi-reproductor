// --- IndexedDB helper (sin librerías) ---
const DB_NAME = "mediaLibraryDB";
const DB_VERSION = 1;
const STORE = "tracks";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(track) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Utilidades ---
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- Estado del reproductor ---
let tracks = [];         // [{id, name, type, size, addedAt, blob}]
let currentIndex = -1;
let objectUrl = null;

let playMode = "normal";     // normal | shuffle
let repeatMode = "none";     // none | one | all

// --- UI refs ---
const fileInput = document.getElementById("fileInput");
const clearBtn = document.getElementById("clearBtn");
const trackList = document.getElementById("trackList");
const emptyState = document.getElementById("emptyState");

const playModeSel = document.getElementById("playMode");
const repeatModeSel = document.getElementById("repeatMode");

const audio = document.getElementById("audio");
const nowTitle = document.getElementById("nowTitle");
const nowType = document.getElementById("nowType");

const prevBtn = document.getElementById("prevBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const nextBtn = document.getElementById("nextBtn");

const volume = document.getElementById("volume");
const rate = document.getElementById("rate");

// --- Carga inicial + Service Worker ---
(async function init() {
  // Service worker
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.warn("SW no registrado:", e);
    }
  }

  // Restaurar modos guardados
  playMode = localStorage.getItem("playMode") || "normal";
  repeatMode = localStorage.getItem("repeatMode") || "none";
  playModeSel.value = playMode;
  repeatModeSel.value = repeatMode;

  // Cargar biblioteca
  tracks = (await dbGetAll()).sort((a, b) => b.addedAt - a.addedAt);
  renderList();

  // Config audio
  audio.volume = Number(localStorage.getItem("volume") ?? "1");
  audio.playbackRate = Number(localStorage.getItem("rate") ?? "1");
  volume.value = String(audio.volume);
  rate.value = String(audio.playbackRate);

  setupMediaSession();
})();

// --- Eventos UI ---
fileInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  // Guardar en DB (local)
  for (const f of files) {
    const id = uid();
    const track = {
      id,
      name: f.name,
      type: f.type || "application/octet-stream",
      size: f.size,
      addedAt: Date.now(),
      blob: f
    };
    await dbPut(track);
  }

  tracks = (await dbGetAll()).sort((a, b) => b.addedAt - a.addedAt);
  renderList();
  fileInput.value = "";
});

clearBtn.addEventListener("click", async () => {
  // Borrado total (sin confirm modal para mantenerlo simple)
  await dbClear();
  stopPlayback();
  tracks = [];
  currentIndex = -1;
  renderList();
});

playModeSel.addEventListener("change", () => {
  playMode = playModeSel.value;
  localStorage.setItem("playMode", playMode);
});

repeatModeSel.addEventListener("change", () => {
  repeatMode = repeatModeSel.value;
  localStorage.setItem("repeatMode", repeatMode);
  audio.loop = (repeatMode === "one");
});

prevBtn.addEventListener("click", () => playPrev());
nextBtn.addEventListener("click", () => playNext());

playPauseBtn.addEventListener("click", async () => {
  if (audio.paused) {
    try { await audio.play(); } catch (e) { console.warn(e); }
  } else {
    audio.pause();
  }
});

volume.addEventListener("input", () => {
  audio.volume = Number(volume.value);
  localStorage.setItem("volume", String(audio.volume));
});

rate.addEventListener("input", () => {
  audio.playbackRate = Number(rate.value);
  localStorage.setItem("rate", String(audio.playbackRate));
});

// Al terminar pista:
audio.addEventListener("ended", () => {
  // Si repeat one, el loop lo maneja audio.loop
  if (repeatMode === "one") return;

  // Si no hay pistas
  if (!tracks.length) return;

  // Siguiente lógica
  const isLast = (currentIndex === tracks.length - 1);
  if (isLast) {
    if (repeatMode === "all") {
      currentIndex = -1;
      playNext();
    } else {
      // repeat none
      stopPlayback(false);
    }
  } else {
    playNext();
  }
});

// --- Render y acciones ---
function renderList() {
  trackList.innerHTML = "";
  emptyState.style.display = tracks.length ? "none" : "block";

  tracks.forEach((t, idx) => {
    const li = document.createElement("li");
    li.className = "track" + (idx === currentIndex ? " active" : "");

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="name">${escapeHtml(t.name)}</div>
      <div class="sub">${escapeHtml(t.type)} • ${formatBytes(t.size)}</div>
    `;

    const playBtn = document.createElement("button");
    playBtn.className = "btn mini";
    playBtn.textContent = "▶️";
    playBtn.addEventListener("click", () => playIndex(idx));

    const delBtn = document.createElement("button");
    delBtn.className = "btn mini danger";
    delBtn.textContent = "🗑️";
    delBtn.addEventListener("click", async () => {
      const wasCurrent = idx === currentIndex;
      await dbDelete(t.id);

      tracks = (await dbGetAll()).sort((a, b) => b.addedAt - a.addedAt);

      if (wasCurrent) {
        stopPlayback();
        currentIndex = -1;
      } else if (idx < currentIndex) {
        currentIndex -= 1;
      }

      renderList();
    });

    li.appendChild(left);
    li.appendChild(playBtn);
    li.appendChild(delBtn);
    trackList.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

function stopPlayback(resetNow = true) {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (resetNow) {
    nowTitle.textContent = "Nada reproduciéndose";
    nowType.textContent = "—";
  }
  updateMediaSessionPlaybackState();
  renderList();
}

async function playIndex(idx) {
  if (idx < 0 || idx >= tracks.length) return;

  currentIndex = idx;
  const t = tracks[currentIndex];

  // liberar URL anterior
  if (objectUrl) URL.revokeObjectURL(objectUrl);

  objectUrl = URL.createObjectURL(t.blob);
  audio.src = objectUrl;

  // Loop “one”
  audio.loop = (repeatMode === "one");

  nowTitle.textContent = t.name;
  nowType.textContent = t.type || "media";

  renderList();
  updateMediaSessionMetadata(t);

  try {
    await audio.play();
  } catch (e) {
    // Algunos móviles requieren gesto del usuario: ya hubo click, pero igual…
    console.warn("No se pudo reproducir:", e);
  }
  updateMediaSessionPlaybackState();
}

function getNextIndex() {
  if (!tracks.length) return -1;

  if (playMode === "shuffle") {
    if (tracks.length === 1) return currentIndex;
    let next = currentIndex;
    while (next === currentIndex) next = Math.floor(Math.random() * tracks.length);
    return next;
  }

  // normal
  const next = currentIndex + 1;
  if (next >= tracks.length) return 0; // solo se usará si repeat=all o si el usuario da next
  return next;
}

function getPrevIndex() {
  if (!tracks.length) return -1;

  if (playMode === "shuffle") {
    if (tracks.length === 1) return currentIndex;
    let prev = currentIndex;
    while (prev === currentIndex) prev = Math.floor(Math.random() * tracks.length);
    return prev;
  }

  // normal
  const prev = currentIndex - 1;
  if (prev < 0) return tracks.length - 1;
  return prev;
}

function playNext() {
  if (!tracks.length) return;
  if (currentIndex === -1) return playIndex(0);

  // En repeat none, si estás en la última y presionas next, lo mando al primero (comportamiento común)
  const next = getNextIndex();

  // Si terminó la última y repeat none, la lógica de "ended" ya frenó.
  playIndex(next);
}

function playPrev() {
  if (!tracks.length) return;
  if (currentIndex === -1) return playIndex(0);
  const prev = getPrevIndex();
  playIndex(prev);
}

// --- Media Session (controles en lockscreen / auriculares cuando se puede) ---
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.setActionHandler("play", async () => {
    try { await audio.play(); } catch {}
    updateMediaSessionPlaybackState();
  });

  navigator.mediaSession.setActionHandler("pause", () => {
    audio.pause();
    updateMediaSessionPlaybackState();
  });

  navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
  navigator.mediaSession.setActionHandler("nexttrack", () => playNext());

  // Seek (si el navegador soporta)
  try {
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.fastSeek && "fastSeek" in audio) audio.fastSeek(details.seekTime);
      else audio.currentTime = details.seekTime;
    });
  } catch {}
}

function updateMediaSessionMetadata(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.name,
    artist: "Biblioteca local",
    album: "Mi Reproductor",
    artwork: []
  });
}

function updateMediaSessionPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
}