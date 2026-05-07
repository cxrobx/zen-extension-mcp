export interface UidEntry {
  uid: string;
  css: string;
  xpath?: string;
}

export interface AriaAttributes {
  disabled?: boolean;
  hidden?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  autocomplete?: string;
  haspopup?: boolean | string;
  invalid?: boolean | string;
  label?: string;
  labelledby?: string;
  describedby?: string;
  controls?: string;
  level?: number;
}

export interface ComputedProperties {
  focusable?: boolean;
  interactive?: boolean;
  visible?: boolean;
  accessible?: boolean;
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
  aria?: AriaAttributes;
  computed?: ComputedProperties;
  children: SnapshotNode[];
}

export interface CreateSnapshotOptions {
  selector?: string;
  includeAll?: boolean;
  includeIframes?: boolean;
}

export interface CreateSnapshotResult {
  tree: SnapshotNode | null;
  uidMap: UidEntry[];
  truncated: boolean;
  selectorError?: string;
}
