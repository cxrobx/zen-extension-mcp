import { DaemonConnection } from "./connection.js";
import { loadSettings, onSettingsChanged } from "./settings.js";

const KEEPALIVE_ALARM = "zen-ext-keepalive";

const connection = new DaemonConnection({ url: "", token: "" });

connection.onState((state) => {
  console.log("[zen-ext-mcp] state", state);
});

void (async () => {
  const settings = await loadSettings();
  connection.setConfig({ url: settings.daemonUrl, token: settings.token });
  connection.start();
})();

onSettingsChanged((updated) => {
  connection.setConfig({ url: updated.daemonUrl, token: updated.token });
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.kind === "get-state") {
    return Promise.resolve(connection.getState());
  }
  return undefined;
});

browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!connection.isHealthy()) {
    connection.forceReconnect();
  }
});
