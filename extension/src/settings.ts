export interface Settings {
  daemonUrl: string;
  token: string;
}

const DEFAULTS: Settings = {
  daemonUrl: "ws://127.0.0.1:8765",
  token: "",
};

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(DEFAULTS);
  return {
    daemonUrl: typeof stored.daemonUrl === "string" ? stored.daemonUrl : DEFAULTS.daemonUrl,
    token: typeof stored.token === "string" ? stored.token : DEFAULTS.token,
  };
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  await browser.storage.local.set(settings);
}

export function onSettingsChanged(listener: (settings: Settings) => void): void {
  browser.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== "local") return;
    listener(await loadSettings());
  });
}
