import {
  type ClosePageParams,
  type FirefoxContainer,
  Methods,
  type NavigateHistoryParams,
  type NavigatePageParams,
  type NewPageParams,
  type NewPageResult,
  type PageInfo,
  type SelectPageParams,
  type TabIdResult,
} from "@zen-ext-mcp/shared";

export type Handler = (params: unknown) => Promise<unknown>;

async function buildContainerLookup(): Promise<Map<string, string>> {
  const identities = await browser.contextualIdentities.query({});
  const map = new Map<string, string>();
  for (const id of identities) {
    map.set(id.cookieStoreId, id.name);
  }
  return map;
}

function tabToPageInfo(tab: browser.tabs.Tab, names: Map<string, string>): PageInfo {
  const cookieStoreId = tab.cookieStoreId ?? "firefox-default";
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: !!tab.active,
    cookieStoreId,
    containerName: names.get(cookieStoreId) ?? null,
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

export const handlers: Record<string, Handler> = {
  [Methods.ContainersList]: async () => {
    const identities = await browser.contextualIdentities.query({});
    const containers: FirefoxContainer[] = identities.map((id) => ({
      cookieStoreId: id.cookieStoreId,
      name: id.name,
      color: id.color,
      icon: id.icon,
    }));
    return { containers };
  },

  [Methods.PagesList]: async () => {
    const [tabs, names] = await Promise.all([
      browser.tabs.query({}),
      buildContainerLookup(),
    ]);
    const pages = tabs.map((t) => tabToPageInfo(t, names));
    return { pages };
  },

  [Methods.PagesNew]: async (raw): Promise<NewPageResult> => {
    const params = raw as NewPageParams;
    const url = requireString(params?.url, "url");
    const createOpts: browser.tabs._CreateCreateProperties = { url, active: true };
    if (params.cookieStoreId) createOpts.cookieStoreId = params.cookieStoreId;
    const tab = await browser.tabs.create(createOpts);
    const names = await buildContainerLookup();
    const cookieStoreId = tab.cookieStoreId ?? params.cookieStoreId ?? "firefox-default";
    return {
      tabId: tab.id ?? -1,
      windowId: tab.windowId ?? -1,
      url: tab.url ?? url,
      cookieStoreId,
      containerName: names.get(cookieStoreId) ?? null,
    };
  },

  [Methods.PagesNavigate]: async (raw): Promise<TabIdResult> => {
    const params = raw as NavigatePageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const url = requireString(params?.url, "url");
    await browser.tabs.update(tabId, { url });
    return { tabId };
  },

  [Methods.PagesSelect]: async (raw): Promise<TabIdResult> => {
    const params = raw as SelectPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const tab = await browser.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    return { tabId };
  },

  [Methods.PagesClose]: async (raw): Promise<TabIdResult> => {
    const params = raw as ClosePageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    await browser.tabs.remove(tabId);
    return { tabId };
  },

  [Methods.PagesNavigateHistory]: async (raw): Promise<TabIdResult> => {
    const params = raw as NavigateHistoryParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.direction !== "back" && params.direction !== "forward") {
      throw new Error('direction must be "back" or "forward"');
    }
    if (params.direction === "back") {
      await browser.tabs.goBack(tabId);
    } else {
      await browser.tabs.goForward(tabId);
    }
    return { tabId };
  },
};
