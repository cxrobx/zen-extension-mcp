import {
  type ClearCookiesParams,
  type ClearCookiesResult,
  type ClearSnapshotParams,
  type ClosePageParams,
  type CookieEntry,
  type DragByLocatorParams,
  type DragParams,
  type EvaluateScriptParams,
  type EvaluateScriptResult,
  type FillByLocatorParams,
  type FillFormParams,
  type FillParams,
  type FirefoxContainer,
  type GetCookiesParams,
  type GetCookiesResult,
  type GetPageTextParams,
  type GetPageTextResult,
  type InfoGetResult,
  type LocatorParams,
  type LocatorSpec,
  Methods,
  type NavigateHistoryParams,
  type NavigatePageParams,
  type NewPageParams,
  type NewPageResult,
  type PageInfo,
  type PressKeyParams,
  PROTOCOL_VERSION,
  type ReadPageParams,
  type ReadPageResult,
  type ResolveUidResult,
  type ScreenshotPageParams,
  type ScreenshotPageResult,
  type SelectOptionByLocatorParams,
  type SelectOptionResult,
  type SelectPageParams,
  type SetCookiesParams,
  type SetCookiesResult,
  type SnapshotUidEntry,
  type StorageClearParams,
  type StorageClearResult,
  type StorageGetParams,
  type StorageGetResult,
  type StorageSetParams,
  type StorageSetResult,
  type TabIdResult,
  type TakeSnapshotParams,
  type TakeSnapshotResult,
  type TypeByLocatorParams,
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

function requireLocatorParams(raw: unknown): { tabId: number; locator: LocatorSpec } {
  const p = raw as LocatorParams;
  const tabId = requireNumber(p?.tabId, "tabId");
  const locator = p?.locator;
  if (!locator || (locator.kind !== "css" && locator.kind !== "xpath")) {
    throw new Error('locator must be {kind:"css",selector} or {kind:"xpath",expression}');
  }
  return { tabId, locator };
}

async function runOnLocator(
  tabId: number,
  locator: LocatorSpec,
  fn: (...args: unknown[]) => unknown,
  extraArgs: unknown[] = [],
): Promise<void> {
  await executeInMain(
    tabId,
    (loc, body, args) => {
      const findEl = (l: LocatorSpec): Element | null => {
        if (l.kind === "css") return document.querySelector(l.selector);
        const r = document.evaluate(
          l.expression,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        return r.singleNodeValue as Element | null;
      };
      const el = findEl(loc as LocatorSpec);
      if (!el) {
        const ls = loc as LocatorSpec;
        throw new Error(
          `element not found: ${ls.kind === "css" ? ls.selector : ls.expression}`,
        );
      }
      const f = body as (...a: unknown[]) => unknown;
      return f(el, ...(args as unknown[]));
    },
    [locator, fn, extraArgs],
  );
}

function toCookieEntry(c: browser.cookies.Cookie): CookieEntry {
  const entry: CookieEntry = { name: c.name, value: c.value };
  if (c.domain) entry.domain = c.domain;
  if (c.path) entry.path = c.path;
  if (typeof c.expirationDate === "number") entry.expirationDate = c.expirationDate;
  if (typeof c.httpOnly === "boolean") entry.httpOnly = c.httpOnly;
  if (typeof c.secure === "boolean") entry.secure = c.secure;
  if (c.sameSite) entry.sameSite = c.sameSite as CookieEntry["sameSite"];
  if (c.storeId) entry.storeId = c.storeId;
  return entry;
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

  [Methods.DomGetPageText]: async (raw): Promise<GetPageTextResult> => {
    const params = raw as GetPageTextParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const selector = params.selector;
    const text = await executeInMain<string>(
      tabId,
      (sel) => {
        const target =
          typeof sel === "string" && sel.length > 0
            ? document.querySelector(sel as string)
            : document.body;
        if (!target) throw new Error("element not found");
        const node = target as HTMLElement;
        const visible = node.innerText;
        return typeof visible === "string" ? visible : node.textContent ?? "";
      },
      [selector ?? null],
    );
    return { text };
  },

  [Methods.DomReadPage]: async (raw): Promise<ReadPageResult> => {
    const params = raw as ReadPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["readability/inject.js"],
      world: "MAIN" as browser.scripting.ExecutionWorld,
    });
    const result = await executeInMain<ReadPageResult>(
      tabId,
      () => {
        const fn = (window as unknown as { __zenReadability?: () => ReadPageResult })
          .__zenReadability;
        if (!fn) return { ok: false, reason: "bundle_unavailable" };
        return fn();
      },
      [],
    );
    return result;
  },

  [Methods.DomClickByLocator]: async (raw): Promise<TabIdResult> => {
    const { tabId, locator } = requireLocatorParams(raw);
    await runOnLocator(tabId, locator, (el) => {
      (el as HTMLElement).click();
    });
    return { tabId };
  },

  [Methods.DomHoverByLocator]: async (raw): Promise<TabIdResult> => {
    const { tabId, locator } = requireLocatorParams(raw);
    await runOnLocator(tabId, locator, (el) => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    return { tabId };
  },

  [Methods.DomFillByLocator]: async (raw): Promise<TabIdResult> => {
    const params = raw as FillByLocatorParams;
    const { tabId, locator } = requireLocatorParams(params);
    if (typeof params.value !== "string") throw new Error("value must be a string");
    const value = params.value;
    await runOnLocator(tabId, locator, (el, val) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      if ("value" in input) {
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) desc.set.call(input, val as string);
        else input.value = val as string;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else if ((el as HTMLElement).isContentEditable) {
        el.textContent = val as string;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        throw new Error("element is not fillable");
      }
    }, [value]);
    return { tabId };
  },

  [Methods.DomTypeByLocator]: async (raw): Promise<TabIdResult> => {
    const params = raw as TypeByLocatorParams;
    const { tabId, locator } = requireLocatorParams(params);
    if (typeof params.text !== "string") throw new Error("text must be a string");
    const text = params.text;
    const delayMs = typeof params.delayMs === "number" ? params.delayMs : 0;
    const clearFirst = params.clearFirst === true;
    await runOnLocator(
      tabId,
      locator,
      async (el, t, delay, clear) => {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        if (clear === true && "value" in input) {
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc?.set) desc.set.call(input, "");
          else input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const focusable = el as HTMLElement;
        if (typeof focusable.focus === "function") focusable.focus();
        const str = t as string;
        const d = typeof delay === "number" ? delay : 0;
        for (const ch of str) {
          const key = ch;
          el.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          );
          el.dispatchEvent(
            new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }),
          );
          if ("value" in input) {
            const proto = Object.getPrototypeOf(input);
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            const current =
              typeof input.value === "string" ? (input.value as string) : "";
            if (desc?.set) desc.set.call(input, current + ch);
            else input.value = current + ch;
            input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
          } else if (focusable.isContentEditable) {
            focusable.textContent = (focusable.textContent ?? "") + ch;
            focusable.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
          }
          el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
          if (d > 0) await new Promise((r) => setTimeout(r, d));
        }
        if ("value" in input) {
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      [text, delayMs, clearFirst],
    );
    return { tabId };
  },

  [Methods.DomDragByLocator]: async (raw): Promise<TabIdResult> => {
    const params = raw as DragByLocatorParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (!params.from || !params.to) throw new Error("from and to are required");
    const from = params.from;
    const to = params.to;
    await executeInMain(
      tabId,
      (f, t) => {
        const findEl = (loc: LocatorSpec): Element | null => {
          if (loc.kind === "css") return document.querySelector(loc.selector);
          const r = document.evaluate(
            loc.expression,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          );
          return r.singleNodeValue as Element | null;
        };
        const src = findEl(f as LocatorSpec);
        const tgt = findEl(t as LocatorSpec);
        if (!src || !tgt) throw new Error("element not found for drag");
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
        tgt.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
        tgt.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
        tgt.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
        src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      },
      [from, to],
    );
    return { tabId };
  },

  [Methods.DomSelectOptionByLocator]: async (raw): Promise<SelectOptionResult> => {
    const params = raw as SelectOptionByLocatorParams;
    const { tabId, locator } = requireLocatorParams(params);
    if (typeof params.value !== "string") throw new Error("value is required");
    if (params.by !== "value" && params.by !== "label" && params.by !== "index") {
      throw new Error('by must be "value", "label", or "index"');
    }
    const by = params.by;
    const value = params.value;
    const result = await executeInMain<SelectOptionResult>(
      tabId,
      (loc, b, v) => {
        const findEl = (l: LocatorSpec): Element | null => {
          if (l.kind === "css") return document.querySelector(l.selector);
          const r = document.evaluate(
            l.expression,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          );
          return r.singleNodeValue as Element | null;
        };
        const el = findEl(loc as LocatorSpec);
        if (!el) return { ok: false, reason: "not_found" };
        if ((el as HTMLElement).tagName !== "SELECT") {
          return { ok: false, reason: "not_select", tag: (el as HTMLElement).tagName };
        }
        const sel = el as HTMLSelectElement;
        let match: HTMLOptionElement | null = null;
        for (let i = 0; i < sel.options.length; i++) {
          const opt = sel.options[i] as HTMLOptionElement;
          if (b === "value" && opt.value === v) {
            match = opt;
            break;
          }
          if (b === "label" && opt.text === v) {
            match = opt;
            break;
          }
          if (b === "index" && i === parseInt(v as string, 10)) {
            match = opt;
            break;
          }
        }
        if (!match) return { ok: false, reason: "no_match" };
        sel.value = match.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, value: match.value, label: match.text };
      },
      [locator, by, value],
    );
    return result;
  },

  [Methods.DomPressKey]: async (raw): Promise<TabIdResult> => {
    const params = raw as PressKeyParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (!params.keys || typeof params.keys !== "string") throw new Error("keys is required");
    const keys = params.keys;
    const target = params.target ?? { kind: "active" };
    await executeInMain(
      tabId,
      (k, tgt) => {
        const findEl = (loc: LocatorSpec): Element | null => {
          if (loc.kind === "css") return document.querySelector(loc.selector);
          const r = document.evaluate(
            loc.expression,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          );
          return r.singleNodeValue as Element | null;
        };
        const t = tgt as PressKeyParams["target"];
        const el: Element =
          t.kind === "locator"
            ? findEl(t.locator) ?? document.activeElement ?? document.body
            : document.activeElement ?? document.body;
        const spec = k as string;
        const parts = spec.split("+").map((p) => p.trim());
        const SPECIAL: Record<string, string> = {
          enter: "Enter",
          return: "Enter",
          escape: "Escape",
          esc: "Escape",
          tab: "Tab",
          backspace: "Backspace",
          delete: "Delete",
          insert: "Insert",
          space: " ",
          arrowup: "ArrowUp",
          up: "ArrowUp",
          arrowdown: "ArrowDown",
          down: "ArrowDown",
          arrowleft: "ArrowLeft",
          left: "ArrowLeft",
          arrowright: "ArrowRight",
          right: "ArrowRight",
          home: "Home",
          end: "End",
          pageup: "PageUp",
          pagedown: "PageDown",
        };
        const MOD = new Set(["cmd", "meta", "ctrl", "control", "alt", "option", "shift"]);
        const init: KeyboardEventInit = { bubbles: true, cancelable: true };
        let mainPart = parts[parts.length - 1] as string;
        for (const m of parts.slice(0, -1)) {
          const lower = m.toLowerCase();
          if (!MOD.has(lower)) throw new Error(`unknown modifier: ${m}`);
          if (lower === "cmd" || lower === "meta") init.metaKey = true;
          if (lower === "ctrl" || lower === "control") init.ctrlKey = true;
          if (lower === "alt" || lower === "option") init.altKey = true;
          if (lower === "shift") init.shiftKey = true;
        }
        const lowerMain = mainPart.toLowerCase();
        const key = SPECIAL[lowerMain] ?? mainPart;
        init.key = key;
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        el.dispatchEvent(new KeyboardEvent("keypress", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
      },
      [keys, target],
    );
    return { tabId };
  },

  [Methods.CookiesGet]: async (raw): Promise<GetCookiesResult> => {
    const params = (raw as GetCookiesParams) ?? {};
    const details: browser.cookies._GetAllDetailsType = {};
    if (params.url) details.url = params.url;
    if (params.name) details.name = params.name;
    if (params.domain) details.domain = params.domain;
    if (params.storeId) details.storeId = params.storeId;
    const list = await browser.cookies.getAll(details);
    return { cookies: list.map(toCookieEntry) };
  },

  [Methods.CookiesSet]: async (raw): Promise<SetCookiesResult> => {
    const params = (raw as SetCookiesParams) ?? { cookies: [] };
    if (!Array.isArray(params.cookies) || params.cookies.length === 0) {
      throw new Error("cookies must be a non-empty array");
    }
    let set = 0;
    for (const c of params.cookies) {
      if (!c.url || !c.name || typeof c.value !== "string") {
        throw new Error("each cookie requires url, name, value");
      }
      const opts: browser.cookies._SetDetailsType = {
        url: c.url,
        name: c.name,
        value: c.value,
      };
      if (c.domain) opts.domain = c.domain;
      if (c.path) opts.path = c.path;
      if (typeof c.expirationDate === "number") opts.expirationDate = c.expirationDate;
      if (typeof c.httpOnly === "boolean") opts.httpOnly = c.httpOnly;
      if (typeof c.secure === "boolean") opts.secure = c.secure;
      if (c.sameSite) opts.sameSite = c.sameSite as browser.cookies.SameSiteStatus;
      if (c.storeId) opts.storeId = c.storeId;
      await browser.cookies.set(opts);
      set += 1;
    }
    return { set };
  },

  [Methods.CookiesClear]: async (raw): Promise<ClearCookiesResult> => {
    const params = (raw as ClearCookiesParams) ?? {};
    const details: browser.cookies._GetAllDetailsType = {};
    if (params.url) details.url = params.url;
    if (params.name) details.name = params.name;
    if (params.domain) details.domain = params.domain;
    if (params.storeId) details.storeId = params.storeId;
    const list = await browser.cookies.getAll(details);
    let deleted = 0;
    for (const c of list) {
      const removeOpts: browser.cookies._RemoveDetailsType = {
        url: details.url ?? `http${c.secure ? "s" : ""}://${c.domain}${c.path}`,
        name: c.name,
      };
      if (c.storeId) removeOpts.storeId = c.storeId;
      await browser.cookies.remove(removeOpts);
      deleted += 1;
    }
    return { deleted };
  },

  [Methods.StorageGet]: async (raw): Promise<StorageGetResult> => {
    const params = raw as StorageGetParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.kind !== "local" && params.kind !== "session") {
      throw new Error('kind must be "local" or "session"');
    }
    const kind = params.kind;
    const keys = Array.isArray(params.keys) ? params.keys : null;
    const items = await executeInMain<Record<string, string | null>>(
      tabId,
      (k, requestedKeys) => {
        const store: Storage =
          (k as string) === "session" ? window.sessionStorage : window.localStorage;
        const out: Record<string, string | null> = {};
        const list = requestedKeys as string[] | null;
        if (list && Array.isArray(list)) {
          for (const key of list) out[key] = store.getItem(key);
        } else {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key !== null) out[key] = store.getItem(key);
          }
        }
        return out;
      },
      [kind, keys],
    );
    return { items };
  },

  [Methods.StorageSet]: async (raw): Promise<StorageSetResult> => {
    const params = raw as StorageSetParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.kind !== "local" && params.kind !== "session") {
      throw new Error('kind must be "local" or "session"');
    }
    if (!params.items || typeof params.items !== "object") {
      throw new Error("items must be a string-valued object");
    }
    const kind = params.kind;
    const items = params.items;
    const written = await executeInMain<number>(
      tabId,
      (k, m) => {
        const store: Storage =
          (k as string) === "session" ? window.sessionStorage : window.localStorage;
        const obj = m as Record<string, string>;
        let count = 0;
        for (const key of Object.keys(obj)) {
          store.setItem(key, String(obj[key]));
          count += 1;
        }
        return count;
      },
      [kind, items],
    );
    return { written };
  },

  [Methods.StorageClear]: async (raw): Promise<StorageClearResult> => {
    const params = raw as StorageClearParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.kind !== "local" && params.kind !== "session") {
      throw new Error('kind must be "local" or "session"');
    }
    const kind = params.kind;
    const keys = params.keys;
    if (keys !== undefined) {
      if (!Array.isArray(keys)) throw new Error("keys must be an array");
      if (keys.length === 0) return { removed: 0, cleared: false };
      const removed = await executeInMain<number>(
        tabId,
        (k, list) => {
          const store: Storage =
            (k as string) === "session" ? window.sessionStorage : window.localStorage;
          const items = list as string[];
          for (const key of items) store.removeItem(key);
          return items.length;
        },
        [kind, keys],
      );
      return { removed, cleared: false };
    }
    await executeInMain<void>(
      tabId,
      (k) => {
        const store: Storage =
          (k as string) === "session" ? window.sessionStorage : window.localStorage;
        store.clear();
      },
      [kind],
    );
    return { removed: 0, cleared: true };
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

  [Methods.InfoGet]: async (): Promise<InfoGetResult> => {
    const manifest = browser.runtime.getManifest();
    const [tabs, windows, identities, platform] = await Promise.all([
      browser.tabs.query({}),
      browser.windows.getAll({}),
      browser.contextualIdentities.query({}),
      browser.runtime.getPlatformInfo(),
    ]);
    return {
      extensionId: browser.runtime.id ?? "",
      extensionVersion: manifest.version ?? "",
      userAgent: navigator.userAgent,
      platform: `${platform.os}/${platform.arch}`,
      windowCount: windows.length,
      tabCount: tabs.length,
      containerCount: identities.length,
      protocolVersion: PROTOCOL_VERSION,
    };
  },
};
