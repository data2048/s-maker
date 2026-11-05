// Must be imported before any Strudel module.
//
// The player runs in an iframe with sandbox="allow-scripts" (no allow-same-origin), so the page has an
// opaque origin and reading window.localStorage throws a SecurityError. Strudel stores editor settings
// there, so give it an in-memory replacement. Nothing is persisted, which is what we want.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  let works: boolean;
  try {
    works = typeof window[name]?.getItem === 'function';
  } catch {
    works = false;
  }
  if (!works) Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true });
}

export {};
