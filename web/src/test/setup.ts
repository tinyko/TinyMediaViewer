import "@testing-library/jest-dom/vitest";

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  value: () => null,
});

class MockIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

Object.defineProperty(window, "IntersectionObserver", {
  value: MockIntersectionObserver,
  writable: true,
});

Object.defineProperty(window, "matchMedia", {
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
  writable: true,
});

const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  writable: true,
});
