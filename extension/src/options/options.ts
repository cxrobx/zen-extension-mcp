import { loadSettings, saveSettings } from "../settings.js";

const daemonUrlInput = document.getElementById("daemonUrl") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLTextAreaElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

async function refreshStatus(): Promise<void> {
  try {
    const state = await browser.runtime.sendMessage({ kind: "get-state" });
    renderStatus(state);
  } catch {
    statusEl.textContent = "background unreachable";
    statusEl.className = "status warn";
  }
}

function renderStatus(state: unknown): void {
  if (!state || typeof state !== "object" || !("status" in state)) {
    statusEl.textContent = "unknown";
    statusEl.className = "status";
    return;
  }
  const status = (state as { status: string }).status;
  statusEl.textContent = status;
  statusEl.className = "status";
  if (status === "authenticated") statusEl.classList.add("ok");
  if (status === "error") statusEl.classList.add("warn");
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  daemonUrlInput.value = settings.daemonUrl;
  tokenInput.value = settings.token;
  await refreshStatus();
  setInterval(refreshStatus, 1500);
}

saveButton.addEventListener("click", async () => {
  await saveSettings({
    daemonUrl: daemonUrlInput.value.trim(),
    token: tokenInput.value.trim(),
  });
  await refreshStatus();
});

void init();
