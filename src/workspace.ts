export type Theme = 'light' | 'dark';

export interface DiagramTab {
  id: string;
  title: string;
  source: string;
  original: boolean;
  automatic: boolean;
}

export interface Workspace {
  version: 1;
  activeId: string;
  tabs: DiagramTab[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Saved tabs have an invalid ${field}.`);
  return value;
}

function tab(value: unknown, index: number): DiagramTab {
  if (!record(value)) throw new Error(`Saved tab ${index + 1} is invalid.`);
  if (typeof value.original !== 'boolean' || typeof value.automatic !== 'boolean') {
    throw new Error(`Saved tab ${index + 1} has invalid layout options.`);
  }
  return {
    id: text(value.id, `tab ${index + 1} identifier`),
    title: text(value.title, `tab ${index + 1} title`),
    source: text(value.source, `tab ${index + 1} source`),
    original: value.original,
    automatic: value.automatic,
  };
}

function workspace(value: unknown): Workspace {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.tabs) || !value.tabs.length) {
    throw new Error('Saved tabs use an unsupported or invalid format.');
  }
  const tabs = value.tabs.map(tab);
  const ids = new Set(tabs.map(item => item.id));
  if (ids.size !== tabs.length) throw new Error('Saved tabs contain duplicate identifiers.');
  const activeId = text(value.activeId, 'active tab identifier');
  if (!ids.has(activeId)) throw new Error('Saved tabs do not contain the active diagram.');
  return { version: 1, activeId, tabs };
}

export function decodeWorkspace(serialized: string): Workspace {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('Saved tabs are not valid JSON.', { cause: error });
  }
  return workspace(value);
}

export function encodeWorkspace(value: Workspace): string {
  return JSON.stringify(workspace(value));
}

export function createWorkspace(source: string, id: string): Workspace {
  return {
    version: 1,
    activeId: id,
    tabs: [{ id, title: 'Diagram 1', source, original: false, automatic: true }],
  };
}

export function activeTab(value: Workspace): DiagramTab {
  const item = value.tabs.find(candidate => candidate.id === value.activeId);
  if (!item) throw new Error('The active diagram tab is missing.');
  return item;
}

export function activateTab(value: Workspace, id: string): Workspace {
  if (!value.tabs.some(item => item.id === id)) throw new Error('The requested diagram tab does not exist.');
  return { ...value, activeId: id };
}

export function addTab(value: Workspace, item: DiagramTab): Workspace {
  if (value.tabs.some(candidate => candidate.id === item.id)) throw new Error('A diagram tab with this identifier already exists.');
  tab(item, value.tabs.length);
  return { ...value, activeId: item.id, tabs: [...value.tabs, item] };
}

export function updateTab(value: Workspace, id: string, updates: Partial<Omit<DiagramTab, 'id'>>): Workspace {
  const current = value.tabs.find(item => item.id === id);
  if (!current) throw new Error('The requested diagram tab does not exist.');
  const next = { ...current, ...updates };
  if (next.title === current.title && next.source === current.source
    && next.original === current.original && next.automatic === current.automatic) return value;
  return {
    ...value,
    tabs: value.tabs.map(item => item.id === id ? next : item),
  };
}

export function closeTab(value: Workspace, id: string): Workspace {
  const index = value.tabs.findIndex(item => item.id === id);
  if (index < 0) throw new Error('The requested diagram tab does not exist.');
  if (value.tabs.length === 1) throw new Error('At least one diagram tab must remain open.');
  const tabs = value.tabs.filter(item => item.id !== id);
  const activeId = value.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : value.activeId;
  return { ...value, activeId, tabs };
}

export function resolveTheme(saved: string | null, prefersDark: boolean): Theme {
  if (saved === 'light' || saved === 'dark') return saved;
  return prefersDark ? 'dark' : 'light';
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}
