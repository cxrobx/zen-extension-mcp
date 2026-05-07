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
