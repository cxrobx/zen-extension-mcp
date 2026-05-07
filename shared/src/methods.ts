export const Methods = {
  ContainersList: "containers.list",
  ContainersSetDefault: "containers.setDefault",
  PagesList: "pages.list",
  PagesNew: "pages.new",
  PagesNewInContainer: "pages.newInContainer",
  PagesNavigate: "pages.navigate",
  PagesSelect: "pages.select",
  PagesClose: "pages.close",
  PagesNavigateHistory: "pages.navigateHistory",
  PagesScreenshot: "pages.screenshot",
  PagesSetViewportSize: "pages.setViewportSize",
  DomTakeSnapshot: "dom.takeSnapshot",
  DomClearSnapshot: "dom.clearSnapshot",
  DomClick: "dom.click",
  DomHover: "dom.hover",
  DomFill: "dom.fill",
  DomFillForm: "dom.fillForm",
  DomDrag: "dom.drag",
  DomResolveUidToSelector: "dom.resolveUidToSelector",
  DomEvaluate: "dom.evaluate",
  InfoGet: "info.get",
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];

export interface FirefoxContainer {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

export interface ContainersListResult {
  containers: FirefoxContainer[];
}

export interface PageInfo {
  tabId: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  cookieStoreId: string;
  containerName: string | null;
}

export interface PagesListResult {
  pages: PageInfo[];
}

export interface NewPageParams {
  url: string;
  cookieStoreId?: string;
}

export interface NewPageResult {
  tabId: number;
  windowId: number;
  url: string;
  cookieStoreId: string;
  containerName: string | null;
}

export interface NavigatePageParams {
  tabId: number;
  url: string;
}

export interface SelectPageParams {
  tabId: number;
}

export interface ClosePageParams {
  tabId: number;
}

export type NavigateHistoryDirection = "back" | "forward";

export interface NavigateHistoryParams {
  tabId: number;
  direction: NavigateHistoryDirection;
}

export interface TabIdResult {
  tabId: number;
}

export interface SnapshotUidEntry {
  uid: string;
  css: string;
  xpath?: string;
}

export interface SnapshotNode {
  uid: string;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  href?: string;
  src?: string;
  text?: string;
  isIframe?: boolean;
  frameSrc?: string;
  crossOrigin?: boolean;
  aria?: Record<string, unknown>;
  computed?: Record<string, unknown>;
  children: SnapshotNode[];
}

export interface TakeSnapshotParams {
  tabId: number;
  selector?: string;
  includeAll?: boolean;
  includeIframes?: boolean;
}

export interface TakeSnapshotResult {
  tabId: number;
  snapshotId: number;
  tree: SnapshotNode | null;
  uidMap: SnapshotUidEntry[];
  truncated: boolean;
  selectorError?: string;
}

export interface ClearSnapshotParams {
  tabId: number;
}

export interface UidActionParams {
  tabId: number;
  uid: string;
}

export interface FillParams extends UidActionParams {
  value: string;
}

export interface FillFormParams {
  tabId: number;
  fields: Array<{ uid: string; value: string }>;
}

export interface DragParams {
  tabId: number;
  fromUid: string;
  toUid: string;
}

export interface ResolveUidResult {
  uid: string;
  css: string;
  xpath?: string;
}

export interface EvaluateScriptParams {
  tabId: number;
  code: string;
}

export interface EvaluateScriptResult {
  result: unknown;
}

export interface ScreenshotPageParams {
  tabId: number;
}

export interface ScreenshotPageResult {
  tabId: number;
  dataUrl: string;
}
