// ===========================================================
// STOCKIFY PRO ULTRA — Engine (v2)
// Firebase (Firestore) + Cloudinary (Images)
// ===========================================================

// ---- CONFIG ----
const firebaseConfig = {
  apiKey: "AIzaSyBn3x2qSo8k6a9wrxNfLmVliWMmsUk8wfY",
  authDomain: "meetwoyou-436a2.firebaseapp.com",
  projectId: "meetwoyou-436a2",
  storageBucket: "meetwoyou-436a2.firebasestorage.app",
  messagingSenderId: "612788132077",
  appId: "1:612788132077:web:0a8b92edf26778efd4d4e4"
};

const CLOUDINARY = {
  cloudName: "dpgawb5sl",
  uploadPreset: "Meetwoyou"
};

// Target image size after compression (~250KB sweet spot, hard cap 320KB)
const IMG_TARGET_BYTES = 260 * 1024;
const IMG_MAX_BYTES = 320 * 1024;
const IMG_MAX_DIM = 1280;

// ---- INIT FIREBASE ----
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const productsCol = db.collection("stockify_products");

// ---- OFFLINE PERSISTENCE (IndexedDB cache) ----
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  console.warn("Offline persistence not enabled:", err.code || err.message);
});

// ---- SERVICE WORKER ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW failed:", e));
  });
}

// ---- STATE ----
let products = [];
let currentFilter = "all";
let scanner = null;
let scannerRunning = false;
let editingId = null;
let lastScannedSku = null;
let chartCategory = null;
let chartHealth = null;
let deferredInstallPrompt = null;
let pendingPriceSync = false; // guard for bi-directional price recalc

const PLACEHOLDER_IMG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect width='200' height='200' fill='%230f172a'/><text x='100' y='110' text-anchor='middle' fill='%2364748b' font-family='Arial' font-size='20'>No Image</text></svg>";

// ===========================================================
// BOOT
// ===========================================================
document.addEventListener("DOMContentLoaded", () => {
  refreshIcons();
  bindNav();
  bindNetworkStatus();
  bindInstallPrompt();
  switchPage("dashboard");
  initCharts();
  subscribeProducts();
});

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

// ===========================================================
// NAV
// ===========================================================
function bindNav() {
  document.querySelectorAll("[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => switchPage(btn.dataset.nav));
  });
}

function switchPage(page) {
  document.querySelectorAll(".page-view").forEach(p => p.classList.add("hidden"));
  const target = document.getElementById("page-" + page);
  if (target) target.classList.remove("hidden");

  document.querySelectorAll("[data-nav]").forEach(b => {
    b.classList.toggle("active", b.dataset.nav === page);
  });

  if (page !== "scanner" && scannerRunning) stopScanner();
  if (page === "scanner") setTimeout(() => startScanner(), 350);

  refreshIcons();
}
window.switchPage = switchPage;

// ===========================================================
// NETWORK STATUS
// ===========================================================
function bindNetworkStatus() {
  const update = () => {
    const dot = document.getElementById("net-dot");
    const lbl = document.getElementById("net-label");
    if (!dot || !lbl) return;
    if (navigator.onLine) {
      dot.className = "w-2 h-2 rounded-full bg-primary animate-pulse";
      lbl.innerText = "Online · synced";
    } else {
      dot.className = "w-2 h-2 rounded-full bg-amber-400";
      lbl.innerText = "Offline · changes will sync";
    }
  };
  window.addEventListener("online", () => { update(); toast("Back online — syncing", "success"); });
  window.addEventListener("offline", () => { update(); toast("Offline mode — data stays local", "info"); });
  update();
}

// ===========================================================
// INSTALL PROMPT
// ===========================================================
function bindInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const banner = document.getElementById("install-banner");
    if (banner) banner.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    document.getElementById("install-banner")?.classList.add("hidden");
    toast("Installed — open from your home screen!", "success");
  });
}

async function triggerInstall() {
  if (!deferredInstallPrompt) {
    toast("Install option not available. Use browser menu → Add to Home Screen.", "info");
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice.catch(() => null);
  if (choice?.outcome === "accepted") toast("Installing…", "success");
  deferredInstallPrompt = null;
  document.getElementById("install-banner")?.classList.add("hidden");
}
window.triggerInstall = triggerInstall;
function dismissInstall() { document.getElementById("install-banner")?.classList.add("hidden"); }
window.dismissInstall = dismissInstall;

// ===========================================================
// FIRESTORE SUBSCRIPTION (realtime + offline cache)
// ===========================================================
function subscribeProducts() {
  productsCol.onSnapshot(
    { includeMetadataChanges: true },
    snap => {
      products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderProducts();
      renderFilters();
      updateDashboard();
      updateCharts();
    },
    err => {
      console.error("Firestore error:", err);
      toast("Failed to load products: " + err.message, "error");
    }
  );
}

// ===========================================================
// DASHBOARD
// ===========================================================
function updateDashboard() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let expired = 0, expiring = 0;
  const cats = new Set();

  products.forEach(p => {
    if (p.category) cats.add(p.category);
    if (!p.expiryDate) return;
    const exp = new Date(p.expiryDate);
    const diff = (exp - today) / (1000 * 3600 * 24);
    if (diff < 0) expired++;
    else if (diff <= 7) expiring++;
  });

  setText("dash-total", products.length);
  setText("dash-expired", expired);
  setText("dash-expiring", expiring);
  setText("dash-category", cats.size);

  const list = document.getElementById("dash-expiring-list");
  if (!list) return;
  const soon = products
    .filter(p => p.expiryDate)
    .map(p => ({ ...p, days: Math.ceil((new Date(p.expiryDate) - today) / 86400000) }))
    .filter(p => p.days >= 0 && p.days <= 30)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5);

  if (soon.length === 0) {
    list.innerHTML = `<p class="text-sm text-slate-500 py-4 text-center">Nothing expiring in the next 30 days</p>`;
    return;
  }
  list.innerHTML = soon.map(p => `
    <div class="flex items-center gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800">
      <img src="${escapeAttr(p.image || PLACEHOLDER_IMG)}" class="w-11 h-11 rounded-lg object-cover bg-slate-900" />
      <div class="flex-1 min-w-0">
        <p class="font-semibold truncate">${escapeHtml(p.name)}</p>
        <p class="text-xs text-slate-500">${escapeHtml(p.category || "—")} · ${p.totalPieces || 0} pcs</p>
      </div>
      <span class="badge ${p.days <= 7 ? 'badge-expiring' : 'badge-ok'}">${p.days}d</span>
    </div>
  `).join("");
}

// ===========================================================
// CHARTS
// ===========================================================
function initCharts() {
  const ctxCat = document.getElementById("chart-category");
  const ctxHealth = document.getElementById("chart-health");
  if (!ctxCat || !ctxHealth || !window.Chart) return;

  Chart.defaults.color = "#94a3b8";
  Chart.defaults.font.family = "Inter";

  chartCategory = new Chart(ctxCat, {
    type: "bar",
    data: { labels: [], datasets: [{ label: "Pieces", data: [], backgroundColor: "#16a34a", borderRadius: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#64748b" } },
        y: { grid: { color: "rgba(148,163,184,.1)" }, ticks: { color: "#64748b" } }
      }
    }
  });

  chartHealth = new Chart(ctxHealth, {
    type: "doughnut",
    data: {
      labels: ["Healthy", "Expiring", "Expired"],
      datasets: [{ data: [0, 0, 0], backgroundColor: ["#16a34a", "#f59e0b", "#ef4444"], borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "70%", plugins: { legend: { position: "bottom" } } }
  });
}

function updateCharts() {
  if (!chartCategory || !chartHealth) return;
  const byCat = {};
  let healthy = 0, expiring = 0, expired = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  products.forEach(p => {
    const c = p.category || "Uncategorized";
    byCat[c] = (byCat[c] || 0) + (Number(p.totalPieces) || 0);
    if (!p.expiryDate) { healthy++; return; }
    const diff = (new Date(p.expiryDate) - today) / 86400000;
    if (diff < 0) expired++;
    else if (diff <= 7) expiring++;
    else healthy++;
  });

  chartCategory.data.labels = Object.keys(byCat);
  chartCategory.data.datasets[0].data = Object.values(byCat);
  chartCategory.update();

  chartHealth.data.datasets[0].data = [healthy, expiring, expired];
  chartHealth.update();
}

// ===========================================================
// FILTERS
// ===========================================================
function getAllCategories() {
  return Array.from(new Set(products.map(p => p.category).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
}

function renderFilters() {
  const el = document.getElementById("filter-chips");
  if (!el) return;
  const cats = getAllCategories();
  const chips = [
    { id: "all", label: "All" },
    { id: "expiring", label: "Expiring" },
    { id: "expired", label: "Expired" },
    ...cats.map(c => ({ id: c, label: c }))
  ];
  el.innerHTML = chips.map(c =>
    `<button class="filter-chip ${currentFilter === c.id ? 'active' : ''}" onclick="setFilter('${escapeAttr(c.id)}')">${escapeHtml(c.label)}</button>`
  ).join("");

  const dl = document.getElementById("category-list");
  if (dl) dl.innerHTML = cats.map(c => `<option value="${escapeAttr(c)}"></option>`).join("");
}

function setFilter(f) {
  currentFilter = f;
  renderProducts();
  renderFilters();
}
window.setFilter = setFilter;

// ===========================================================
// CATEGORY PICKER (Click input → show all existing categories)
// ===========================================================
function openCategoryPicker() {
  const cats = getAllCategories();
  const modal = document.getElementById("category-picker-modal");
  const list = document.getElementById("category-picker-list");
  const search = document.getElementById("category-picker-search");
  if (!modal || !list) return;

  const render = (filter = "") => {
    const f = filter.trim().toLowerCase();
    const filtered = cats.filter(c => !f || c.toLowerCase().includes(f));
    if (filtered.length === 0 && !f) {
      list.innerHTML = `<p class="text-center text-slate-500 py-8 text-sm">No categories yet. Type a new one below.</p>`;
    } else if (filtered.length === 0) {
      list.innerHTML = `
        <button onclick="pickCategory('${escapeAttr(f)}')" class="w-full text-left px-4 py-3 rounded-xl bg-primary/10 border border-primary/30 hover:bg-primary/20">
          <span class="text-primary font-bold">+ Create "${escapeHtml(f)}"</span>
        </button>`;
    } else {
      list.innerHTML = filtered.map(c => `
        <button onclick="pickCategory('${escapeAttr(c)}')" class="w-full text-left px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-between">
          <span class="font-semibold">${escapeHtml(c)}</span>
          <span class="text-xs text-slate-500">${products.filter(p=>p.category===c).length} items</span>
        </button>
      `).join("");
    }
  };
  render();
  search.value = "";
  search.oninput = () => render(search.value);
  modal.classList.remove("hidden");
  setTimeout(()=>search.focus(), 60);
}
window.openCategoryPicker = openCategoryPicker;

function closeCategoryPicker() {
  document.getElementById("category-picker-modal")?.classList.add("hidden");
}
window.closeCategoryPicker = closeCategoryPicker;

function pickCategory(name) {
  const input = document.getElementById("form-category");
  if (input) input.value = name;
  closeCategoryPicker();
  // If pcsPerCarton empty, prefill from most-recent product in this category
  const ref = products.find(p => p.category === name && p.pcsPerCarton);
  if (ref) {
    const ppc = document.getElementById("form-pcs-per");
    if (ppc && !Number(ppc.value)) { ppc.value = ref.pcsPerCarton; recalcTotal(); }
  }
}
window.pickCategory = pickCategory;
function pickCategoryNew() {
  const v = document.getElementById("category-picker-search").value.trim();
  if (v) pickCategory(v);
}
window.pickCategoryNew = pickCategoryNew;

// ===========================================================
// PRODUCTS RENDER
// ===========================================================
function renderProducts() {
  const grid = document.getElementById("product-grid");
  const empty = document.getElementById("empty-state");
  if (!grid) return;

  const q = (document.getElementById("search-input")?.value || "").toLowerCase().trim();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  let list = products.filter(p =>
    !q || (p.name || "").toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q)
  );

  if (currentFilter === "expired") {
    list = list.filter(p => p.expiryDate && new Date(p.expiryDate) < today);
  } else if (currentFilter === "expiring") {
    list = list.filter(p => {
      if (!p.expiryDate) return false;
      const d = (new Date(p.expiryDate) - today) / 86400000;
      return d >= 0 && d <= 7;
    });
  } else if (currentFilter !== "all") {
    list = list.filter(p => p.category === currentFilter);
  }

  if (list.length === 0) {
    grid.innerHTML = "";
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");

  grid.innerHTML = list.map(p => {
    let badge = "";
    if (p.expiryDate) {
      const d = (new Date(p.expiryDate) - today) / 86400000;
      if (d < 0) badge = `<span class="badge badge-expired">Expired</span>`;
      else if (d <= 7) badge = `<span class="badge badge-expiring">${Math.ceil(d)}d left</span>`;
      else badge = `<span class="badge badge-ok">Fresh</span>`;
    }
    const ppc = Number(p.pcsPerCarton) || 0;
    return `
      <div class="prod-card" onclick="openDetails('${escapeAttr(p.id)}')">
        <div class="relative">
          <img src="${escapeAttr(p.image || PLACEHOLDER_IMG)}" alt="${escapeAttr(p.name)}" loading="lazy" />
          <div class="absolute top-3 left-3">${badge}</div>
        </div>
        <div class="p-4">
          <p class="text-[10px] uppercase tracking-widest text-primary font-bold">${escapeHtml(p.category || "—")}</p>
          <h3 class="font-bold text-base mt-1 truncate">${escapeHtml(p.name)}</h3>
          <p class="text-xs text-slate-500 mt-0.5 truncate">SKU: ${escapeHtml(p.sku || "—")}</p>

          <div class="flex items-center justify-between mt-3 text-sm">
            <span class="font-bold">${p.totalPieces || 0} <span class="text-slate-500 font-normal text-xs">pcs</span></span>
            <span class="text-slate-400 text-xs">${p.expiryDate || "No expiry"}</span>
          </div>

          <div class="mt-2 text-[11px] text-slate-400 bg-slate-900/60 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
            <span>1 Carton = <b class="text-white">${ppc}</b> pcs</span>
            <span class="text-slate-500">${p.cartons || 0} cartons</span>
          </div>

          <div class="grid grid-cols-2 gap-2 mt-3">
            <div class="bg-slate-900/60 rounded-lg px-2.5 py-1.5">
              <p class="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Carton</p>
              <p class="text-sm font-black text-primary">৳ ${Number(p.cartonPrice || 0).toLocaleString()}</p>
            </div>
            <div class="bg-slate-900/60 rounded-lg px-2.5 py-1.5">
              <p class="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Piece</p>
              <p class="text-sm font-black text-primary">৳ ${Number(p.piecePrice || 0).toLocaleString()}</p>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-1.5 mt-3" onclick="event.stopPropagation()">
            <button onclick="quickAdjust('${escapeAttr(p.id)}','carton',1)" class="bg-primary/15 hover:bg-primary/25 text-primary py-1.5 rounded-lg text-[11px] font-bold">+1 Carton</button>
            <button onclick="quickAdjust('${escapeAttr(p.id)}','carton',-1)" class="bg-slate-800 hover:bg-slate-700 py-1.5 rounded-lg text-[11px] font-bold">−1 Carton</button>
            <button onclick="quickAdjust('${escapeAttr(p.id)}','piece',1)" class="bg-slate-800 hover:bg-slate-700 py-1.5 rounded-lg text-[11px] font-bold">+1 Pc</button>
          </div>

          <div class="flex gap-2 mt-2 pt-2 border-t border-slate-800">
            <button onclick="event.stopPropagation(); editProduct('${escapeAttr(p.id)}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5">
              <i data-lucide="pencil" class="w-3.5 h-3.5"></i> Edit
            </button>
            <button onclick="event.stopPropagation(); deleteProduct('${escapeAttr(p.id)}')" class="flex-1 bg-red-500/15 hover:bg-red-500/25 text-red-400 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }).join("");
  refreshIcons();
}
window.renderProducts = renderProducts;

// Quick stock adjust from card
async function quickAdjust(id, kind, delta) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const ppc = Number(p.pcsPerCarton) || 0;
  let cartons = Number(p.cartons) || 0;
  let pieces  = Number(p.totalPieces) || 0;

  if (kind === "carton") {
    cartons = Math.max(0, cartons + delta);
    pieces  = Math.max(0, pieces + delta * (ppc || 1));
  } else {
    pieces  = Math.max(0, pieces + delta);
    if (ppc) cartons = Math.floor(pieces / ppc);
  }
  try {
    await productsCol.doc(id).set({ cartons, totalPieces: pieces, updatedAt: Date.now() }, { merge: true });
    toast(`${p.name}: ${pieces} pcs`, "success");
  } catch (err) {
    toast("Update failed: " + err.message, "error");
  }
}
window.quickAdjust = quickAdjust;

// ===========================================================
// FORM (ADD / EDIT)
// ===========================================================
function openAddProductForm() {
  editingId = null;
  document.getElementById("product-form").reset();
  document.getElementById("form-id").value = "";
  document.getElementById("form-image").value = "";
  document.getElementById("form-image-preview").innerHTML = `<i data-lucide="image" class="w-7 h-7 text-slate-600"></i>`;
  document.getElementById("form-title").innerText = "Add Product";
  document.getElementById("form-submit-btn").innerText = "Save";
  document.getElementById("product-form-modal").classList.remove("hidden");
  refreshIcons();
}
window.openAddProductForm = openAddProductForm;

function closeProductForm() {
  document.getElementById("product-form-modal").classList.add("hidden");
  editingId = null;
}
window.closeProductForm = closeProductForm;

function editProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  openAddProductForm();
  document.getElementById("form-id").value = id;
  document.getElementById("form-name").value = p.name || "";
  document.getElementById("form-sku").value = p.sku || "";
  document.getElementById("form-category").value = p.category || "";
  document.getElementById("form-cartons").value = p.cartons || 0;
  document.getElementById("form-pcs-per").value = p.pcsPerCarton || 0;
  document.getElementById("form-total-pcs").value = p.totalPieces || 0;
  document.getElementById("form-carton-price").value = p.cartonPrice || 0;
  document.getElementById("form-piece-price").value = p.piecePrice || 0;
  document.getElementById("form-expiry").value = p.expiryDate || "";
  document.getElementById("form-image").value = p.image || "";
  if (p.image) {
    document.getElementById("form-image-preview").innerHTML = `<img src="${escapeAttr(p.image)}" class="w-full h-full object-cover" />`;
  }
  document.getElementById("form-title").innerText = "Edit Product";
  document.getElementById("form-submit-btn").innerText = "Update";
}
window.editProduct = editProduct;

function recalcTotal() {
  const c  = Number(document.getElementById("form-cartons").value) || 0;
  const pc = Number(document.getElementById("form-pcs-per").value) || 0;
  if (c && pc) document.getElementById("form-total-pcs").value = c * pc;
  // also keep price in sync if pcsPerCarton changed
  syncPriceFromPiece();
}
window.recalcTotal = recalcTotal;

// Bi-directional pricing
function syncPriceFromPiece() {
  if (pendingPriceSync) return;
  const pc = Number(document.getElementById("form-pcs-per").value) || 0;
  const piece = Number(document.getElementById("form-piece-price").value) || 0;
  if (!pc) return;
  pendingPriceSync = true;
  document.getElementById("form-carton-price").value = +(piece * pc).toFixed(2);
  pendingPriceSync = false;
}
function syncPriceFromCarton() {
  if (pendingPriceSync) return;
  const pc = Number(document.getElementById("form-pcs-per").value) || 0;
  const carton = Number(document.getElementById("form-carton-price").value) || 0;
  if (!pc) return;
  pendingPriceSync = true;
  document.getElementById("form-piece-price").value = +(carton / pc).toFixed(2);
  pendingPriceSync = false;
}
window.syncPriceFromPiece = syncPriceFromPiece;
window.syncPriceFromCarton = syncPriceFromCarton;

async function saveProduct(e) {
  e.preventDefault();
  const btn = document.getElementById("form-submit-btn");
  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = "Saving...";

  try {
    const data = {
      name: val("form-name").trim(),
      sku: val("form-sku").trim(),
      category: val("form-category").trim(),
      cartons: Number(val("form-cartons")) || 0,
      pcsPerCarton: Number(val("form-pcs-per")) || 0,
      totalPieces: Number(val("form-total-pcs")) || 0,
      cartonPrice: Number(val("form-carton-price")) || 0,
      piecePrice: Number(val("form-piece-price")) || 0,
      expiryDate: val("form-expiry"),
      image: val("form-image") || "",
      updatedAt: Date.now()
    };

    if (!data.name || !data.sku) throw new Error("Name and SKU required");
    const skuMatch = products.find(p => p.sku === data.sku && p.id !== editingId);
    if (skuMatch) throw new Error("SKU already exists");

    // Note: write resolves locally even offline; will sync when online.
    if (editingId) {
      productsCol.doc(editingId).set(data, { merge: true });
      toast(navigator.onLine ? "Product updated" : "Saved offline — will sync", "success");
    } else {
      data.createdAt = Date.now();
      productsCol.add(data);
      toast(navigator.onLine ? "Product added" : "Saved offline — will sync", "success");
    }
    closeProductForm();
  } catch (err) {
    console.error(err);
    toast(err.message || "Save failed", "error");
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
}
window.saveProduct = saveProduct;

async function deleteProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Delete "${p.name}"?`)) return;
  try {
    await productsCol.doc(id).delete();
    toast("Product deleted", "success");
  } catch (err) {
    toast("Delete failed: " + err.message, "error");
  }
}
window.deleteProduct = deleteProduct;

// ===========================================================
// IMAGE: COMPRESS → CLOUDINARY UPLOAD
// ===========================================================
function readFileAsImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error("Invalid image")); };
    img.src = url;
  });
}

async function compressImage(file) {
  // If already small enough, return as-is
  if (file.size <= IMG_MAX_BYTES && /jpe?g$/i.test(file.type)) return file;

  const img = await readFileAsImage(file);
  let { width: w, height: h } = img;
  const scale = Math.min(1, IMG_MAX_DIM / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // flatten transparency for JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Iterate quality down until target reached
  let quality = 0.92;
  let blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  while (blob && blob.size > IMG_TARGET_BYTES && quality > 0.4) {
    quality -= 0.08;
    blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  }
  // If still huge, shrink dimensions
  let curW = w, curH = h;
  while (blob && blob.size > IMG_MAX_BYTES && Math.max(curW, curH) > 512) {
    curW = Math.round(curW * 0.85);
    curH = Math.round(curH * 0.85);
    canvas.width = curW; canvas.height = curH;
    const c2 = canvas.getContext("2d");
    c2.fillStyle = "#ffffff"; c2.fillRect(0,0,curW,curH);
    c2.drawImage(img, 0, 0, curW, curH);
    blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  }
  return new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}

async function uploadImageFile(file) {
  if (!file) return null;
  if (!navigator.onLine) {
    toast("Image upload needs internet. Save now, add image later.", "error");
    return null;
  }
  const label = document.getElementById("upload-btn-label");
  const camLabel = document.getElementById("camera-btn-label");
  if (label) label.innerText = "Compressing...";
  if (camLabel) camLabel.innerText = "Working...";

  try {
    const compressed = await compressImage(file);
    if (label) label.innerText = `Uploading ${Math.round(compressed.size/1024)}KB...`;

    const fd = new FormData();
    fd.append("file", compressed);
    fd.append("upload_preset", CLOUDINARY.uploadPreset);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/image/upload`, {
      method: "POST", body: fd
    });
    const json = await res.json();
    if (!res.ok || !json.secure_url) throw new Error(json.error?.message || "Upload failed");

    document.getElementById("form-image").value = json.secure_url;
    document.getElementById("form-image-preview").innerHTML = `<img src="${escapeAttr(json.secure_url)}" class="w-full h-full object-cover" />`;
    toast(`Image uploaded (${Math.round(compressed.size/1024)} KB)`, "success");
    return json.secure_url;
  } catch (err) {
    console.error(err);
    toast("Image upload failed: " + err.message, "error");
    return null;
  } finally {
    if (label) label.innerText = "Upload";
    if (camLabel) camLabel.innerText = "Camera";
  }
}

async function uploadImage(e) {
  const file = e.target.files?.[0];
  await uploadImageFile(file);
  e.target.value = "";
}
window.uploadImage = uploadImage;

async function captureImage(e) {
  const file = e.target.files?.[0];
  await uploadImageFile(file);
  e.target.value = "";
}
window.captureImage = captureImage;

// ===========================================================
// DETAILS MODAL
// ===========================================================
function openDetails(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let status = `<span class="badge badge-ok">Fresh</span>`;
  if (p.expiryDate) {
    const d = (new Date(p.expiryDate) - today) / 86400000;
    if (d < 0) status = `<span class="badge badge-expired">Expired</span>`;
    else if (d <= 7) status = `<span class="badge badge-expiring">${Math.ceil(d)}d left</span>`;
  }
  document.getElementById("details-content").innerHTML = `
    <div class="relative">
      <img src="${escapeAttr(p.image || PLACEHOLDER_IMG)}" class="w-full h-56 object-cover bg-slate-900" />
      <button onclick="closeDetails()" class="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/60 backdrop-blur flex items-center justify-center">
        <i data-lucide="x" class="w-5 h-5"></i>
      </button>
      <div class="absolute top-3 left-3">${status}</div>
    </div>
    <div class="p-6">
      <p class="text-xs uppercase tracking-widest text-primary font-bold">${escapeHtml(p.category || "—")}</p>
      <h2 class="text-2xl font-black mt-1">${escapeHtml(p.name)}</h2>
      <p class="text-xs text-slate-500 mt-1">SKU: ${escapeHtml(p.sku || "—")}</p>
      <div class="grid grid-cols-2 gap-3 mt-5">
        <div class="bg-slate-900 rounded-xl p-3"><p class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Total Stock</p><p class="text-lg font-black mt-1">${p.totalPieces || 0} pcs</p></div>
        <div class="bg-slate-900 rounded-xl p-3"><p class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Cartons</p><p class="text-lg font-black mt-1">${p.cartons || 0}</p></div>
        <div class="bg-slate-900 rounded-xl p-3"><p class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Pcs / Carton</p><p class="text-lg font-black mt-1">${p.pcsPerCarton || 0}</p></div>
        <div class="bg-slate-900 rounded-xl p-3"><p class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Expiry</p><p class="text-lg font-black mt-1">${p.expiryDate || "—"}</p></div>
        <div class="bg-slate-900 rounded-xl p-3"><p class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Carton Price</p><p class="text-lg font-black mt-1 text-primary">৳ ${Number(p.cartonPrice || 0).toLocaleString()}</p></div>
        <div class="bg-slate-900 rounded-xl p-3"><p class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Piece Price</p><p class="text-lg font-black mt-1 text-primary">৳ ${Number(p.piecePrice || 0).toLocaleString()}</p></div>
      </div>
      <div class="flex gap-2 mt-5">
        <button onclick="closeDetails(); editProduct('${escapeAttr(p.id)}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2">
          <i data-lucide="pencil" class="w-4 h-4"></i> Edit
        </button>
        <button onclick="closeDetails()" class="flex-1 bg-primary hover:bg-primaryDark py-3 rounded-xl font-bold">Close</button>
      </div>
    </div>
  `;
  document.getElementById("details-modal").classList.remove("hidden");
  refreshIcons();
}
window.openDetails = openDetails;
function closeDetails() { document.getElementById("details-modal").classList.add("hidden"); }
window.closeDetails = closeDetails;

// ===========================================================
// SCANNER (robust — waits for lib, lists cameras, retries)
// ===========================================================
function waitForScannerLib(timeout = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      if (window.Html5Qrcode) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error("Scanner library failed to load. Check internet then reload."));
      setTimeout(tick, 120);
    })();
  });
}

function setScannerStatus(text) {
  const ph = document.getElementById("scanner-placeholder");
  if (ph) { ph.innerText = text; ph.classList.remove("hidden"); }
}
function hideScannerStatus() {
  document.getElementById("scanner-placeholder")?.classList.add("hidden");
}

async function startScanner() {
  if (scannerRunning) return;
  setScannerStatus("Starting camera…");

  try {
    await waitForScannerLib();
  } catch (err) {
    setScannerStatus(err.message);
    toast(err.message, "error");
    return;
  }

  // HTTPS / localhost required
  const secure = window.isSecureContext || ["localhost","127.0.0.1"].includes(location.hostname);
  if (!secure) {
    const msg = "Camera needs HTTPS. Open the site via https:// (e.g. GitHub Pages URL).";
    setScannerStatus(msg); toast(msg, "error"); return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const msg = "Camera API unavailable in this browser.";
    setScannerStatus(msg); toast(msg, "error"); return;
  }

  // Reset container to avoid stale internal nodes
  const container = document.getElementById("scanner-container");
  if (container) container.innerHTML = "";

  // Try to enumerate cameras first (this prompts permission cleanly on modern browsers)
  let cameras = [];
  try {
    cameras = await Html5Qrcode.getCameras();
  } catch (err) {
    console.warn("getCameras failed (will try facingMode):", err);
  }

  scanner = new Html5Qrcode("scanner-container", { verbose: false });
  const config = {
    fps: 12,
    qrbox: (vw, vh) => {
      const s = Math.floor(Math.min(vw, vh) * 0.75);
      return { width: s, height: s };
    },
    aspectRatio: 1.0,
    rememberLastUsedCamera: true,
    formatsToSupport: window.Html5QrcodeSupportedFormats ? undefined : undefined
  };

  const attempts = [];
  if (cameras && cameras.length) {
    // Prefer back camera (usually last, often label contains 'back' or 'environment')
    const back = cameras.find(c => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];
    attempts.push(back.id);
    cameras.forEach(c => { if (c.id !== back.id) attempts.push(c.id); });
  }
  // Fallback constraints
  attempts.push({ facingMode: { ideal: "environment" } });
  attempts.push({ facingMode: "user" });

  let started = false, lastErr = null;
  for (const src of attempts) {
    try {
      await scanner.start(src, config, handleScan, () => {});
      started = true;
      break;
    } catch (err) {
      lastErr = err;
      console.warn("Scanner attempt failed for", src, err);
    }
  }

  if (!started) {
    scanner = null;
    let msg = (lastErr && (lastErr.message || lastErr)) || "Camera failed to start";
    if (/NotAllowed|Permission/i.test(msg)) {
      msg = "Camera blocked. Tap the 🔒/ⓘ icon in the address bar → Allow Camera → reload.";
    } else if (/NotFound/i.test(msg)) {
      msg = "No camera detected on this device.";
    } else if (/NotReadable|in use/i.test(msg)) {
      msg = "Camera busy — close other apps using it and retry.";
    }
    setScannerStatus(msg);
    toast(msg, "error");
    return;
  }

  scannerRunning = true;
  hideScannerStatus();
  document.getElementById("scan-start-btn").classList.add("hidden");
  document.getElementById("scan-stop-btn").classList.remove("hidden");
}
window.startScanner = startScanner;

async function stopScanner() {
  if (!scanner) { scannerRunning = false; return; }
  try { if (scannerRunning) await scanner.stop(); } catch (e) {}
  try { await scanner.clear(); } catch (e) {}
  scanner = null;
  scannerRunning = false;
  document.getElementById("scan-start-btn")?.classList.remove("hidden");
  document.getElementById("scan-stop-btn")?.classList.add("hidden");
  setScannerStatus("Camera stopped");
}
window.stopScanner = stopScanner;

let scanCooldown = false;
function handleScan(code) {
  if (scanCooldown) return;
  scanCooldown = true;
  setTimeout(() => (scanCooldown = false), 1500);

  beep();
  const product = products.find(p => p.sku === code);
  if (product) {
    stopScanner();
    showScanModal(product);
  } else {
    lastScannedSku = code;
    stopScanner();
    switchPage("products");
    openAddProductForm();
    document.getElementById("form-sku").value = code;
    toast(`New SKU detected: ${code} — fill details to add`, "info");
  }
}

function showScanModal(p) {
  lastScannedSku = p.sku;
  document.getElementById("scan-product-image").src = p.image || PLACEHOLDER_IMG;
  document.getElementById("scan-product-name").innerText = p.name || "";
  document.getElementById("scan-product-category").innerText = p.category || "";
  document.getElementById("scan-product-stock").innerText = p.totalPieces || 0;
  document.getElementById("scan-product-expiry").innerText = p.expiryDate || "—";
  document.getElementById("scan-product-sku").innerText = p.sku || "";
  document.getElementById("scan-product-carton").innerText = "৳ " + Number(p.cartonPrice || 0).toLocaleString();
  document.getElementById("scan-product-piece").innerText = "৳ " + Number(p.piecePrice || 0).toLocaleString();
  document.getElementById("scan-result-modal").classList.remove("hidden");
}
function closeScanModal() { document.getElementById("scan-result-modal").classList.add("hidden"); }
window.closeScanModal = closeScanModal;

function editFromScan() {
  const p = products.find(x => x.sku === lastScannedSku);
  if (!p) return;
  closeScanModal();
  editProduct(p.id);
}
window.editFromScan = editFromScan;

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.18, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    o.start(); o.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}

// ===========================================================
// THEME
// ===========================================================
function toggleTheme() {
  document.documentElement.classList.toggle("dark");
  toast("Theme switched", "info");
}
window.toggleTheme = toggleTheme;

// ===========================================================
// CSV EXPORT
// ===========================================================
function exportCSV() {
  if (products.length === 0) { toast("No products to export", "error"); return; }
  const headers = ["Name", "SKU", "Category", "Cartons", "PcsPerCarton", "TotalPieces", "CartonPrice", "PiecePrice", "ExpiryDate"];
  const rows = products.map(p => [
    p.name, p.sku, p.category, p.cartons, p.pcsPerCarton, p.totalPieces, p.cartonPrice, p.piecePrice, p.expiryDate
  ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `stockify-${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast("CSV exported", "success");
}
window.exportCSV = exportCSV;

// ===========================================================
// TOAST
// ===========================================================
function toast(msg, type = "info") {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerText = msg;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(20px)"; el.style.transition = "all .3s"; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

// ===========================================================
// UTILS
// ===========================================================
function val(id) { return document.getElementById(id).value; }
function setText(id, v) { const el = document.getElementById(id); if (el) el.innerText = v; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
