// Browser app: upload -> translate -> poll progress -> bilingual reader.
// Talks to the /api/* contract in src/server/routes.ts. Framework-free.

interface JobState {
  id: string;
  status: "pending" | "running" | "done" | "error";
  provider: string;
  spineItemCount: number;
  chunks: { total: number; done: number };
  cost: { usd: number; ceilingUsd: number };
  error?: string;
}

interface ReaderItem {
  href: string;
  title: string;
  originalHtml: string;
  translatedHtml: string;
}

const POLL_MS = 1000;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const views = {
  upload: $("upload-view"),
  progress: $("progress-view"),
  reader: $("reader-view"),
  error: $("error-view"),
};

function show(view: keyof typeof views): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

function fail(message: string): void {
  $("error-text").textContent = message;
  show("error");
}

// ---- Step 1: file selection ----

const fileInput = $("file-input") as HTMLInputElement;
const dropzone = $("dropzone");
const startBtn = $("start-btn") as HTMLButtonElement;
let selectedFile: File | null = null;

function setFile(file: File | null): void {
  selectedFile = file;
  startBtn.disabled = !file;
  dropzone.classList.toggle("has-file", !!file);
  const title = dropzone.querySelector(".dropzone-title");
  if (title) title.textContent = file ? file.name : "Válassz egy EPUB könyvet";
}

fileInput.addEventListener("change", () => setFile(fileInput.files?.[0] ?? null));

["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  }),
);
dropzone.addEventListener("drop", (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) setFile(file);
});

// ---- Step 2: upload + translate + poll ----

startBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  try {
    show("progress");
    $("progress-detail").textContent = "Könyv feltöltése…";

    const form = new FormData();
    form.append("epub", selectedFile);
    const uploadRes = await fetch("/api/upload", { method: "POST", body: form });
    const uploadJson = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadJson.error ?? "Feltöltés sikertelen.");

    const jobId: string = uploadJson.id;
    $("progress-detail").textContent = "Fordítás indítása…";

    const transRes = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: jobId }),
    });
    if (!transRes.ok) {
      const j = await transRes.json();
      throw new Error(j.error ?? "A fordítás nem indult el.");
    }

    pollStatus(jobId);
  } catch (err) {
    fail((err as Error).message);
  }
});

async function pollStatus(jobId: string): Promise<void> {
  try {
    const res = await fetch(`/api/status?id=${encodeURIComponent(jobId)}`);
    const state: JobState = await res.json();
    if (!res.ok) throw new Error((state as unknown as { error: string }).error);

    renderProgress(state);

    if (state.status === "done") return loadReader(jobId);
    if (state.status === "error") return fail(state.error ?? "Ismeretlen hiba a fordítás közben.");

    setTimeout(() => pollStatus(jobId), POLL_MS);
  } catch (err) {
    fail((err as Error).message);
  }
}

function renderProgress(state: JobState): void {
  const { done, total } = state.chunks;
  const pct = total > 0 ? Math.round((done / total) * 100) : 4;
  $("progress-fill").style.width = `${pct}%`;
  $("progress-detail").textContent =
    total > 0 ? `Fejezetrészek fordítása… (${pct}%)` : "Könyv feldolgozása…";
  $("stat-chunks").textContent = `${done} / ${total}`;
  $("stat-cost").textContent = `$${state.cost.usd.toFixed(2)}`;
}

// ---- Step 3: bilingual reader ----

function blocksOf(html: string): Element[] {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r");
  return root ? Array.from(root.children) : [];
}

function renderItem(item: ReaderItem): HTMLElement {
  const section = document.createElement("section");
  section.className = "chapter";

  const transBlocks = blocksOf(item.translatedHtml);
  const origBlocks = blocksOf(item.originalHtml);

  transBlocks.forEach((tb, i) => {
    section.appendChild(tb); // translated block keeps inline markup (em, links, ...)
    const ob = origBlocks[i];
    const origText = ob?.textContent?.trim();
    if (origText) {
      const orig = document.createElement("span");
      orig.className = "orig";
      orig.textContent = origText;
      section.appendChild(orig);
    }
  });

  return section;
}

async function loadReader(jobId: string): Promise<void> {
  try {
    const res = await fetch(`/api/result?id=${encodeURIComponent(jobId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Az eredmény nem tölthető be.");

    const reader = $("reader");
    reader.replaceChildren(...(data.items as ReaderItem[]).map(renderItem));

    const dl = $("download-link") as HTMLAnchorElement;
    dl.href = `/api/result?id=${encodeURIComponent(jobId)}&download=1`;

    show("reader");
  } catch (err) {
    fail((err as Error).message);
  }
}

// Bilingual toggle.
const toggleBtn = $("toggle-original") as HTMLButtonElement;
toggleBtn.addEventListener("click", () => {
  const reader = $("reader");
  const showing = reader.classList.toggle("hide-original") === false;
  toggleBtn.setAttribute("aria-pressed", String(showing));
  toggleBtn.textContent = showing ? "Eredeti elrejtése" : "Eredeti megjelenítése";
});

// Retry.
$("retry-btn").addEventListener("click", () => {
  setFile(null);
  fileInput.value = "";
  show("upload");
});

// Provider note (best-effort; reflects whatever a fresh upload would use).
fetch("/api/status?id=__none__")
  .catch(() => undefined)
  .finally(() => {
    $("provider-note").textContent = "Helyi eszköz · localhost / saját hálózat";
  });
