import {
  type ClearSnapshotParams,
  type ClosePageParams,
  type DragParams,
  type EvaluateScriptParams,
  type EvaluateScriptResult,
  type FillFormParams,
  type FillParams,
  type FirefoxContainer,
  Methods,
  type NavigateHistoryParams,
  type NavigatePageParams,
  type NewPageParams,
  type NewPageResult,
  type PageInfo,
  type ResolveUidResult,
  type ScreenshotPageParams,
  type ScreenshotPageResult,
  type SelectPageParams,
  type SnapshotUidEntry,
  type TabIdResult,
  type TakeSnapshotParams,
  type TakeSnapshotResult,
  type UidActionParams,
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

const snapshotCache = new Map<number, Map<string, SnapshotUidEntry>>();
let nextSnapshotId = 1;

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) snapshotCache.delete(details.tabId);
});
browser.tabs.onRemoved.addListener((tabId) => snapshotCache.delete(tabId));

async function ensureSnapshotInjected(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId },
    files: ["snapshot/inject.js"],
    world: "MAIN" as browser.scripting.ExecutionWorld,
  });
}

async function executeInMain<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[],
): Promise<T> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: "MAIN" as browser.scripting.ExecutionWorld,
  });
  const first = results[0];
  if (!first) throw new Error("no executeScript result");
  if (first.error) throw new Error(String(first.error));
  return first.result as T;
}

function lookupSelector(tabId: number, uid: string): string {
  const map = snapshotCache.get(tabId);
  if (!map) throw new Error(`no snapshot for tabId=${tabId}; call take_snapshot first`);
  const entry = map.get(uid);
  if (!entry) throw new Error(`uid "${uid}" not found in snapshot for tabId=${tabId}`);
  return entry.css;
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

  [Methods.PagesScreenshot]: async (raw): Promise<ScreenshotPageResult> => {
    const params = raw as ScreenshotPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) {
      await browser.tabs.update(tabId, { active: true });
      if (tab.windowId !== undefined) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
    }
    const dataUrl = await browser.tabs.captureVisibleTab({ format: "png" });
    return { tabId, dataUrl };
  },

  [Methods.DomTakeSnapshot]: async (raw): Promise<TakeSnapshotResult> => {
    const params = raw as TakeSnapshotParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    await ensureSnapshotInjected(tabId);
    const snapshotId = nextSnapshotId++;
    const result = await executeInMain<{
      tree: TakeSnapshotResult["tree"];
      uidMap: SnapshotUidEntry[];
      truncated: boolean;
      selectorError?: string;
    }>(
      tabId,
      (id, opts) => {
        const fn = (window as unknown as {
          __zenExtMcpCreateSnapshot?: (i: number, o: unknown) => unknown;
        }).__zenExtMcpCreateSnapshot;
        if (!fn) throw new Error("snapshot fn not present");
        return fn(id as number, opts) as never;
      },
      [snapshotId, { selector: params.selector, includeAll: params.includeAll, includeIframes: params.includeIframes }],
    );

    const uidMapByUid = new Map<string, SnapshotUidEntry>();
    for (const entry of result.uidMap) uidMapByUid.set(entry.uid, entry);
    snapshotCache.set(tabId, uidMapByUid);

    return {
      tabId,
      snapshotId,
      tree: result.tree,
      uidMap: result.uidMap,
      truncated: result.truncated,
      ...(result.selectorError ? { selectorError: result.selectorError } : {}),
    };
  },

  [Methods.DomClearSnapshot]: async (raw): Promise<TabIdResult> => {
    const params = raw as ClearSnapshotParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    snapshotCache.delete(tabId);
    return { tabId };
  },

  [Methods.DomResolveUidToSelector]: async (raw): Promise<ResolveUidResult> => {
    const params = raw as UidActionParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    const map = snapshotCache.get(tabId);
    if (!map) throw new Error(`no snapshot for tabId=${tabId}`);
    const entry = map.get(uid);
    if (!entry) throw new Error(`uid "${uid}" not in snapshot`);
    return entry;
  },

  [Methods.DomClick]: async (raw): Promise<TabIdResult> => {
    const params = raw as UidActionParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    const selector = lookupSelector(tabId, uid);
    await executeInMain(
      tabId,
      (sel) => {
        const el = document.querySelector(sel as string) as HTMLElement | null;
        if (!el) throw new Error(`element not found: ${sel}`);
        el.click();
      },
      [selector],
    );
    return { tabId };
  },

  [Methods.DomHover]: async (raw): Promise<TabIdResult> => {
    const params = raw as UidActionParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    const selector = lookupSelector(tabId, uid);
    await executeInMain(
      tabId,
      (sel) => {
        const el = document.querySelector(sel as string) as HTMLElement | null;
        if (!el) throw new Error(`element not found: ${sel}`);
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      },
      [selector],
    );
    return { tabId };
  },

  [Methods.DomFill]: async (raw): Promise<TabIdResult> => {
    const params = raw as FillParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    if (typeof params.value !== "string") throw new Error("value must be a string");
    const selector = lookupSelector(tabId, uid);
    await executeInMain(
      tabId,
      (sel, val) => {
        const el = document.querySelector(sel as string) as HTMLElement | null;
        if (!el) throw new Error(`element not found: ${sel}`);
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        if ("value" in input) {
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc?.set) desc.set.call(input, val);
          else input.value = val as string;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } else if ((el as HTMLElement).isContentEditable) {
          el.textContent = val as string;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          throw new Error("element is not fillable");
        }
      },
      [selector, params.value],
    );
    return { tabId };
  },

  [Methods.DomFillForm]: async (raw): Promise<TabIdResult> => {
    const params = raw as FillFormParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (!Array.isArray(params.fields)) throw new Error("fields must be an array");
    const selectors = params.fields.map((f) => ({
      selector: lookupSelector(tabId, f.uid),
      value: f.value,
    }));
    await executeInMain(
      tabId,
      (entries) => {
        const list = entries as Array<{ selector: string; value: string }>;
        for (const { selector, value } of list) {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (!el) throw new Error(`element not found: ${selector}`);
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          if ("value" in input) {
            const proto = Object.getPrototypeOf(input);
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            if (desc?.set) desc.set.call(input, value);
            else input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          } else if ((el as HTMLElement).isContentEditable) {
            el.textContent = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            throw new Error(`element not fillable: ${selector}`);
          }
        }
      },
      [selectors],
    );
    return { tabId };
  },

  [Methods.DomDrag]: async (raw): Promise<TabIdResult> => {
    const params = raw as DragParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const fromUid = requireString(params?.fromUid, "fromUid");
    const toUid = requireString(params?.toUid, "toUid");
    const fromSel = lookupSelector(tabId, fromUid);
    const toSel = lookupSelector(tabId, toUid);
    await executeInMain(
      tabId,
      (a, b) => {
        const from = document.querySelector(a as string) as HTMLElement | null;
        const to = document.querySelector(b as string) as HTMLElement | null;
        if (!from || !to) throw new Error("element not found for drag");
        const dt = new DataTransfer();
        from.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
        to.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
        to.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
        to.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
        from.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      },
      [fromSel, toSel],
    );
    return { tabId };
  },

  [Methods.DomEvaluate]: async (raw): Promise<EvaluateScriptResult> => {
    const params = raw as EvaluateScriptParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const code = requireString(params?.code, "code");
    const result = await executeInMain<unknown>(
      tabId,
      (src) => new Function(src as string)(),
      [code],
    );
    return { result };
  },
};
