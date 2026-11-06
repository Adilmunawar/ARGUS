const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

const browser = readonly([
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console', 'performance',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'caches',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'getComputedStyle', 'matchMedia', 'getSelection', 'scrollTo', 'scrollBy', 'open', 'close',
  'alert', 'confirm', 'prompt', 'print', 'atob', 'btoa', 'structuredClone', 'reportError',
  'fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'BroadcastChannel', 'Worker',
  'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'FileReader',
  'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'Event', 'CustomEvent', 'EventTarget', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent',
  'InputEvent', 'UIEvent', 'WheelEvent', 'TouchEvent', 'PopStateEvent', 'HashChangeEvent', 'StorageEvent',
  'Node', 'NodeList', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
  'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLCanvasElement', 'HTMLDocument', 'SVGElement', 'Text',
  'DocumentFragment', 'DOMParser', 'DOMRect', 'Range', 'Selection', 'ShadowRoot',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver',
  'NodeFilter', 'Image', 'Option', 'Audio', 'CSS', 'Intl',
  'Promise', 'Map', 'Set', 'WeakMap', 'Symbol', 'ArrayBuffer', 'Uint8Array', 'DataView'
]);

const node = readonly([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'performance', 'crypto',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'Event', 'EventTarget', 'BroadcastChannel', 'MessageChannel', 'WebSocket', 'atob', 'btoa'
]);

const rules = {
  'no-unused-vars': ['error', { caughtErrors: 'none' }],
  'no-undef': 'error',
  'no-shadow': 'error',
  eqeqeq: ['error', 'smart'],
  'no-redeclare': 'error'
};

module.exports = [
  {
    ignores: ['**/node_modules/**', 'platform/compose/secrets/**']
  },
  {
    files: ['platform/console/prototype/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: browser
    },
    rules
  },
  {
    files: ['**/*.js'],
    ignores: ['platform/console/prototype/js/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: node
    },
    rules
  },
  {
    files: ['platform/console/prototype/tests/**/*.js'],
    languageOptions: {
      globals: Object.assign({}, browser, node)
    }
  }
];
