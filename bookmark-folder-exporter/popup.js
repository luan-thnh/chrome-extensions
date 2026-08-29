const els = {
  folderTree: document.getElementById("folderTree"),
  folderSearch: document.getElementById("folderSearch"),
  selectionSummary: document.getElementById("selectionSummary"),
  selectedFolderBadge: document.getElementById("selectedFolderBadge"),
  recursiveToggle: document.getElementById("recursiveToggle"),
  httpOnlyToggle: document.getElementById("httpOnlyToggle"),
  resultSearch: document.getElementById("resultSearch"),
  domainFilter: document.getElementById("domainFilter"),
  sortSelect: document.getElementById("sortSelect"),
  dedupeToggle: document.getElementById("dedupeToggle"),
  resetFiltersBtn: document.getElementById("resetFiltersBtn"),
  previewList: document.getElementById("previewList"),
  emptyState: document.getElementById("emptyState"),
  linkStat: document.getElementById("linkStat"),
  folderStat: document.getElementById("folderStat"),
  domainStat: document.getElementById("domainStat"),
  duplicateStat: document.getElementById("duplicateStat"),
  exportHint: document.getElementById("exportHint"),
  exportExcelBtn: document.getElementById("exportExcelBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  copyUrlsBtn: document.getElementById("copyUrlsBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  themeBtn: document.getElementById("themeBtn"),
  selectVisibleBtn: document.getElementById("selectVisibleBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  toolsToggle: document.getElementById("toolsToggle"),
  toolsBody: document.getElementById("toolsBody"),
  toolsChevron: document.getElementById("toolsChevron"),
  toast: document.getElementById("toast")
};

const STORAGE_KEY = "bfe_settings_v2";
let bookmarkTree = [];
let folders = [];
let selectedFolderIds = new Set();
let rawRows = [];
let currentRows = [];
let currentVisibleFolders = [];

const defaultSettings = {
  recursive: true,
  httpOnly: true,
  dedupe: true,
  sort: "original",
  theme: "dark",
  selectedFolderIds: []
};

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  const settings = {
    recursive: els.recursiveToggle.checked,
    httpOnly: els.httpOnlyToggle.checked,
    dedupe: els.dedupeToggle.checked,
    sort: els.sortSelect.value,
    theme: document.documentElement.dataset.theme || "dark",
    selectedFolderIds: [...selectedFolderIds]
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function applySavedSettings() {
  const s = loadSettings();
  els.recursiveToggle.checked = !!s.recursive;
  els.httpOnlyToggle.checked = !!s.httpOnly;
  els.dedupeToggle.checked = !!s.dedupe;
  els.sortSelect.value = s.sort || "original";
  document.documentElement.dataset.theme = s.theme === "light" ? "light" : "dark";
  els.themeBtn.textContent = s.theme === "light" ? "☾" : "☼";
  selectedFolderIds = new Set((s.selectedFolderIds || []).map(String));
}

document.addEventListener("DOMContentLoaded", async () => {
  applySavedSettings();
  bindEvents();
  await init();
});

function bindEvents() {
  els.folderSearch.addEventListener("input", renderFolderTree);
  els.recursiveToggle.addEventListener("change", refreshDataAndSave);
  els.httpOnlyToggle.addEventListener("change", applyFiltersAndSave);
  els.dedupeToggle.addEventListener("change", applyFiltersAndSave);
  els.resultSearch.addEventListener("input", applyFilters);
  els.domainFilter.addEventListener("input", applyFilters);
  els.sortSelect.addEventListener("change", applyFiltersAndSave);
  els.resetFiltersBtn.addEventListener("click", resetFilters);
  els.exportExcelBtn.addEventListener("click", exportExcel);
  els.exportCsvBtn.addEventListener("click", exportCsv);
  els.copyUrlsBtn.addEventListener("click", copyUrls);
  els.refreshBtn.addEventListener("click", init);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.selectVisibleBtn.addEventListener("click", selectVisibleFolders);
  els.clearSelectionBtn.addEventListener("click", clearSelection);
  els.toolsToggle.addEventListener("click", toggleTools);
}

async function init() {
  try {
    els.refreshBtn.textContent = "…";
    bookmarkTree = await chrome.bookmarks.getTree();
    folders = [];
    collectFolders(bookmarkTree, []);
    const validIds = new Set(folders.map(f => f.id));
    selectedFolderIds = new Set([...selectedFolderIds].filter(id => validIds.has(id)));
    renderFolderTree();
    renderSelectionSummary();
    await rebuildRawRows();
    saveSettings();
    showToast(`Đã tải ${folders.length} folder bookmark`);
  } catch (err) {
    console.error(err);
    showToast("Không đọc được bookmark. Kiểm tra quyền extension.");
  } finally {
    els.refreshBtn.textContent = "↻";
  }
}

function collectFolders(nodes, parentPath) {
  for (const node of nodes) {
    if (node.url) continue;
    const isRoot = node.id === "0";
    const title = node.title || "Bookmarks";
    const path = isRoot ? [] : [...parentPath, title];
    if (!isRoot) {
      folders.push({
        id: String(node.id),
        title,
        path,
        depth: Math.max(0, path.length - 1),
        directBookmarks: (node.children || []).filter(c => !!c.url).length,
        totalBookmarks: countBookmarks(node.children || [])
      });
    }
    if (node.children) collectFolders(node.children, path);
  }
}

function countBookmarks(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (node.url) count += 1;
    else if (node.children) count += countBookmarks(node.children);
  }
  return count;
}

function normalizeText(v) {
  return (v || "").toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function renderFolderTree() {
  const q = normalizeText(els.folderSearch.value.trim());
  currentVisibleFolders = folders.filter(folder => !q || normalizeText(folder.path.join(" / ")).includes(q));
  els.folderTree.innerHTML = "";

  if (!currentVisibleFolders.length) {
    els.folderTree.innerHTML = '<div class="no-folder">Không tìm thấy folder phù hợp.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const folder of currentVisibleFolders) {
    const row = document.createElement("label");
    row.className = `folder-row${selectedFolderIds.has(folder.id) ? " selected" : ""}`;
    row.style.setProperty("--depth", q ? 0 : Math.min(folder.depth, 6));
    row.title = folder.path.join(" / ");

    const branch = document.createElement("span");
    branch.className = "branch";
    branch.textContent = folder.depth ? "↳" : "›";

    const glyph = document.createElement("span");
    glyph.className = "folder-glyph";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = q ? folder.path.join(" / ") : folder.title;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = els.recursiveToggle.checked ? folder.totalBookmarks : folder.directBookmarks;
    count.title = els.recursiveToggle.checked ? "Tổng bookmark trong nhánh" : "Bookmark trực tiếp";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "folder-check";
    check.checked = selectedFolderIds.has(folder.id);
    check.addEventListener("change", async () => {
      if (check.checked) selectedFolderIds.add(folder.id);
      else selectedFolderIds.delete(folder.id);
      row.classList.toggle("selected", check.checked);
      renderSelectionSummary();
      saveSettings();
      await rebuildRawRows();
    });

    row.append(branch, glyph, name, count, check);
    frag.appendChild(row);
  }
  els.folderTree.appendChild(frag);
}

function renderSelectionSummary() {
  const selected = folders.filter(f => selectedFolderIds.has(f.id));
  const strong = els.selectionSummary.querySelector("strong");
  els.selectedFolderBadge.textContent = `${selected.length} folder`;
  if (!selected.length) {
    strong.textContent = "Chưa chọn folder";
    return;
  }
  const labels = selected.slice(0, 4).map(f => f.title);
  strong.textContent = labels.join(" • ") + (selected.length > 4 ? ` +${selected.length - 4}` : "");
}

async function selectVisibleFolders() {
  currentVisibleFolders.forEach(f => selectedFolderIds.add(f.id));
  renderFolderTree();
  renderSelectionSummary();
  saveSettings();
  await rebuildRawRows();
}

async function clearSelection() {
  selectedFolderIds.clear();
  renderFolderTree();
  renderSelectionSummary();
  saveSettings();
  await rebuildRawRows();
}

async function refreshDataAndSave() {
  renderFolderTree();
  saveSettings();
  await rebuildRawRows();
}

function applyFiltersAndSave() {
  saveSettings();
  applyFilters();
}

async function rebuildRawRows() {
  rawRows = [];
  if (!selectedFolderIds.size) {
    applyFilters();
    return;
  }

  const seenBookmarkIds = new Set();
  const selectedFolders = folders.filter(f => selectedFolderIds.has(f.id));

  for (const folder of selectedFolders) {
    try {
      const nodes = await chrome.bookmarks.getSubTree(folder.id);
      const selected = nodes[0];
      collectBookmarks(
        selected.children || [],
        folder.path,
        els.recursiveToggle.checked,
        rawRows,
        seenBookmarkIds
      );
    } catch (err) {
      console.warn("Không đọc được folder", folder.id, err);
    }
  }

  applyFilters();
}

function collectBookmarks(nodes, currentPath, recursive, out, seenBookmarkIds) {
  for (const node of nodes) {
    if (node.url) {
      const id = String(node.id);
      if (seenBookmarkIds.has(id)) continue;
      seenBookmarkIds.add(id);
      out.push({
        bookmarkId: id,
        title: node.title || "(Không có title)",
        url: node.url,
        folder: currentPath[currentPath.length - 1] || "",
        folderPath: currentPath.join(" / "),
        dateAdded: node.dateAdded ? new Date(node.dateAdded) : null,
        domain: getDomain(node.url),
        originalIndex: out.length
      });
      continue;
    }
    if (recursive && node.children) {
      collectBookmarks(node.children, [...currentPath, node.title || "Untitled folder"], true, out, seenBookmarkIds);
    }
  }
}

function getDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname || u.protocol.replace(":", "");
  } catch {
    return "other";
  }
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function applyFilters() {
  const keyword = normalizeText(els.resultSearch.value.trim());
  const domainNeedle = normalizeText(els.domainFilter.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""));
  const httpOnly = els.httpOnlyToggle.checked;

  let rows = rawRows.filter(row => {
    if (httpOnly && !isHttpUrl(row.url)) return false;
    const hay = normalizeText(`${row.title} ${row.url} ${row.folderPath}`);
    if (keyword && !hay.includes(keyword)) return false;
    if (domainNeedle && !normalizeText(row.domain).includes(domainNeedle)) return false;
    return true;
  });

  const duplicateCount = rows.length - new Set(rows.map(r => normalizeUrl(r.url))).size;

  if (els.dedupeToggle.checked) {
    const seenUrls = new Set();
    rows = rows.filter(row => {
      const key = normalizeUrl(row.url);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
  }

  switch (els.sortSelect.value) {
    case "title": rows.sort((a,b) => a.title.localeCompare(b.title, "vi", {sensitivity:"base"})); break;
    case "folder": rows.sort((a,b) => a.folderPath.localeCompare(b.folderPath, "vi", {sensitivity:"base"}) || a.title.localeCompare(b.title, "vi")); break;
    case "dateDesc": rows.sort((a,b) => (b.dateAdded?.getTime() || 0) - (a.dateAdded?.getTime() || 0)); break;
    default: rows.sort((a,b) => a.originalIndex - b.originalIndex);
  }

  currentRows = rows;
  renderStats(duplicateCount);
  renderPreview();
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").trim();
  }
}

function renderStats(duplicateCount) {
  const selected = folders.filter(f => selectedFolderIds.has(f.id));
  const domains = new Set(currentRows.map(r => r.domain).filter(Boolean));
  els.linkStat.textContent = currentRows.length;
  els.folderStat.textContent = selected.length;
  els.domainStat.textContent = domains.size;
  els.duplicateStat.textContent = duplicateCount;

  const hasRows = currentRows.length > 0;
  els.exportExcelBtn.disabled = !hasRows;
  els.exportCsvBtn.disabled = !hasRows;
  els.copyUrlsBtn.disabled = !hasRows;
  els.exportHint.textContent = hasRows ? `${currentRows.length} dòng • ${domains.size} domain` : "Chưa có dữ liệu để xuất";
}

function renderPreview() {
  if (!selectedFolderIds.size || !currentRows.length) {
    els.previewList.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    const strong = els.emptyState.querySelector("strong");
    const span = els.emptyState.querySelector("span");
    if (!selectedFolderIds.size) {
      strong.textContent = "Chọn ít nhất một folder";
      span.textContent = "Bạn có thể chọn nhiều folder cùng lúc.";
    } else if (rawRows.length && !currentRows.length) {
      strong.textContent = "Không có kết quả phù hợp";
      span.textContent = "Thử reset bộ lọc hoặc tắt “Chỉ link web”.";
    } else {
      strong.textContent = "Folder chưa có bookmark";
      span.textContent = "Thử bật “Lấy cả folder con”.";
    }
    return;
  }

  els.emptyState.classList.add("hidden");
  els.previewList.classList.remove("hidden");
  els.previewList.innerHTML = "";

  const rows = currentRows.slice(0, 36);
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "preview-item";

    const mark = document.createElement("div");
    mark.className = "domain-mark";
    mark.textContent = domainInitial(row.domain);

    const copy = document.createElement("div");
    copy.className = "preview-copy";
    const title = document.createElement("div");
    title.className = "preview-title";
    title.textContent = row.title;
    title.title = row.title;
    const url = document.createElement("div");
    url.className = "preview-url";
    url.textContent = row.url;
    url.title = row.url;
    const path = document.createElement("div");
    path.className = "preview-path";
    path.textContent = row.folderPath;
    path.title = row.folderPath;
    copy.append(title, url, path);

    const date = document.createElement("div");
    date.className = "preview-date";
    date.textContent = row.dateAdded ? shortDate(row.dateAdded) : "—";

    item.append(mark, copy, date);
    frag.appendChild(item);
  }
  els.previewList.appendChild(frag);

  if (currentRows.length > rows.length) {
    const more = document.createElement("div");
    more.className = "preview-more";
    more.textContent = `+ ${currentRows.length - rows.length} link khác sẽ được xuất`;
    els.previewList.appendChild(more);
  }
}

function domainInitial(domain) {
  const d = (domain || "?").replace(/^www\./, "");
  const first = d.split(".")[0];
  return first.slice(0, 2) || "?";
}

function shortDate(date) {
  const p = n => String(n).padStart(2, "0");
  return `${p(date.getDate())}/${p(date.getMonth()+1)}`;
}

function resetFilters() {
  els.resultSearch.value = "";
  els.domainFilter.value = "";
  els.sortSelect.value = "original";
  els.dedupeToggle.checked = true;
  saveSettings();
  applyFilters();
  showToast("Đã reset bộ lọc");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  els.themeBtn.textContent = next === "light" ? "☾" : "☼";
  saveSettings();
}

function toggleTools() {
  const collapsed = !els.toolsBody.classList.contains("collapsed");
  els.toolsBody.classList.toggle("collapsed", collapsed);
  els.toolsChevron.textContent = collapsed ? "⌄" : "⌃";
  els.toolsToggle.setAttribute("aria-expanded", String(!collapsed));
}

async function copyUrls() {
  if (!currentRows.length) return;
  const text = currentRows.map(r => r.url).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Đã sao chép ${currentRows.length} URL`);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast(`Đã sao chép ${currentRows.length} URL`);
  }
}

function safeFileName(name) {
  return (name || "bookmarks").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "bookmarks";
}

function exportBaseName() {
  const selected = folders.filter(f => selectedFolderIds.has(f.id));
  if (selected.length === 1) return `${safeFileName(selected[0].title)}-bookmarks`;
  return `${selected.length || "all"}-folders-bookmarks`;
}

function formatDateForCell(date) {
  if (!date) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth()+1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getExportMatrix() {
  const headers = ["STT", "Folder", "Đường dẫn folder", "Title", "URL", "Domain", "Ngày thêm"];
  const rows = currentRows.map((row, index) => [
    index + 1, row.folder, row.folderPath, row.title, row.url, row.domain, formatDateForCell(row.dateAdded)
  ]);
  return [headers, ...rows];
}

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportCsv() {
  if (!currentRows.length) return;
  const matrix = getExportMatrix();
  const csv = "\uFEFF" + matrix.map(row => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  await downloadBlob(blob, `${exportBaseName()}.csv`);
  rememberExport("CSV");
  showToast(`Đã xuất CSV • ${currentRows.length} link`);
}

async function exportExcel() {
  if (!currentRows.length) return;
  try {
    const blob = buildXlsx(getExportMatrix(), "Bookmarks");
    await downloadBlob(blob, `${exportBaseName()}.xlsx`);
    rememberExport("Excel");
    showToast(`Đã xuất Excel • ${currentRows.length} link`);
  } catch (err) {
    console.error(err);
    showToast("Xuất Excel thất bại");
  }
}

function rememberExport(type) {
  localStorage.setItem("bfe_last_export", JSON.stringify({ type, count: currentRows.length, at: Date.now() }));
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2100);
}

/* ---------------------------
   Tiny dependency-free XLSX writer
   --------------------------- */

const textEncoder = new TextEncoder();

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colName(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function worksheetXml(matrix) {
  const rowsXml = matrix.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 ? ` s="1"` : "";
      if (typeof value === "number") {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }
      const text = xmlEscape(value);
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="8" customWidth="1"/>
    <col min="2" max="2" width="24" customWidth="1"/>
    <col min="3" max="3" width="42" customWidth="1"/>
    <col min="4" max="4" width="42" customWidth="1"/>
    <col min="5" max="5" width="72" customWidth="1"/>
    <col min="6" max="6" width="24" customWidth="1"/>
    <col min="7" max="7" width="22" customWidth="1"/>
  </cols>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${rowsXml}</sheetData>
  <autoFilter ref="A1:G${matrix.length}"/>
</worksheet>`;
}

function buildXlsx(matrix, sheetName) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: worksheetXml(matrix)
    }
  ];

  const zipBytes = createZip(files.map((f) => ({
    name: f.name,
    bytes: textEncoder.encode(f.data)
  })));

  return new Blob(
    [zipBytes],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  );
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}

function dosDateTime(date = new Date()) {
  let year = date.getFullYear();
  if (year < 1980) year = 1980;
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (date.getSeconds() >> 1);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: dosDate };
}

function concatChunks(chunks, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;
  let localLength = 0;
  let centralLength = 0;
  const dt = dosDateTime();

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const data = file.bytes;
    const crc = crc32(data);
    const utf8Flag = 0x0800;

    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(utf8Flag),
      ...u16(0),
      ...u16(dt.time),
      ...u16(dt.date),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0)
    ]);

    localChunks.push(localHeader, nameBytes, data);
    localLength += localHeader.length + nameBytes.length + data.length;

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(utf8Flag),
      ...u16(0),
      ...u16(dt.time),
      ...u16(dt.date),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset)
    ]);

    centralChunks.push(centralHeader, nameBytes);
    centralLength += centralHeader.length + nameBytes.length;
    localOffset += localHeader.length + nameBytes.length + data.length;
  }

  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(centralLength),
    ...u32(localLength),
    ...u16(0)
  ]);

  return concatChunks(
    [...localChunks, ...centralChunks, eocd],
    localLength + centralLength + eocd.length
  );
}
