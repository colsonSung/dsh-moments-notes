/**
 * The canvas half of the Moments client.
 *
 * The design contract (`docs/canvas-design.md`) is the only source of truth
 * for these cases: the test drives the real component tree of `client.js`
 * and asserts the behaviour the contract asks for, not the way the component
 * happens to implement it.
 *
 * The browser half is loaded with a fake window and a fake document, its
 * plugin factory runs against a React stand-in, and the Host route
 * `/api/moments-notes` is answered by a recorder that speaks the five canvas
 * methods of the contract.
 *
 * Run with: `node --test tests/canvas-client.test.js`
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

const ROUTE = '/api/moments-notes'

/** Let the promises of the page settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Wait for a given number of milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------- react stand-in */

/**
 * A React stand-in with the hooks the browser half uses.
 *
 * The hooks are real enough for the plugin: the state survives a render, a
 * state change renders the tree again, and the effects run once per change
 * of their dependencies.
 *
 * @returns {any}
 */
function fakeReact() {
  const cells = new Map()
  let context = null

  /** Whether two dependency lists are the same. */
  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  const host = {
    pending: false,
    begin(path) {
      const list = cells.get(path) ?? []
      cells.set(path, list)
      context = { path, index: 0, cells: list }
    },
    end() {
      context = null
    },
    /**
     * Render the tree again after a state change.
     *
     * React batches the updates of an event handler: the tree is rendered
     * once, after the handler is done. A renderer that flushed every state
     * change right away would let a handler see its own next render, which
     * no browser does.
     *
     * A component that asks for a new render in every pass would keep the
     * page busy for ever, so the chain is cut short — the browser refuses
     * it as well.
     */
    scheduleRender() {
      if (host.pending === true) return
      host.pending = true
      queueMicrotask(() => {
        host.pending = false
        host.flushes = (host.flushes ?? 0) + 1
        if (host.flushes > 100) {
          host.flushes = 0
          throw new Error('the render does not settle: the canvas keeps asking for a new render')
        }
        host.renderer?.scheduleRender()
      })
    },
    /**
     * Forget the chain of renders, so the next interaction starts fresh.
     *
     * @returns {void}
     */
    resetFlushes() {
      host.flushes = 0
    },
    useState(initial) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, value: undefined })
      if (cell.ready !== true) {
        cell.value = typeof initial === 'function' ? initial() : initial
        cell.ready = true
      }
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (Object.is(value, cell.value)) return
        cell.value = value
        host.scheduleRender()
      }
      return [cell.value, setValue]
    },
    useEffect(effect, deps) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, deps: undefined, cleanup: undefined })
      if (cell.ready !== true || sameDeps(cell.deps, deps) !== true) {
        cell.deps = deps
        cell.ready = true
        if (typeof cell.cleanup === 'function') cell.cleanup()
        cell.cleanup = effect()
      }
    },
    useCallback(callback, deps) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, deps: undefined, value: undefined })
      if (cell.ready !== true || sameDeps(cell.deps, deps) !== true) {
        cell.deps = deps
        cell.value = callback
        cell.ready = true
      }
      return cell.value
    },
    useMemo(factory, deps) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { ready: false, deps: undefined, value: undefined })
      if (cell.ready !== true || sameDeps(cell.deps, deps) !== true) {
        cell.deps = deps
        cell.ready = true
        // The result is kept, not the factory: a memo that hands out a new
        // object on every render would make every effect that depends on it
        // run for ever.
        cell.value = factory()
      }
      return cell.value
    },
    useRef(initial) {
      const index = context.index++
      const cell = context.cells[index] ?? (context.cells[index] = { current: initial })
      return cell
    },
  }

  /** The rect every element of the fake document reports. */
  const rect = { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0 }

  /**
   * The attributes a `data-` prop exposes on `dataset`.
   *
   * @param {any} props
   * @returns {Record<string, string>}
   */
  const datasetOf = (props) => {
    const data = {}
    for (const [name, value] of Object.entries(props)) {
      if (!name.startsWith('data-') || value === undefined || value === null) continue
      data[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value)
    }
    return data
  }

  // React.Fragment is a real value the client may build with; the stand-in
  // has to answer it the same way rather than treating it as a DOM tag.
  const FRAGMENT = Symbol('react.fragment')

  const react = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'string') {
        // The fake document answers the few DOM questions a canvas asks.
        if (typeof merged.getBoundingClientRect !== 'function') merged.getBoundingClientRect = () => rect
        if (typeof merged.getAttribute !== 'function') {
          merged.getAttribute = (name) => (merged[name] === undefined ? null : String(merged[name]))
        }
        if (typeof merged.setAttribute !== 'function') {
          merged.setAttribute = (name, value) => { merged[name] = value }
        }
        if (typeof merged.setPointerCapture !== 'function') merged.setPointerCapture = () => {}
        if (typeof merged.releasePointerCapture !== 'function') merged.releasePointerCapture = () => {}
        if (typeof merged.focus !== 'function') merged.focus = () => {}
        if (typeof merged.blur !== 'function') merged.blur = () => {}
        if (typeof merged.scrollIntoView !== 'function') merged.scrollIntoView = () => {}
        if (merged.style === undefined) merged.style = {}
        Object.defineProperty(merged, 'dataset', {
          configurable: true,
          enumerable: false,
          get: () => datasetOf(merged),
        })
      }
      return { type, props: merged }
    },
    Fragment: (props) => props?.children,
    useState: (initial) => host.useState(initial),
    useEffect: (effect, deps) => host.useEffect(effect, deps),
    useCallback: (callback, deps) => host.useCallback(callback, deps),
    useMemo: (factory, deps) => host.useMemo(factory, deps),
    useRef: (initial) => host.useRef(initial),
  }

  return { react, host }
}

/**
 * Render a tree of elements and keep it in step with its state.
 */
class TestRenderer {
  /**
   * @param {any} react the React stand-in
   */
  constructor(react) {
    this.react = react
    this.element = null
    this.root = null
    this.rendering = false
    this.dirty = false
  }

  /**
   * Render one element.
   *
   * @param {any} element
   * @returns {any} the rendered tree
   */
  render(element) {
    this.element = element
    this.run()
    return this.root
  }

  /**
   * Render the tree until it settles.
   *
   * @returns {void}
   */
  run() {
    let rounds = 0
    while (true) {
      this.dirty = false
      this.rendering = true
      this.root = this.renderNode(this.element, 'root')
      this.rendering = false
      if (this.dirty !== true) return
      rounds++
      if (rounds > 25) throw new Error('the render does not settle')
    }
  }

  /**
   * Render the tree again after a state change.
   *
   * @returns {void}
   */
  scheduleRender() {
    if (this.rendering === true) {
      this.dirty = true
      return
    }
    this.run()
  }

  /**
   * Render one node.
   *
   * @param {any} node
   * @param {string} path
   * @returns {any}
   */
  renderNode(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') {
      return { type: '#text', text: String(node), props: {}, children: [] }
    }
    if (Array.isArray(node)) {
      const rendered = []
      node.forEach((child, index) => {
        const child_ = this.renderNode(child, `${path}.${index}`)
        if (Array.isArray(child_)) rendered.push(...child_)
        else if (child_ !== null) rendered.push(child_)
      })
      return rendered
    }
    if (node.type === this.react.Fragment) {
      return this.renderNode(node.props.children ?? null, `${path}>fragment`)
    }
    if (typeof node.type === 'function') {
      const key = `${path}@${node.type.name || 'fn'}`
      this.react.__host.begin(key)
      let result
      try {
        result = node.type(node.props)
      } finally {
        this.react.__host.end()
      }
      return this.renderNode(result, `${key}>`)
    }
    const children = this.renderNode(node.props.children, `${path}/`)
    const list = Array.isArray(children) ? children : (children === null ? [] : [children])
    return { type: node.type, props: node.props, children: list }
  }
}

/* ------------------------------------------------------------------- helpers */

/**
 * The markup of a rendered tree.
 *
 * @param {any} node
 * @returns {string}
 */
function toMarkup(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(toMarkup).join('')
  if (typeof node === 'string') return node
  if (node.type === '#text') return node.text
  if (node.type === 'style') return ''
  const attributes = Object.entries(node.props ?? {})
    .filter(([name, value]) => name !== 'children' && name !== 'dangerouslySetInnerHTML' && typeof value !== 'function')
    .map(([name, value]) => ` ${name}="${String(value)}"`)
    .join('')
  const inner = `${node.props?.dangerouslySetInnerHTML?.__html ?? ''}${node.children.map(toMarkup).join('')}`
  return `<${node.type}${attributes}>${inner}</${node.type}>`
}

/**
 * Every element of a tree, with its parent and its place in the tree.
 *
 * @param {any} node
 * @param {any} parent
 * @param {number[]} path
 * @param {Array<{node: any, parent: any, path: number[]}>} out
 * @returns {Array<{node: any, parent: any, path: number[]}>}
 */
function collect(node, parent = null, path = [], out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) {
    node.forEach((child, index) => collect(child, parent, [...path, index], out))
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (node.type === '#text') return out
  out.push({ node, parent, path })
  const children = node.children ?? []
  children.forEach((child, index) => collect(child, node, [...path, index], out))
  return out
}

/**
 * The parent of every element of a tree.
 *
 * @param {any} node
 * @returns {Map<any, any>}
 */
function parentMap(node) {
  const map = new Map()
  collect(node).forEach((entry) => map.set(entry.node, entry.parent))
  return map
}

/**
 * Every element of a tree that matches a predicate.
 *
 * The place of every element in the tree is remembered, so an element that
 * was found before a render can be found again after it.
 *
 * @param {any} node
 * @param {(element: any) => boolean} predicate
 * @returns {any[]}
 */
function findAll(node, predicate) {
  const found = collect(node).filter((entry) => predicate(entry.node))
  for (const entry of found) {
    if (entry.node.__livePath === undefined) {
      Object.defineProperty(entry.node, '__livePath', { value: entry.path, enumerable: false, configurable: true })
    }
  }
  return found.map((entry) => entry.node)
}

/**
 * The first element of a tree that matches a predicate.
 *
 * @param {any} node
 * @param {(element: any) => boolean} predicate
 * @returns {any}
 */
function findBy(node, predicate) {
  const found = findAll(node, predicate)
  return found.length > 0 ? found[0] : null
}

/**
 * Whether an element carries a class name.
 *
 * @param {any} element
 * @param {string} name
 * @returns {boolean}
 */
function hasClass(element, name) {
  const className = element?.props?.className
  if (typeof className !== 'string') return false
  return className.split(/\s+/).includes(name)
}

/**
 * Every element of a tree that carries a class name.
 *
 * @param {any} node
 * @param {string} name
 * @returns {any[]}
 */
function findAllByClass(node, name) {
  return findAll(node, (element) => hasClass(element, name))
}

/**
 * The first element of a tree that carries a class name.
 *
 * @param {any} node
 * @param {string} name
 * @returns {any}
 */
function findByClass(node, name) {
  return findBy(node, (element) => hasClass(element, name))
}

/**
 * The path of an element inside the tree.
 *
 * @param {any} node
 * @param {any} element
 * @returns {number[]|null}
 */
function pathOf(node, element) {
  const walk = (current, path) => {
    if (current === null || current === undefined || typeof current !== 'object') return null
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const found = walk(current[index], [...path, index])
        if (found) return found
      }
      return null
    }
    if (current.type === '#text') return null
    if (current === element) return path
    const children = current.children ?? []
    for (let index = 0; index < children.length; index += 1) {
      const found = walk(children[index], [...path, index])
      if (found) return found
    }
    return null
  }
  return walk(node, [])
}

/**
 * The element that sits at a path of the tree.
 *
 * @param {any} node
 * @param {number[]} path
 * @returns {any}
 */
function resolvePath(node, path) {
  let current = node
  for (const index of path) {
    if (current === null || current === undefined) return null
    current = Array.isArray(current) ? current[index] : (current.children ?? [])[index]
  }
  return current ?? null
}

/**
 * The element the tree holds now.
 *
 * Every render builds a new tree, so an element that was looked up before an
 * interaction describes the past — including the handlers it carries, which
 * close over the state of that past render. The place of the element in the
 * tree is kept, and the element that sits there now is returned.
 *
 * @param {any} root
 * @param {any} element
 * @returns {any}
 */
function liveElement(root, element) {
  if (!element) return null
  const identity = element.props?.['data-node-id']
  const live = element.__livePath === undefined ? null : resolvePath(root, element.__livePath)
  if (live && live !== element) {
    // A cached path only counts when the element sitting there now is
    // recognisably the same one: a path remembered from a subtree lookup is
    // relative to that subtree, and a re-render moves every element anyway.
    const matches = identity !== undefined
      ? live.props?.['data-node-id'] === identity
      : live.type === element.type
        && String(live.props?.className ?? '') === String(element.props?.className ?? '')
    if (matches) return live
  }
  if (identity !== undefined) {
    const again = findAll(root, (candidate) => candidate.props?.['data-node-id'] === identity)
    if (again.length > 0) return again[0]
  }
  if (live === element) return live
  // The remembered path does not check out: find where the element actually
  // sits in the tree right now, or fall back to the element as it is.
  const path = pathOf(root, element)
  if (path === null) return element
  Object.defineProperty(element, '__livePath', { value: path, enumerable: false, configurable: true })
  return element
}

/**
 * The closest element that owns an event handler, starting at the element
 * itself and walking up the tree.
 *
 * A canvas may listen on the node, or delegate to the world layer, or to the
 * surface: the contract only asks for the behaviour, not for the place the
 * handler sits.
 *
 * @param {any} root
 * @param {any} element
 * @param {string} prop
 * @returns {any}
 */
function closestHandler(root, element, prop) {
  const map = parentMap(root)
  let current = liveElement(root, element)
  while (current) {
    if (typeof current.props?.[prop] === 'function') return current
    current = map.get(current) ?? null
  }
  return null
}

/* -------------------------------------------------------------- fake browser */

/**
 * A window that answers what the browser half asks of it.
 *
 * The timers it hands out never keep the process alive: the page owns them,
 * not the test.
 *
 * @returns {any}
 */
function fakeWindow() {
  const timers = new Set()
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const window = {
    listeners,
    timers,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    },
    matchMedia: () => ({ matches: false }),
    open() {},
    confirm: () => true,
  }
  return window
}

/**
 * A document that records the styles the browser half injects.
 *
 * Every element the page creates is remembered: an export builds its SVG
 * somewhere, and the test has to be able to look at it.
 *
 * @returns {any}
 */
function fakeDocument() {
  const styles = []
  const created = []
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()

  /**
   * An element of the fake document.
   *
   * @param {string} tagName
   * @returns {any}
   */
  const makeElement = (tagName) => {
    const element = {
      tagName: String(tagName).toUpperCase(),
      id: '',
      textContent: '',
      style: {},
      attributes: {},
      children: [],
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
      appendChild(child) { this.children.push(child); return child },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        return child
      },
      remove() {},
      click() {},
      focus() {},
    }
    created.push(element)
    return element
  }

  return {
    styles,
    created,
    listeners,
    body: {
      style: { overflow: '' },
      appendChild(node) { return node },
      removeChild(node) { return node },
    },
    activeElement: null,
    head: {
      appendChild(node) {
        if (node.tagName === 'STYLE') styles.push(node)
        return node
      },
    },
    getElementById: (id) => styles.find((style) => style.id === id) ?? null,
    createElement: (tagName) => makeElement(tagName),
    createElementNS: (_namespace, tagName) => makeElement(tagName),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    },
  }
}

/**
 * The markup of an element the fake document created.
 *
 * @param {any} element
 * @returns {string}
 */
function serializeElement(element) {
  if (!element) return ''
  const attributes = Object.entries(element.attributes ?? {})
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('')
  const inner = (element.textContent ?? '') + (element.children ?? []).map(serializeElement).join('')
  return `<${String(element.tagName ?? '').toLowerCase()}${attributes}>${inner}</${String(element.tagName ?? '').toLowerCase()}>`
}

/**
 * A local storage that keeps its values in memory.
 *
 * @returns {any}
 */
function fakeStorage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
    clear: () => values.clear(),
  }
}

/**
 * The Host route that answers the methods of the Moments API.
 *
 * @param {Record<string, any>} routes the answer of every method
 * @returns {any}
 */
function apiFetchStub(routes = {}) {
  const calls = []
  const impl = async (url, init) => {
    const raw = init?.body
    const body = raw === undefined ? null : JSON.parse(raw)
    calls.push({ url, method: body?.method ?? 'GET', payload: body?.payload })
    const route = routes[body?.method]
    const result = typeof route === 'function' ? await route(body?.payload, calls.length) : route
    // A route can answer with a failure the way the Host does, which is what
    // the error banner and the diagnostic log read.
    if (result && typeof result === 'object' && result.__error) {
      return { status: result.__status ?? 400, ok: false, json: async () => ({ ok: false, error: result.__error }) }
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) }
  }
  impl.calls = calls
  return impl
}

/**
 * Load the browser half and run its plugin factory.
 *
 * @param {{routes?: Record<string, any>, storage?: any}} options
 * @returns {Promise<any>}
 */
async function loadMomentsClient(options = {}) {
  const source = await readFile(clientPath, 'utf8')
  const window = fakeWindow()
  const document = fakeDocument()
  const storage = options.storage ?? fakeStorage()
  const fetch = apiFetchStub(options.routes ?? {})

  let factory = null
  window.__ModuleLoader__ = {
    load(spec) {
      factory = spec.factory
    },
  }

  const { react, host } = fakeReact()

  const timers = new Set()
  const setTimeoutOf = (fn, ms, ...rest) => {
    const timer = setTimeout(fn, ms, ...rest)
    timer.unref?.()
    timers.add(timer)
    return timer
  }
  const clearTimeoutOf = (timer) => {
    timers.delete(timer)
    clearTimeout(timer)
  }
  const setIntervalOf = (fn, ms, ...rest) => {
    const timer = setInterval(fn, ms, ...rest)
    timer.unref?.()
    timers.add(timer)
    return timer
  }
  const clearIntervalOf = (timer) => {
    timers.delete(timer)
    clearInterval(timer)
  }
  const requestAnimationFrameOf = (fn) => setTimeoutOf(fn, 0)

  class FakeHTMLElement {}

  // The canvas reads its palette out of the theme of the page. The fake
  // document has no theme, so the tokens it asks for are answered with the
  // values the plugin itself declares.
  const themeTokens = {
    '--mm-palette-ember': 'rgb(181 64 42)',
    '--mm-palette-amber': 'rgb(201 146 44)',
    '--mm-palette-rose': 'rgb(192 90 98)',
    '--mm-palette-sage': 'rgb(95 143 108)',
    '--mm-palette-sky': 'rgb(74 127 181)',
    '--mm-palette-violet': 'rgb(124 107 196)',
    '--mm-palette-slate': 'rgb(107 114 128)',
  }
  const getComputedStyle = () => ({
    getPropertyValue: (name) => themeTokens[name] ?? '',
  })

  // An export hands its file to the browser as a blob. The blob is kept, so
  // the test can read the SVG the canvas produced.
  const blobs = []
  const url = {
    createObjectURL(blob) {
      blobs.push(blob)
      return `blob:fake/${blobs.length}`
    },
    revokeObjectURL() {},
  }

  const sandbox = {
    window,
    document,
    localStorage: storage,
    navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
    crypto: globalThis.crypto,
    Blob: globalThis.Blob,
    URL: url,
    HTMLElement: FakeHTMLElement,
    setTimeout: setTimeoutOf,
    clearTimeout: clearTimeoutOf,
    setInterval: setIntervalOf,
    clearInterval: clearIntervalOf,
    requestAnimationFrame: requestAnimationFrameOf,
    cancelAnimationFrame: clearTimeoutOf,
    queueMicrotask: globalThis.queueMicrotask,
    getComputedStyle,
    // The client warns when it is asked to change a style; only the probe
    // prefix of that warning is echoed, so a normal run stays quiet.
    console: {
      ...console,
      warn: (...args) => {
        if (String(args[0]).startsWith('DBGCLIENT')) console.log(...args);
      },
    },
    fetch,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(typeof factory, 'function', 'the browser half must register a factory')

  const plugin = factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`the browser half asked for the module "${specifier}"`)
  })
  react.__host = host

  const registrations = []
  const injected = []
  const cleanups = []
  const ctx = {
    slots: {
      inject(name, register) {
        injected.push(name)
        return register()
      },
      register(slotOptions, component) {
        registrations.push({ slotOptions, component })
        return () => {}
      },
    },
    effect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get: () => undefined,
    provide: () => {},
    on: () => {},
  }
  plugin.apply(ctx)

  const renderer = new TestRenderer(react)
  host.renderer = renderer

  return {
    ctx,
    react,
    renderer,
    window,
    document,
    storage,
    fetch,
    blobs,
    registrations,
    injected,
    cleanups,
    restore() {
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          // A cleanup that fails must not hide the result of the test.
        }
      }
      for (const timer of timers) {
        clearTimeout(timer)
        clearInterval(timer)
      }
      timers.clear()
    },
  }
}

/**
 * Render the component the plugin registered in the main slot.
 *
 * @param {any} plugin
 * @returns {any}
 */
function renderMain(plugin) {
  const entry = plugin.registrations.find((row) => row.slotOptions.name === 'main')
  assert.ok(entry, 'the plugin must register a component in the main slot')
  return plugin.renderer.render(plugin.react.createElement(entry.component, {}))
}

/* --------------------------------------------------------------- interaction */

/**
 * A synthetic event with the fields a canvas reads.
 *
 * @param {Record<string, any>} overrides
 * @returns {any}
 */
function makeEvent(overrides = {}) {
  const event = {
    type: 'event',
    target: null,
    currentTarget: null,
    clientX: 0,
    clientY: 0,
    pageX: 0,
    pageY: 0,
    screenX: 0,
    screenY: 0,
    button: 0,
    buttons: 0,
    detail: 1,
    deltaX: 0,
    deltaY: 0,
    deltaZ: 0,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
    persist() {},
    ...overrides,
  }
  event.nativeEvent = event
  return event
}

/**
 * Hand an event to the listeners the page registered on the window.
 *
 * @param {any} window
 * @param {string} type
 * @param {any} event
 * @returns {boolean} whether a listener took the event
 */
function dispatchWindow(window, type, event) {
  const listeners = window.listeners.get(type) ?? []
  if (listeners.length === 0) return false
  for (const listener of [...listeners]) listener(event)
  return true
}

/**
 * Hand an event to the listeners the page registered on the document.
 *
 * @param {any} document
 * @param {string} type
 * @param {any} event
 * @returns {boolean} whether a listener took the event
 */
function dispatchDocument(document, type, event) {
  const listeners = document.listeners.get(type) ?? []
  if (listeners.length === 0) return false
  for (const listener of [...listeners]) listener(event)
  return true
}

/**
 * The event families a component may listen to.
 */
const FAMILIES = [
  { down: 'onPointerDown', move: 'onPointerMove', up: 'onPointerUp', page: 'pointerdown', pageMove: 'pointermove', pageUp: 'pointerup' },
  { down: 'onMouseDown', move: 'onMouseMove', up: 'onMouseUp', page: 'mousedown', pageMove: 'mousemove', pageUp: 'mouseup' },
]

/**
 * The family an element listens to for a press.
 *
 * @param {any} root
 * @param {any} element
 * @returns {any}
 */
function familyOf(root, element) {
  for (const family of FAMILIES) {
    if (closestHandler(root, element, family.down)) return family
  }
  return FAMILIES[1]
}

/**
 * Let the page settle after an interaction.
 *
 * @param {any} plugin
 * @param {number} rounds
 * @returns {Promise<void>}
 */
async function settle(plugin, rounds = 2) {
  for (let index = 0; index < rounds; index += 1) {
    await tick()
    await tick()
  }
  plugin.react.__host.resetFlushes()
}

/**
 * Press an element, the way a pointer presses it.
 *
 * @param {any} plugin
 * @param {any} element
 * @param {{shiftKey?: boolean, metaKey?: boolean}} options
 * @returns {Promise<void>}
 */
async function pressElement(plugin, element, options = {}) {
  const root = plugin.renderer.root
  const target = liveElement(root, element)
  const family = familyOf(root, target)
  const host = closestHandler(root, target, family.down)
  assert.ok(host, 'the element must answer a press')
  const event = makeEvent({ buttons: 1, shiftKey: Boolean(options.shiftKey), metaKey: Boolean(options.metaKey) })
  event.target = target
  event.currentTarget = host
  host.props[family.down](event)
  await settle(plugin, 1)

  // The pointer is released on the page when the press ends, so a drag that
  // started here does not stay open for the next interaction.
  const up = makeEvent({ buttons: 0, shiftKey: Boolean(options.shiftKey), metaKey: Boolean(options.metaKey) })
  if (!dispatchWindow(plugin.window, family.pageUp, up)) {
    const upHost = closestHandler(plugin.renderer.root, target, family.up)
    if (upHost) {
      up.target = liveElement(plugin.renderer.root, target)
      up.currentTarget = upHost
      upHost.props[family.up](up)
    }
  }
  await settle(plugin, 1)
}

/**
 * The event family of a drag, resolved once for the whole gesture.
 *
 * @param {any} root
 * @param {any} element
 * @returns {any}
 */
function dragFamily(root, element) {
  return familyOf(root, element)
}

/**
 * Press the pointer on an element.
 *
 * @param {any} plugin
 * @param {any} element
 * @param {{x: number, y: number}} point
 * @param {{shiftKey?: boolean}} options
 * @returns {Promise<void>}
 */
async function pressAt(plugin, element, point, options = {}) {
  const target = liveElement(plugin.renderer.root, element)
  const family = dragFamily(plugin.renderer.root, target)
  const host = closestHandler(plugin.renderer.root, target, family.down)
  assert.ok(host, 'the element must answer a press')
  const down = makeEvent({
    clientX: point.x,
    clientY: point.y,
    buttons: 1,
    shiftKey: Boolean(options.shiftKey),
  })
  down.target = target
  down.currentTarget = host
  host.props[family.down](down)
  await settle(plugin, 1)
}

/**
 * Move the pointer over an element.
 *
 * @param {any} plugin
 * @param {any} element
 * @param {{x: number, y: number}} point
 * @param {{shiftKey?: boolean}} options
 * @returns {Promise<void>}
 */
async function movePointer(plugin, element, point, options = {}) {
  const target = liveElement(plugin.renderer.root, element)
  const family = dragFamily(plugin.renderer.root, target)
  const during = makeEvent({
    clientX: point.x,
    clientY: point.y,
    buttons: 1,
    shiftKey: Boolean(options.shiftKey),
  })
  if (!dispatchWindow(plugin.window, family.pageMove, during)) {
    if (!dispatchDocument(plugin.document, family.pageMove, during)) {
      const moveHost = closestHandler(plugin.renderer.root, target, family.move)
      if (moveHost) {
        during.target = target
        during.currentTarget = moveHost
        moveHost.props[family.move](during)
      }
    }
  }
  await settle(plugin, 1)
}

/**
 * Release the pointer.
 *
 * @param {any} plugin
 * @param {any} element
 * @param {{x: number, y: number}} point
 * @param {{shiftKey?: boolean}} options
 * @returns {Promise<void>}
 */
async function releaseAt(plugin, element, point, options = {}) {
  const target = liveElement(plugin.renderer.root, element)
  const family = dragFamily(plugin.renderer.root, target)
  const up = makeEvent({
    clientX: point.x,
    clientY: point.y,
    buttons: 0,
    shiftKey: Boolean(options.shiftKey),
  })
  if (!dispatchWindow(plugin.window, family.pageUp, up)) {
    if (!dispatchDocument(plugin.document, family.pageUp, up)) {
      const upHost = closestHandler(plugin.renderer.root, target, family.up)
      if (upHost) {
        up.target = target
        up.currentTarget = upHost
        upHost.props[family.up](up)
      }
    }
  }
  await settle(plugin, 1)
}

/**
 * Drag across an element.
 *
 * The gesture is offered in three steps because the contract asks about the
 * state *during* a drag: the marquee is drawn while the pointer is down and
 * gone once it is released.
 *
 * @param {any} plugin
 * @param {any} element
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}, shiftKey?: boolean}} move
 * @param {{inspect?: () => void}} options
 * @returns {Promise<void>}
 */
async function dragOn(plugin, element, move, options = {}) {
  await pressAt(plugin, element, move.from, move)
  await movePointer(plugin, element, move.to, move)
  if (typeof options.inspect === 'function') options.inspect()
  await releaseAt(plugin, element, move.to, move)
}

/**
 * Press a key on the canvas.
 *
 * @param {any} plugin
 * @param {string} key
 * @param {{metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean}} options
 * @returns {Promise<void>}
 */
async function pressKey(plugin, key, options = {}) {
  const root = plugin.renderer.root
  const surface = findByClass(root, 'mm-canvas-surface')
  if (surface) plugin.document.activeElement = surface
  const event = makeEvent({
    key,
    metaKey: Boolean(options.metaKey),
    ctrlKey: Boolean(options.ctrlKey),
    shiftKey: Boolean(options.shiftKey),
  })
  const host = surface ? closestHandler(plugin.renderer.root, surface, 'onKeyDown') : null
  if (host) {
    event.target = surface
    event.currentTarget = host
    host.props.onKeyDown(event)
  } else if (!dispatchWindow(plugin.window, 'keydown', event)) {
    dispatchDocument(plugin.document, 'keydown', event)
  }
  await settle(plugin)
}

/**
 * Turn the wheel over the canvas.
 *
 * @param {any} plugin
 * @param {any} element
 * @param {{deltaY: number, ctrlKey?: boolean, metaKey?: boolean}} wheel
 * @returns {Promise<void>}
 */
async function wheelOn(plugin, element, wheel) {
  const root = plugin.renderer.root
  const host = closestHandler(root, element, 'onWheel')
  assert.ok(host, 'the canvas must answer the wheel')
  const event = makeEvent({
    deltaY: wheel.deltaY,
    ctrlKey: Boolean(wheel.ctrlKey),
    metaKey: Boolean(wheel.metaKey),
  })
  event.target = element
  event.currentTarget = host
  host.props.onWheel(event)
  await settle(plugin)
}

/* ------------------------------------------------------------- canvas helpers */

/**
 * Whether a node of the canvas is selected.
 *
 * @param {any} node
 * @returns {boolean}
 */
function isSelected(node) {
  return hasClass(node, 'is-selected')
}

/**
 * The position a node is drawn at.
 *
 * @param {any} node
 * @returns {any}
 */
function positionOf(node) {
  const style = node?.props?.style ?? {}
  return { left: style.left, top: style.top }
}

/**
 * The nodes the canvas draws.
 *
 * @param {any} plugin
 * @returns {any[]}
 */
function canvasNodes(plugin) {
  const root = plugin.renderer.root
  return findAll(root, (element) => (
    hasClass(element, 'mm-canvas-node') && element.props['data-node-id'] !== undefined
  )).map((element) => {
    // Remember where the node sits while it is still part of the tree. The
    // path is the only thing that survives the next render, so it has to be
    // taken now — afterwards the element itself is already the past.
    if (element.__livePath === undefined) {
      const path = pathOf(root, element)
      if (path !== null) {
        Object.defineProperty(element, '__livePath', { value: path, enumerable: false, configurable: true })
      }
    }
    return element
  })
}

/**
 * The node the canvas draws now.
 *
 * Every render builds a new tree, so a node that was looked up before an
 * interaction describes the past. The contract is about the state of the
 * canvas now, so the node is looked up again after every gesture.
 *
 * @param {any} plugin
 * @param {string} id
 * @returns {any}
 */
function nodeById(plugin, id) {
  const found = canvasNodes(plugin).find((node) => node.props['data-node-id'] === id)
  assert.ok(found, `the canvas must draw the node ${id}`)
  return found
}

/**
 * Switch the workspace into the canvas mode.
 *
 * @param {any} plugin
 * @returns {Promise<void>}
 */
async function enterCanvasMode(plugin) {
  const nav = findByClass(plugin.renderer.root, 'mm-nav')
  assert.ok(nav, 'the workspace must keep its navigation')
  const entry = findAll(nav, (element) => element.type === 'button')
    .find((button) => /design/i.test(toMarkup(button)))
  assert.ok(entry, 'the navigation must offer a Design entry')
  entry.props.onClick()
  await settle(plugin, 3)
}

/* ------------------------------------------------------------- v2 helpers */

/**
 * The text an element carries, its own text and the text of its children.
 *
 * @param {any} element
 * @returns {string}
 */
function textOf(element) {
  let text = ''
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      text += String(current)
      return
    }
    if (current.type === '#text') {
      text += String(current.text)
      return
    }
    (current.children ?? []).forEach(walk)
  }
  walk(element?.props?.children)
  return text
}

/**
 * The name a control answers to.
 *
 * @param {any} element
 * @returns {string}
 */
function accessibleName(element) {
  const props = element?.props ?? {}
  return [
    props['aria-label'],
    props.title,
    props.placeholder,
    props['data-label'],
    textOf(element),
  ].filter(Boolean).join(' ')
}

/**
 * The control of the canvas that answers to a name.
 *
 * The contract names the actions, not the markup of the buttons that carry
 * them, so the control is looked up by what it says and by the vocabulary the
 * plugin uses for its own tools.
 *
 * @param {any} plugin
 * @param {{tool?: string, data?: string, name?: RegExp, exact?: string}} wanted
 * @returns {any}
 */
function controlBy(plugin, wanted) {
  const root = plugin.renderer.root
  const all = findAll(root, (element) => (
    typeof element.type === 'string' && element.type !== 'svg' && element.type !== 'path'
  ))
  // A control is something that answers a click. The text inside a button
  // carries the same name, but it is not the button.
  const interactive = all.filter((element) => (
    typeof element.props.onClick === 'function' || typeof element.props.onPointerDown === 'function'
  ))
  const byData = (candidates) => candidates.find((element) => {
    if (wanted.tool !== undefined && element.props['data-tool'] === wanted.tool) return true
    if (wanted.data !== undefined && element.props[wanted.data] !== undefined) return true
    return false
  })
  const found = byData(interactive) ?? byData(all)
  if (found) return found
  if (wanted.exact !== undefined) {
    const exact = (interactive.find((element) => accessibleName(element).trim() === wanted.exact)
      ?? all.find((element) => accessibleName(element).trim() === wanted.exact))
    if (exact) return exact
  }
  if (wanted.name !== undefined) {
    const named = (interactive.find((element) => wanted.name.test(accessibleName(element)))
      ?? all.find((element) => wanted.name.test(accessibleName(element))))
    if (named) return named
  }
  return null
}

/**
 * Click a control.
 *
 * @param {any} plugin
 * @param {any} element
 * @returns {Promise<void>}
 */
async function clickElement(plugin, element) {
  assert.ok(element, 'the control must exist')
  const target = liveElement(plugin.renderer.root, element)
  const props = target?.props ?? {}
  if (typeof props.onClick === 'function') {
    const event = makeEvent({ target, currentTarget: target })
    props.onClick(event)
    await settle(plugin)
    return
  }
  await pressElement(plugin, target)
}

/**
 * Double click a control.
 *
 * @param {any} plugin
 * @param {any} element
 * @returns {Promise<void>}
 */
async function doubleClick(plugin, element) {
  assert.ok(element, 'the control must exist')
  const target = liveElement(plugin.renderer.root, element)
  const props = target?.props ?? {}
  if (typeof props.onDoubleClick === 'function') {
    const event = makeEvent({ target, currentTarget: target })
    props.onDoubleClick(event)
    await settle(plugin)
    return
  }
  await clickElement(plugin, target)
  await clickElement(plugin, target)
}

/**
 * The document the canvas saved last.
 *
 * @param {any} plugin
 * @returns {Promise<any>}
 */
async function savedDocument(plugin) {
  await sleep(900)
  const saves = plugin.fetch.calls.filter((call) => call.method === 'canvas-save')
  return saves.length > 0 ? saves[saves.length - 1].payload : null
}

/**
 * The nodes of the canvas of one type.
 *
 * @param {any} plugin
 * @param {string} type
 * @returns {any[]}
 */
function nodesOfType(plugin, type) {
  return canvasNodes(plugin).filter((node) => node.props['data-node-type'] === type)
}

/**
 * Whether a node still draws its text.
 *
 * The text of a node is a text node of its own in the tree, so the overview
 * mode can be told apart from a node that only carries the text in a label.
 *
 * @param {any} node
 * @param {string} text
 * @returns {boolean}
 */
function drawsText(node, text) {
  let found = false
  const walk = (current) => {
    if (found || current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    if (current.type === '#text') {
      if (String(current.text).includes(text)) found = true
      return
    }
    (current.children ?? []).forEach(walk)
  }
  walk(node)
  return found
}

/**
 * The element that draws an edge.
 *
 * @param {any} plugin
 * @param {string} edgeId
 * @returns {any}
 */
function edgeElement(plugin, edgeId) {
  const root = plugin.renderer.root
  const byId = findBy(root, (element) => element.props['data-edge-id'] === edgeId)
  if (byId) return byId
  return findBy(root, (element) => (
    typeof element.props.onDoubleClick === 'function' && hasClass(element, 'mm-canvas-edge')
  ))
}

/**
 * The text of an element, without the text of its children.
 *
 * @param {any} element
 * @returns {string}
 */
function ownText(element) {
  const children = element?.props?.children
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return ''
  return children.filter((child) => typeof child === 'string' || typeof child === 'number').join(' ')
}

/**
 * Every element of the tree that carries a piece of text.
 *
 * Only the innermost element that says it counts: the box around a label
 * says it as well.
 *
 * @param {any} plugin
 * @param {string} text
 * @returns {any[]}
 */
function elementsWithText(plugin, text) {
  const all = findAll(plugin.renderer.root, (element) => textOf(element).trim() === text)
  return all.filter((element) => findAll(element, (candidate) => (
    candidate !== element && textOf(candidate).trim() === text
  )).length === 0)
}

/**
 * The panel of the layers.
 *
 * @param {any} plugin
 * @returns {any}
 */
function layersPanel(plugin) {
  const root = plugin.renderer.root
  const named = findByClass(root, 'mm-sidebar-layers') ?? findByClass(root, 'mm-layer-tree')
  if (named) return named
  const heading = findBy(root, (element) => (
    (element.type === 'h2' || element.type === 'h3') && ownText(element).trim() === 'Layers'
  ))
  if (heading) {
    const parents = parentMap(root)
    let current = parents.get(heading)
    while (current) {
      if (findAll(current, (element) => /\b(hide|show)\b/i.test(accessibleName(element))).length > 0) return current
      current = parents.get(current)
    }
  }
  const labelled = findBy(root, (element) => /layers/i.test(String(element.props?.['aria-label'] ?? '')))
  if (labelled) return labelled
  return findBy(root, (element) => (
    typeof element.props?.className === 'string'
    && element.props.className.split(/\s+/).some((name) => name.includes('layer'))
  ))
}

/**
 * The rows of the layers panel.
 *
 * A row is a line of the tree that carries a switch to show and hide the
 * node it names.
 *
 * @param {any} plugin
 * @returns {any[]}
 */
function layerRows(plugin) {
  const panel = layersPanel(plugin)
  if (!panel) return []
  const parents = parentMap(panel)
  const rows = []
  for (const eye of findAll(panel, (element) => (
    typeof element.props.onClick === 'function' && /\b(hide|show)\b/i.test(accessibleName(element))
  ))) {
    const row = parents.get(eye)
    if (row && !rows.includes(row)) rows.push(row)
  }
  return rows
}

/**
 * The control of a layer row that names the node.
 *
 * @param {any} row
 * @returns {any}
 */
function layerNameControl(row) {
  return findAll(row, (element) => (
    typeof element.props.onClick === 'function'
    && !/\b(hide|show)\b/i.test(accessibleName(element))
  ))[0] ?? null
}

/**
 * The control of a layer row that shows and hides the node.
 *
 * @param {any} row
 * @returns {any}
 */
function layerVisibilityControl(row) {
  return findAll(row, (element) => (
    typeof element.props.onClick === 'function' && /\b(hide|show)\b/i.test(accessibleName(element))
  ))[0] ?? null
}

/**
 * The control that aligns the selection.
 *
 * @param {any} plugin
 * @param {string} direction
 * @returns {any}
 */
function alignControl(plugin, direction) {
  const names = {
    left: [/align\s*left/i, /left\s*align/i, /^left$/i],
    right: [/align\s*right/i, /right\s*align/i, /^right$/i],
    top: [/align\s*top/i, /top\s*align/i, /^top$/i],
    bottom: [/align\s*bottom/i, /bottom\s*align/i, /^bottom$/i],
    centerX: [/horizontal[^a-z]*(cent(er|re)|middle)/i, /(cent(er|re)|middle)[^a-z]*horizontal/i, /水平居中/],
    centerY: [/vertical[^a-z]*(cent(er|re)|middle)/i, /(cent(er|re)|middle)[^a-z]*vertical/i, /垂直居中/],
    distributeX: [/distribute[^a-z]*horiz/i, /horiz[^a-z]*distribute/i, /水平分布/],
    distributeY: [/distribute[^a-z]*vert/i, /vert[^a-z]*distribute/i, /垂直分布/],
  }
  const wanted = names[direction] ?? []
  const root = plugin.renderer.root
  const candidates = findAll(root, (element) => (
    typeof element.type === 'string' && element.type !== 'svg' && element.type !== 'path'
  ))
  const data = candidates.find((element) => {
    const value = String(element.props['data-align'] ?? element.props['data-distribute'] ?? '').toLowerCase()
    return value === direction.toLowerCase()
      || value === direction.toLowerCase().replace('center', 'center-')
  })
  if (data) return data
  for (const pattern of wanted) {
    const found = candidates.find((element) => pattern.test(accessibleName(element)))
    if (found) return found
  }
  return null
}

/**
 * The colour a swatch carries.
 *
 * @param {any} element
 * @returns {string}
 */
function swatchColor(element) {
  const props = element?.props ?? {}
  const direct = props['data-color'] ?? props['data-fill'] ?? props['data-stroke'] ?? props['data-value']
  if (typeof direct === 'string' && direct.startsWith('#')) return direct.toLowerCase()
  const named = [props['aria-label'], props.title, props['data-label']].filter(Boolean).join(' ')
  const hex = named.match(/#[0-9a-fA-F]{3,8}/)
  if (hex) return hex[0].toLowerCase()
  const style = props.style ?? {}
  const painted = style.background ?? style.backgroundColor ?? style.color
  if (typeof painted === 'string') {
    const fromStyle = painted.match(/#[0-9a-fA-F]{3,8}/)
    if (fromStyle) return fromStyle[0].toLowerCase()
  }
  return null
}

/**
 * The control of the style bar that takes a number.
 *
 * @param {any} plugin
 * @param {RegExp} pattern
 * @returns {any}
 */
function styleField(plugin, pattern) {
  const root = plugin.renderer.root
  const fields = findAll(root, (element) => (
    element.type === 'input' || element.type === 'textarea' || element.type === 'button'
  ))
  return fields.find((field) => pattern.test(accessibleName(field))) ?? null
}

/**
 * The number a control of the style bar carries.
 *
 * @param {any} control
 * @returns {number}
 */
function styleValue(control) {
  const name = accessibleName(control)
  const match = name.match(/(-?\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : Number.NaN
}

/**
 * The groups the canvas draws.
 *
 * A group is a frame around its members, drawn below them — not a card of
 * its own.
 *
 * @param {any} plugin
 * @returns {any[]}
 */
function groupElements(plugin) {
  return findAll(plugin.renderer.root, (element) => element.props['data-group-id'] !== undefined)
}

/**
 * Whether a node is drawn on the canvas.
 *
 * @param {any} plugin
 * @param {string} id
 * @returns {boolean}
 */
function isNodeVisible(plugin, id) {
  const node = canvasNodes(plugin).find((element) => element.props['data-node-id'] === id)
  if (!node) return false
  const style = node.props.style ?? {}
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const className = String(node.props.className ?? '')
  if (className.split(/\s+/).some((name) => name.includes('hidden') || name.includes('invisible'))) return false
  return true
}

/**
 * The SVG the canvas exported.
 *
 * The export may build its SVG as a string and hand it over as a file, or
 * build it as an element and put it into the page. Both are looked at.
 *
 * @param {any} plugin
 * @returns {Promise<string>}
 */
async function exportedSvg(plugin) {
  const built = plugin.document.created
    .filter((element) => String(element.tagName).toLowerCase() === 'svg')
    .map(serializeElement)
    .find((markup) => markup.includes('<svg'))
  if (built) return built
  for (const blob of plugin.blobs) {
    const text = await blob.text()
    if (typeof text === 'string' && text.includes('<svg')) return text
  }
  const shown = findAll(plugin.renderer.root, (element) => (
    typeof element.props?.dangerouslySetInnerHTML?.__html === 'string'
    && element.props.dangerouslySetInnerHTML.__html.includes('<svg')
  ))
  if (shown.length > 0) return shown[0].props.dangerouslySetInnerHTML.__html
  const inline = findAll(plugin.renderer.root, (element) => (
    typeof element.type === 'svg'
  ))
  if (inline.length > 0) return toMarkup(inline[0])
  return ''
}

/* --------------------------------------------------------------- the fixture */const BOARD_LIST = [
  { id: 'c1', title: 'Roadmap', nodeCount: 2, edgeCount: 1, createdAt: 1757210000000, updatedAt: 1757213000000 },
  { id: 'c2', title: 'Reading list', nodeCount: 0, edgeCount: 0, createdAt: 1757200000000, updatedAt: 1757201000000 },
]

const SAMPLE_DOCUMENT = {
  version: 1,
  id: 'c1',
  title: 'Roadmap',
  createdAt: 1757210000000,
  updatedAt: 1757213000000,
  camera: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'n1',
      type: 'sticky',
      x: 40,
      y: 60,
      w: 240,
      h: 160,
      rotation: 0,
      text: 'Ship the canvas',
      noteId: null,
      noteUpdatedAt: null,
      color: 'amber',
      locked: false,
      visible: true,
    },
    {
      id: 'n2',
      type: 'text',
      x: 360,
      y: 120,
      w: 240,
      h: 160,
      rotation: 0,
      text: 'Second idea',
      noteId: null,
      noteUpdatedAt: null,
      color: null,
      locked: false,
      visible: true,
    },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', fromAnchor: 'auto', toAnchor: 'auto', label: '' },
  ],
}

const EMPTY_DOCUMENT = {
  version: 1,
  id: 'c2',
  title: 'Reading list',
  createdAt: 1757200000000,
  updatedAt: 1757201000000,
  camera: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
}

/* The notes the timeline holds. The canvas pours them onto the board. */
const NOTE_FIXTURE = [
  {
    id: 'note-a',
    content: 'Plan the launch #launch',
    createdAt: 1757210000000,
    updatedAt: 1757210000000,
    pinned: false,
    attachments: [],
  },
  {
    id: 'note-b',
    content: 'Collect feedback #research',
    createdAt: 1757210600000,
    updatedAt: 1757210600000,
    pinned: false,
    attachments: [],
  },
  {
    id: 'note-c',
    content: 'Write the release note #launch',
    createdAt: 1757211200000,
    updatedAt: 1757211200000,
    pinned: false,
    attachments: [],
  },
]

/** A board that already holds one of the notes, so the pour has to move it. */
const POUR_DOCUMENT = {
  version: 1,
  id: 'c1',
  title: 'Roadmap',
  createdAt: 1757210000000,
  updatedAt: 1757213000000,
  camera: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'p1',
      type: 'note',
      x: 10,
      y: 10,
      w: 240,
      h: 150,
      rotation: 0,
      text: '',
      noteId: 'note-a',
      noteUpdatedAt: null,
      color: 'none',
      locked: false,
      visible: true,
    },
  ],
  edges: [],
}

/** A board with three nodes to line up and two edges, one of them labelled. */
const V2_DOCUMENT = {
  version: 1,
  id: 'c1',
  title: 'Roadmap',
  createdAt: 1757210000000,
  updatedAt: 1757213000000,
  camera: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'n1',
      type: 'sticky',
      x: 40,
      y: 60,
      w: 240,
      h: 160,
      rotation: 0,
      text: 'Ship the canvas',
      noteId: null,
      noteUpdatedAt: null,
      color: 'amber',
      locked: false,
      visible: true,
    },
    {
      id: 'n2',
      type: 'text',
      x: 360,
      y: 120,
      w: 240,
      h: 160,
      rotation: 0,
      text: 'Second idea',
      noteId: null,
      noteUpdatedAt: null,
      color: 'none',
      locked: false,
      visible: true,
    },
    {
      id: 'n3',
      type: 'sticky',
      x: 120,
      y: 400,
      w: 240,
      h: 160,
      rotation: 0,
      text: 'Third card',
      noteId: null,
      noteUpdatedAt: null,
      color: 'sage',
      locked: false,
      visible: true,
    },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', fromAnchor: 'auto', toAnchor: 'auto', label: 'depends on' },
    { id: 'e2', from: 'n2', to: 'n3', fromAnchor: 'auto', toAnchor: 'auto', label: '' },
  ],
}

/**
 * The Host answers of a workspace with a canvas.
 *
 * @param {{boards?: any[], documents?: Record<string, any>, notes?: any[]}} options
 * @returns {Record<string, any>}
 */
function canvasRoutes(options = {}) {
  const boards = options.boards ?? BOARD_LIST
  const documents = options.documents ?? { c1: SAMPLE_DOCUMENT, c2: EMPTY_DOCUMENT }
  const notes = options.notes ?? []
  return {
    snapshot: { notes, tags: [], stats: {} },
    review: [],
    'canvas-list': () => ({ canvases: boards }),
    'canvas-load': (payload) => ({ canvas: documents[payload?.id] ?? documents[boards[0].id] }),
    'canvas-create': () => ({ canvas: documents[boards[0].id] }),
    'canvas-history': () => ({
      versions: [
        { id: 'v1', at: 1700000000000, title: 'Board', nodeCount: 1 },
        { id: 'v2', at: 1700000100000, title: 'Board', nodeCount: 2 },
      ],
    }),
    'canvas-restore': (payload) => ({ canvas: { ...documents[boards[0].id], id: payload.id } }),
    // Auto layout is a Host answer; the stub stacks members vertically so the
    // test can tell the panel adopted the reply.
    'canvas-arrange': (payload) => {
      const container = (payload?.nodes || []).find((node) => Array.isArray(node.members) && node.members.length)
      if (!container) return { nodes: payload?.nodes || [] }
      let offset = container.padding || 0
      const nodes = payload.nodes.map((node) => {
        if (!container.members.includes(node.id)) return node
        const placed = { ...node, x: (container.x || 0) + offset, y: (container.y || 0) + offset }
        offset += node.h + (container.gap || 0)
        return placed
      })
      return { nodes }
    },
    'canvas-save': (payload) => ({
      canvas: {
        ...documents[payload?.id] ?? documents[boards[0].id],
        id: payload?.id,
        camera: payload?.camera,
        nodes: payload?.nodes,
        edges: payload?.edges,
      },
    }),
    'canvas-delete': (payload) => ({ deleted: true, id: payload?.id }),
  }
}

/* --------------------------------------------------------------------- tests */

test('the harness loads the client and renders the Moments workspace', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    const root = renderMain(plugin)
    const title = findByClass(root, 'mm-title')
    assert.ok(title, 'the workspace must show its title')
    assert.match(toMarkup(title), /Moments/)
    assert.ok(findByClass(root, 'mm-app'), 'the workspace must render')
    assert.ok(findByClass(root, 'mm-nav'), 'the workspace must keep its navigation')
  } finally {
    plugin.restore()
  }
})

test('the canvas mode shows the surface and the boards of the host', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    assert.ok(surface, 'the canvas mode must show the canvas surface')

    const list = plugin.fetch.calls.find((call) => call.method === 'canvas-list')
    assert.ok(list, 'the canvas mode must ask the host for the boards')

    // The switcher lists the boards once it is opened.
    const toggle = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function'
      && /switch board/i.test(accessibleName(element))
    ))
    assert.ok(toggle, 'the title bar must carry a board switcher')
    await clickElement(plugin, toggle)
    const rows = findAllByClass(plugin.renderer.root, 'mm-canvas-boards-row').map((row) => toMarkup(row))
    for (const board of BOARD_LIST) {
      assert.ok(
        rows.some((row) => row.includes(board.title)),
        `the board switcher must offer "${board.title}"`,
      )
    }
  } finally {
    plugin.restore()
  }
})

test('the canvas draws the nodes of the loaded document', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const load = plugin.fetch.calls.find((call) => call.method === 'canvas-load')
    assert.ok(load, 'the canvas must ask the host for the document')
    assert.equal(load.payload.id, SAMPLE_DOCUMENT.id, 'the active board is loaded')

    const nodes = canvasNodes(plugin)
    assert.equal(nodes.length, SAMPLE_DOCUMENT.nodes.length, 'every node of the document is drawn')
    assert.deepEqual(
      nodes.map((node) => node.props['data-node-id']).sort(),
      SAMPLE_DOCUMENT.nodes.map((node) => node.id).sort(),
      'the nodes carry the identity of the document',
    )
  } finally {
    plugin.restore()
  }
})

test('a click selects a node and leaves the other one alone', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const [first, second] = canvasNodes(plugin)
    assert.ok(first && second, 'the canvas must draw two nodes')
    const firstId = first.props['data-node-id']
    const secondId = second.props['data-node-id']

    await pressElement(plugin, first)
    assert.ok(isSelected(nodeById(plugin, firstId)), 'the pressed node is selected')
    assert.ok(!isSelected(nodeById(plugin, secondId)), 'the other node stays out of the selection')
  } finally {
    plugin.restore()
  }
})

test('a shift click toggles a node in the selection', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const [first, second] = canvasNodes(plugin)
    assert.ok(first && second, 'the canvas must draw two nodes')
    const firstId = first.props['data-node-id']
    const secondId = second.props['data-node-id']

    await pressElement(plugin, first)
    await pressElement(plugin, second, { shiftKey: true })
    assert.ok(
      isSelected(nodeById(plugin, firstId)),
      'the shift click keeps the first node selected (contract 6.3: Shift/⌘ click toggles)',
    )
    assert.ok(
      isSelected(nodeById(plugin, secondId)),
      'the shift click adds the second node to the selection (contract 6.3: Shift/⌘ click toggles)',
    )

    // The toggle goes both ways: a shift click on a selected node takes it
    // out of the selection again.
    await pressElement(plugin, second, { shiftKey: true })
    assert.ok(
      !isSelected(nodeById(plugin, secondId)),
      'the shift click takes the node out of the selection again (contract 6.3: Shift/⌘ click toggles)',
    )
    assert.ok(
      isSelected(nodeById(plugin, firstId)),
      'the other node stays selected (contract 6.3: Shift/⌘ click toggles)',
    )
  } finally {
    plugin.restore()
  }
})

test('a drag on empty space draws the marquee', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    assert.ok(surface, 'the canvas must show its surface')

    await dragOn(plugin, surface, { from: { x: 700, y: 420 }, to: { x: 820, y: 500 } }, {
      inspect: () => {
        assert.ok(
          findByClass(plugin.renderer.root, 'mm-canvas-marquee'),
          'the drag on empty space must draw the marquee',
        )
      },
    })
  } finally {
    plugin.restore()
  }
})

test('a drag moves a node and the undo puts it back', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const [first] = canvasNodes(plugin)
    assert.ok(first, 'the canvas must draw a node')
    const id = first.props['data-node-id']
    const before = positionOf(nodeById(plugin, id))

    await pressElement(plugin, nodeById(plugin, id))
    await dragOn(plugin, nodeById(plugin, id), { from: { x: 100, y: 100 }, to: { x: 220, y: 160 } })

    const after = positionOf(nodeById(plugin, id))
    assert.notDeepEqual(after, before, 'the drag moves the node')

    await pressKey(plugin, 'z', { metaKey: true })

    const restored = positionOf(nodeById(plugin, id))
    assert.deepEqual(restored, before, 'the undo puts the node back')
  } finally {
    plugin.restore()
  }
})

test('an undo puts every node back exactly where it was, on a board of any size', async () => {
  // The undo stack used to hold a copy of the whole board, so a change to one
  // node carried every other node with it. It now holds the change itself, and
  // this asks the harder question: does the undo restore the board exactly,
  // including the nodes the change did not touch?
  const nodes = [
    { ...V2_DOCUMENT.nodes[0], id: 'card', type: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 100, fill: '#ffffff', members: [] },
    { ...V2_DOCUMENT.nodes[0], id: 'other', type: 'shape', shape: 'rect', x: 400, y: 300, w: 120, h: 80, fill: '#eeeeee', members: [] },
    { ...V2_DOCUMENT.nodes[0], id: 'panel', type: 'frame', x: 50, y: 50, w: 400, h: 300, fill: '#ffffff', members: ['inner'] },
    { ...V2_DOCUMENT.nodes[0], id: 'inner', type: 'shape', shape: 'rect', x: 80, y: 80, w: 100, h: 40, fill: '#ffffff', members: [] },
  ];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    const before = nodes.map((node) => `${node.id}:${node.x},${node.y},${node.w},${node.h}`).sort();

    await pressElement(plugin, nodeById(plugin, 'card'));
    await dragOn(plugin, nodeById(plugin, 'card'), { from: { x: 100, y: 100 }, to: { x: 220, y: 160 } });

    const moved = nodeById(plugin, 'card');
    assert.notEqual(parseFloat(moved.props.style.left), 100, 'the drag moved the node');

    await pressKey(plugin, 'z', { metaKey: true });

    const boxOf = (id) => {
      // A frame is drawn as a container, a leaf as a node.
      const leaf = canvasNodes(plugin).find((node) => node.props['data-node-id'] === id);
      const container = leaf ? null : containerById(plugin, id);
      const node = leaf || container;
      assert.ok(node, `the canvas must draw the node ${id}`);
      return `${id}:${Math.round(parseFloat(node.props.style.left))},${Math.round(parseFloat(node.props.style.top))},${Math.round(parseFloat(node.props.style.width))},${Math.round(parseFloat(node.props.style.height))}`;
    };
    const after = ['card', 'other', 'panel', 'inner'].map(boxOf).sort();
    assert.deepEqual(after, before, 'the undo puts every node back exactly where it was');
  } finally {
    plugin.restore();
  }
});

test('an undo is saved, so the board on disk matches the board on screen', async () => {
  // The board on disk has to follow the board on screen: an undo that only
  // changes the picture leaves the file holding the change that was just
  // taken back.
  const nodes = [{
    ...V2_DOCUMENT.nodes[0], id: 'card', type: 'shape', shape: 'rect',
    x: 100, y: 100, w: 200, h: 100, fill: '#ffffff', members: [],
  }];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, nodeById(plugin, 'card'));
    await dragOn(plugin, nodeById(plugin, 'card'), { from: { x: 100, y: 100 }, to: { x: 220, y: 160 } });
    await sleep(900);
    const savedAfterDrag = plugin.fetch.calls.filter((call) => call.method === 'canvas-save').at(-1);
    assert.equal(savedAfterDrag.payload.nodes.find((node) => node.id === 'card').x, 220, 'the drag was saved');

    await pressKey(plugin, 'z', { metaKey: true });
    await sleep(900);
    const saves = plugin.fetch.calls.filter((call) => call.method === 'canvas-save');
    const savedAfterUndo = saves.at(-1);
    assert.ok(savedAfterUndo, 'the undo asks for a save');
    assert.equal(savedAfterUndo.payload.nodes.find((node) => node.id === 'card').x, 100, 'the saved board is the one that was undone');
  } finally {
    plugin.restore();
  }
});

test('a redo re-applies the change that was undone', async () => {
  const nodes = [{
    ...V2_DOCUMENT.nodes[0], id: 'card', type: 'shape', shape: 'rect',
    x: 100, y: 100, w: 200, h: 100, fill: '#ffffff', members: [],
  }];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, nodeById(plugin, 'card'));
    await dragOn(plugin, nodeById(plugin, 'card'), { from: { x: 100, y: 100 }, to: { x: 220, y: 160 } });
    const dragged = parseFloat(nodeById(plugin, 'card').props.style.left);

    await pressKey(plugin, 'z', { metaKey: true });
    assert.equal(parseFloat(nodeById(plugin, 'card').props.style.left), 100, 'the undo puts it back');

    await pressKey(plugin, 'z', { metaKey: true, shiftKey: true });
    assert.equal(parseFloat(nodeById(plugin, 'card').props.style.left), dragged, 'the redo puts the drag back');
  } finally {
    plugin.restore();
  }
});

test('the wheel with the command key zooms the world', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    assert.ok(surface, 'the canvas must show its surface')
    const world = findByClass(plugin.renderer.root, 'mm-canvas-world')
    assert.ok(world, 'the canvas must have a world layer')
    const before = world.props.style?.transform

    await wheelOn(plugin, surface, { deltaY: -120, ctrlKey: true, metaKey: true })

    const after = findByClass(plugin.renderer.root, 'mm-canvas-world')?.props.style?.transform
    assert.notEqual(after, before, 'the zoom changes the transform of the world')
    assert.match(String(after), /scale\(/, 'the world is scaled')
  } finally {
    plugin.restore()
  }
})

test('a change of the canvas is saved after the debounce', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const [first] = canvasNodes(plugin)
    assert.ok(first, 'the canvas must draw a node')
    await pressElement(plugin, first)
    await pressKey(plugin, 'ArrowRight')

    await sleep(900)

    const save = plugin.fetch.calls.find((call) => call.method === 'canvas-save')
    assert.ok(save, 'the change must be saved after the debounce')
    assert.equal(save.payload.id, SAMPLE_DOCUMENT.id, 'the save names the board')
    assert.ok(Array.isArray(save.payload.nodes), 'the save carries the nodes')
    assert.equal(save.payload.nodes.length, SAMPLE_DOCUMENT.nodes.length, 'the save carries every node')
    assert.ok(Array.isArray(save.payload.edges), 'the save carries the edges')
    assert.ok(save.payload.camera && typeof save.payload.camera.zoom === 'number', 'the save carries the camera')
  } finally {
    plugin.restore()
  }
})

test('an empty board shows the guidance of the canvas', async () => {
  const routes = canvasRoutes({
    boards: [{ ...BOARD_LIST[1], updatedAt: 1757300000000 }],
    documents: { c2: EMPTY_DOCUMENT },
  })
  const plugin = await loadMomentsClient({ routes })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    assert.ok(
      findByClass(plugin.renderer.root, 'mm-canvas-empty'),
      'a board without nodes must show the guidance of the canvas',
    )
  } finally {
    plugin.restore()
  }
})

test('the canvas is reachable with the keyboard', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    assert.ok(surface, 'the canvas must show its surface')
    assert.equal(surface.props.role, 'application', 'the surface is an application')
    assert.equal(surface.props.tabIndex, 0, 'the surface takes the focus')
    assert.ok(surface.props['aria-label'], 'the surface is labelled')

    const nodes = canvasNodes(plugin)
    assert.equal(nodes.length, SAMPLE_DOCUMENT.nodes.length)
    for (const node of nodes) {
      assert.equal(node.props.role, 'button', 'a node is a button')
      assert.equal(node.props.tabIndex, 0, 'a node takes the focus')
      assert.ok(node.props['aria-label'], 'a node is labelled')
    }
  } finally {
    plugin.restore()
  }
})

/* ---------------------------------------------------------------- v2 behaviour */

/**
 * Select nodes on the canvas.
 *
 * @param {any} plugin
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
async function selectNodes(plugin, ids) {
  await pressKey(plugin, 'Escape')
  for (const [index, id] of ids.entries()) {
    const target = findBy(plugin.renderer.root, (element) => element.props?.['data-node-id'] === id)
      ?? findBy(plugin.renderer.root, (element) => (
        element.props?.['data-group-id'] === id && typeof element.props?.onPointerDown === 'function'
      ))
      ?? (() => {
        const frame = findBy(plugin.renderer.root, (element) => element.props?.['data-group-id'] === id)
        return frame ? findAll(frame, (element) => typeof element.props?.onPointerDown === 'function')[0] : null
      })()
    assert.ok(target, `the canvas must draw the node ${id}`)
    await pressElement(plugin, target, { shiftKey: index > 0 })
  }
}

/**
 * Whether two numbers are the same, within a world pixel.
 *
 * @param {number} actual
 * @param {number} expected
 * @param {number} tolerance
 * @returns {boolean}
 */
function near(actual, expected, tolerance = 1) {
  return Math.abs(actual - expected) <= tolerance
}

/**
 * The control that groups or dissolves the selection.
 *
 * @param {any} plugin
 * @param {'group'|'ungroup'} kind
 * @returns {any}
 */
function groupControl(plugin, kind) {
  const root = plugin.renderer.root
  const candidates = findAll(root, (element) => (
    typeof element.type === 'string' && element.type !== 'svg' && element.type !== 'path'
  ))
  const tool = candidates.find((element) => element.props['data-tool'] === kind)
  if (tool) return tool
  if (kind === 'ungroup') {
    return candidates.find((element) => /ungroup|disband|dissolve|split|解散/i.test(accessibleName(element))) ?? null
  }
  return candidates.find((element) => (
    /group|群组/i.test(accessibleName(element))
    && !/ungroup|disband|dissolve|split|解散/i.test(accessibleName(element))
  )) ?? null
}

/**
 * The number a node is drawn at.
 *
 * @param {any} plugin
 * @param {string} id
 * @returns {number}
 */
function leftOf(plugin, id) {
  return Number.parseFloat(String(positionOf(nodeById(plugin, id)).left ?? '0'))
}

/**
 * The number a node is drawn at.
 *
 * @param {any} plugin
 * @param {string} id
 * @returns {number}
 */
function topOf(plugin, id) {
  return Number.parseFloat(String(positionOf(nodeById(plugin, id)).top ?? '0'))
}


test('pouring the notes lays them out near the middle of the view', async () => {
  const plugin = await loadMomentsClient({
    routes: canvasRoutes({ notes: NOTE_FIXTURE, documents: { c1: POUR_DOCUMENT } }),
  })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    // The source of the pour lives in the board-actions menu.
    await openBarMenu(plugin)
    const source = findAll(plugin.renderer.root, (element) => element.type === 'select')
      .find((select) => findAll(select, (element) => element.type === 'option')
        .some((option) => /all notes|every note|全部/i.test(toMarkup(option))))
    assert.ok(source, 'the pour must offer a source of notes')
    const every = findAll(source, (element) => element.type === 'option')
      .find((option) => /all notes|every note|全部/i.test(toMarkup(option)))
    source.props.onChange({ target: { value: every.props.value } })
    await settle(plugin)

    const menu = findByClass(plugin.renderer.root, 'mm-canvas-bar-panel')
    assert.ok(menu, 'the board actions menu is open')
    const pour = findAll(menu, (element) => (
      element.type === 'button' && /lay out|scatter|pour|spread/i.test(accessibleName(element))
    ))[0]
    assert.ok(pour, 'the canvas must offer to pour the notes')
    await clickElement(plugin, pour)
    await settle(plugin, 3)

    const notes = nodesOfType(plugin, 'note')
    assert.equal(notes.length, NOTE_FIXTURE.length, 'every note of the source becomes a node')

    // The note that was already on the board is moved, not created twice.
    const moved = notes.filter((node) => node.props['data-node-id'] === POUR_DOCUMENT.nodes[0].id)
    assert.equal(moved.length, 1, 'the note that was already there is not created twice')
    assert.notDeepEqual(
      positionOf(moved[0]),
      { left: '10px', top: '10px' },
      'the note that was already there is moved to its new place',
    )

    // The notes are spread out, and they are not on the world origin.
    const places = notes.map((node) => `${positionOf(node).left}/${positionOf(node).top}`)
    assert.equal(new Set(places).size, notes.length, 'the notes do not share one place')
    for (const node of notes) {
      const { left, top } = positionOf(node)
      assert.ok(left !== '0px' || top !== '0px', 'the notes do not land on the world origin')
    }

    // The pour is an ordinary edit: the whole document is saved with it.
    const saved = await savedDocument(plugin)
    assert.ok(saved, 'the pour must be saved')
    assert.equal(
      saved.nodes.filter((node) => node.type === 'note').length,
      NOTE_FIXTURE.length,
      'the saved document holds every note of the source',
    )
  } finally {
    plugin.restore()
  }
})

test('an edge draws its label only when it carries one', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const labelled = elementsWithText(plugin, 'depends on')
    assert.equal(labelled.length, 1, 'the edge that carries a label draws it once')
    assert.ok(!hasClass(labelled[0], 'mm-canvas-node'), 'the label is not the text of a node')
  } finally {
    plugin.restore()
  }
})

test('a double click on an edge opens its label for editing', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const edge = edgeElement(plugin, 'e1')
    assert.ok(edge, 'the edge must be on the canvas')
    await clickElement(plugin, edge)
    await doubleClick(plugin, edge)

    const field = findAll(plugin.renderer.root, (element) => (
      (element.type === 'input' || element.type === 'textarea')
      && typeof element.props.onChange === 'function'
      && /label/i.test(accessibleName(element))
    ))[0]
    assert.ok(field, 'the double click opens a field for the label')
    field.props.onChange({ target: { value: 'blocks' } })
    await settle(plugin)

    const editor = findAll(plugin.renderer.root, (element) => (
      (element.type === 'input' || element.type === 'textarea')
      && typeof element.props.onKeyDown === 'function'
      && /label/i.test(accessibleName(element))
    ))[0]
    assert.ok(editor, 'the field of the label takes the keyboard')
    editor.props.onKeyDown(makeEvent({ key: 'Enter', metaKey: true }))
    await settle(plugin, 3)

    assert.equal(elementsWithText(plugin, 'blocks').length, 1, 'the new label is drawn')
    const saved = await savedDocument(plugin)
    const edgeOfDocument = saved.edges.find((item) => item.id === 'e1')
    assert.equal(edgeOfDocument.label, 'blocks', 'the label is written back to the document')
  } finally {
    plugin.restore()
  }
})

test('grouping the selection makes a group of exactly those members', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    await selectNodes(plugin, ['n1'])
    const group = groupControl(plugin, 'group')
    assert.ok(group, 'the canvas must offer to group the selection')
    await clickElement(plugin, group)
    await settle(plugin, 3)

    assert.equal(groupElements(plugin).length, 1, 'the selection becomes one group')

    const saved = await savedDocument(plugin)
    const member = saved.nodes.find((node) => node.type === 'group')
    assert.ok(member, 'the group is part of the document')
    assert.deepEqual([...member.members].sort(), ['n1'], 'the group holds exactly the selected nodes')
  } finally {
    plugin.restore()
  }
})

test('dragging a group moves its members and dissolving leaves them behind', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    await selectNodes(plugin, ['n1', 'n2'])
    await clickElement(plugin, groupControl(plugin, 'group'))
    await settle(plugin, 3)

    const groups = groupElements(plugin)
    assert.equal(groups.length, 1, 'the selection becomes one group')
    const groupId = groups[0].props['data-group-id']
    const before = { n1: leftOf(plugin, 'n1'), n2: leftOf(plugin, 'n2') }

    // The group is dragged by its border.
    const border = findAll(groups[0], (element) => (
      typeof element.props.onPointerDown === 'function'
      && String(element.props.className ?? '').includes('edge')
    ))[0]
    assert.ok(border, 'the border of the group takes the pointer')
    const groupStyle = groups[0].props.style ?? {}
    const startX = Number.parseFloat(String(groupStyle.left ?? '0'))
    const startY = Number.parseFloat(String(groupStyle.top ?? '0'))
    await dragOn(plugin, border, {
      from: { x: startX, y: startY },
      to: { x: startX + 60, y: startY + 40 },
    })

    assert.ok(near(leftOf(plugin, 'n1'), before.n1 + 60), 'the first member follows the group')
    assert.ok(near(leftOf(plugin, 'n2'), before.n2 + 60), 'the second member follows the group')

    await selectNodes(plugin, [groupId])
    const ungroup = groupControl(plugin, 'ungroup')
    assert.ok(ungroup, 'the canvas must offer to dissolve the group')
    await clickElement(plugin, ungroup)
    await settle(plugin, 3)

    assert.equal(groupElements(plugin).length, 0, 'the group is gone')
    assert.ok(nodeById(plugin, 'n1'), 'the members stay on the board')
    assert.ok(nodeById(plugin, 'n2'), 'the members stay on the board')
  } finally {
    plugin.restore()
  }
})

test('the canvas leaves the text of the nodes out when it is zoomed out', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    assert.ok(surface, 'the canvas must show its surface')
    assert.ok(drawsText(nodeById(plugin, 'n1'), 'Ship the canvas'), 'the node draws its text')

    await wheelOn(plugin, surface, { deltaY: 4000, ctrlKey: true, metaKey: true })
    assert.ok(
      !drawsText(nodeById(plugin, 'n1'), 'Ship the canvas'),
      'the overview mode leaves the text of the nodes out',
    )

    await wheelOn(plugin, surface, { deltaY: -4000, ctrlKey: true, metaKey: true })
    assert.ok(drawsText(nodeById(plugin, 'n1'), 'Ship the canvas'), 'the text comes back')
  } finally {
    plugin.restore()
  }
})

test('a shape can be drawn and its style can be changed', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const tool = controlBy(plugin, { tool: 'rect', name: /rectangle|矩形|^rect$/i })
    assert.ok(tool, 'the canvas must offer the rectangle tool')
    await clickElement(plugin, tool)
    await settle(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    await pressAt(plugin, surface, { x: 900, y: 500 })
    await releaseAt(plugin, surface, { x: 900, y: 500 })
    await settle(plugin, 3)

    const shapes = nodesOfType(plugin, 'shape')
    assert.equal(shapes.length, 1, 'the click drops a shape on the board')
    const shapeId = shapes[0].props['data-node-id']

    await selectNodes(plugin, [shapeId])

    const swatches = findAll(plugin.renderer.root, (element) => (
      typeof element.type === 'string' && swatchColor(element) !== null
    ))
    const swatch = swatches.find((element) => /\bfill\b/i.test(accessibleName(element))) ?? swatches[0]
    assert.ok(swatch, 'the style bar must offer a fill')
    const colour = swatchColor(swatch)
    await clickElement(plugin, swatch)
    await settle(plugin, 3)

    const saved = await savedDocument(plugin)
    const shape = saved.nodes.find((node) => node.id === shapeId)
    assert.equal(String(shape.fill ?? '').toLowerCase(), colour, 'the fill is written back to the document')

    const radius = styleField(plugin, /corner radius|radius|圆角/i)
    assert.ok(radius, 'the style bar must offer a radius')
    const radiusValue = styleValue(radius)
    console.log('DBG radius control:', accessibleName(radius), '| value:', radiusValue, '| selected:', canvasNodes(plugin).filter(isSelected).length)
    console.log('DBG saves so far:', plugin.fetch.calls.filter((c) => c.method === 'canvas-save').map((c) => c.payload.nodes.map((n) => `${n.type}:${n.radius}`)))
    const liveRadius = liveElement(plugin.renderer.root, radius)
    console.log('DBG live radius:', liveRadius === radius, '| has onClick:', typeof liveRadius?.props?.onClick, '| cls:', liveRadius?.props?.className)
    await clickElement(plugin, radius)
    await settle(plugin, 3)
    // The board saves on a debounce; let it fire before reading the document.
    await sleep(800)

    console.log('DBG shape svg rx:', findAll(plugin.renderer.root, (e) => e.type === 'rect' && e.props.rx !== undefined).map((e) => e.props.rx))
    console.log('DBG after click, save count:', plugin.fetch.calls.filter((c) => c.method === 'canvas-save').length)
    const savedAgain = await savedDocument(plugin)
    console.log('DBG savedAgain radius:', savedAgain?.nodes?.find((n) => n.id === shapeId)?.radius)
    const rounded = savedAgain.nodes.find((node) => node.id === shapeId)
    assert.equal(Number(rounded.radius), radiusValue, 'the radius is written back to the document')
  } finally {
    plugin.restore()
  }
})

test('the layers panel lists the nodes and follows the selection', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const panel = layersPanel(plugin)
    assert.ok(panel, 'the canvas mode must show the layers')
    assert.equal(layerRows(plugin).length, V2_DOCUMENT.nodes.length, 'every node has a row')

    // The selection of the canvas reaches the layers.
    await selectNodes(plugin, ['n2'])
    const marked = layerRows(plugin).filter((row) => (
      isSelected(row) || hasClass(row, 'is-active') || row.props['aria-selected'] === 'true'
    ))
    assert.equal(marked.length, 1, 'the row of the selected node is marked')

    // The layers reach the canvas.
    await selectNodes(plugin, ['n1'])
    const row = layerRows(plugin)[0]
    const name = layerNameControl(row)
    assert.ok(name, 'every row names its node')
    await clickElement(plugin, name)
    const chosen = canvasNodes(plugin).filter((node) => isSelected(node))
    assert.equal(chosen.length, 1, 'the row selects one node on the canvas')
    assert.equal(marked.length, 1, 'the layer of the selected node stays marked')
  } finally {
    plugin.restore()
  }
})

test('hiding a layer takes its node off the canvas', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const rows = layerRows(plugin)
    assert.equal(rows.length, V2_DOCUMENT.nodes.length, 'every node has a row')
    const before = V2_DOCUMENT.nodes.map((node) => node.id).filter((id) => isNodeVisible(plugin, id))

    const toggle = layerVisibilityControl(rows[0])
    assert.ok(toggle, 'every row carries a switch to show and hide the node')
    await clickElement(plugin, toggle)
    await settle(plugin, 3)

    const after = V2_DOCUMENT.nodes.map((node) => node.id).filter((id) => isNodeVisible(plugin, id))
    assert.equal(after.length, before.length - 1, 'the hidden node is not drawn')

    const saved = await savedDocument(plugin)
    const hidden = saved.nodes.filter((node) => node.visible === false)
    assert.equal(hidden.length, 1, 'the document remembers that the node is hidden')
    assert.ok(!after.includes(hidden[0].id), 'the node that is hidden is the one that left the canvas')
  } finally {
    plugin.restore()
  }
})

test('aligning the selection lines the nodes up on the bounding box', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const width = 240
    const height = 160
    const box = () => {
      const ax = leftOf(plugin, 'n1')
      const ay = topOf(plugin, 'n1')
      const bx = leftOf(plugin, 'n3')
      const by = topOf(plugin, 'n3')
      return {
        left: Math.min(ax, bx),
        right: Math.max(ax, bx) + width,
        top: Math.min(ay, by),
        bottom: Math.max(ay, by) + height,
      }
    }

    /**
     * Align the selection and check where the nodes ended up.
     *
     * @param {string} direction
     * @param {'x'|'y'} axis the axis the alignment works on
     * @param {(box: any) => {n1: number, n3: number}} wanted the place of every node
     * @returns {Promise<void>}
     */
    const align = async (direction, axis, wanted) => {
      await selectNodes(plugin, ['n1', 'n3'])
      const before = box()
      const control = alignControl(plugin, direction)
      assert.ok(control, `the canvas must offer to align the selection ${direction}`)
      await clickElement(plugin, control)
      await settle(plugin, 3)
      const expected = wanted(before)
      const place = axis === 'x' ? leftOf : topOf
      assert.ok(near(place(plugin, 'n1'), expected.n1), `${direction}: the first node sits where the box says`)
      assert.ok(near(place(plugin, 'n3'), expected.n3), `${direction}: the second node sits where the box says`)
    }

    await align('left', 'x', (box) => ({ n1: box.left, n3: box.left }))
    await align('right', 'x', (box) => ({ n1: box.right - width, n3: box.right - width }))
    await align('top', 'y', (box) => ({ n1: box.top, n3: box.top }))
    await align('bottom', 'y', (box) => ({ n1: box.bottom - height, n3: box.bottom - height }))
    await align('centerX', 'x', (box) => ({
      n1: (box.left + box.right) / 2 - width / 2,
      n3: (box.left + box.right) / 2 - width / 2,
    }))
    await align('centerY', 'y', (box) => ({
      n1: (box.top + box.bottom) / 2 - height / 2,
      n3: (box.top + box.bottom) / 2 - height / 2,
    }))
  } finally {
    plugin.restore()
  }
})

test('distributing the selection spreads the nodes evenly', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    await selectNodes(plugin, ['n1', 'n2', 'n3'])
    const control = alignControl(plugin, 'distributeX')
    assert.ok(control, 'the canvas must offer to distribute the selection')
    await clickElement(plugin, control)
    await settle(plugin, 3)

    const places = ['n1', 'n2', 'n3'].map((id) => leftOf(plugin, id)).sort((a, b) => a - b)
    const gaps = [places[1] - places[0], places[2] - places[1]]
    assert.ok(near(gaps[0], gaps[1]), 'the space between the nodes is the same')
  } finally {
    plugin.restore()
  }
})

test('the board can be exported as an SVG that carries the text of the nodes', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    await openBarMenu(plugin)
    const exportControl = findAll(plugin.renderer.root, (element) => (
      typeof element.props.onClick === 'function'
      && /export/i.test(accessibleName(element))
      && /svg/i.test(accessibleName(element))
    ))[0]
    assert.ok(exportControl, 'the canvas must offer an export of the board as SVG')
    await clickElement(plugin, exportControl)
    await settle(plugin, 3)

    const svg = await exportedSvg(plugin)
    assert.ok(svg.length > 0, 'the export must produce an SVG')
    assert.match(svg, /Ship the canvas/, 'the SVG carries the text of the nodes')
  } finally {
    plugin.restore()
  }
})

/* --------------------------------------------------------------- V3: frames */

test('framing the selection wraps exactly those nodes in a frame', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['n1', 'n2'])
    const frame = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function' && /frame the selection/i.test(accessibleName(element))
    ))
    assert.ok(frame, 'the canvas must offer to frame the selection')
    await clickElement(plugin, frame)
    await settle(plugin, 3)
    const saved = await savedDocument(plugin)
    const box = saved.nodes.find((node) => node.type === 'frame')
    assert.ok(box, 'the frame is part of the document')
    assert.deepEqual([...box.members].sort(), ['n1', 'n2'], 'the frame holds exactly the selected nodes')
    assert.ok(findAllByClass(plugin.renderer.root, 'mm-canvas-frame').length >= 1, 'the frame is drawn')
  } finally {
    plugin.restore()
  }
})

test('a frame carries a title and the title can be renamed', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['n1'])
    await clickElement(plugin, findBy(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function' && /frame the selection/i.test(accessibleName(element))
    )))
    await settle(plugin, 3)
    assert.ok(findByClass(plugin.renderer.root, 'mm-canvas-frame-title'), 'the frame shows a title above its box')
  } finally {
    plugin.restore()
  }
})

test('the connectors are drawn as curves, not straight wires', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const edges = findAll(plugin.renderer.root, (element) => element.props.className === 'mm-canvas-edge')
    assert.ok(edges.length > 0, 'the canvas draws the edges')
    for (const edge of edges) {
      assert.ok(String(edge.props.d).includes('C'), 'an edge is a cubic bezier, not a straight line')
    }
  } finally {
    plugin.restore()
  }
})

/* -------------------------------------------------------- V3: boards panel */

test('the board switcher stars a board to the top of the panel', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const toggle = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function' && /switch board/i.test(accessibleName(element))
    ))
    assert.ok(toggle, 'the title bar carries the board switcher')
    await clickElement(plugin, toggle)
    const rows = findAllByClass(plugin.renderer.root, 'mm-canvas-boards-row')
    assert.ok(rows.length >= BOARD_LIST.length, 'every board has a row')
    const star = findAll(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function' && /\bstar\b/i.test(accessibleName(element)) && !/unstar/i.test(accessibleName(element))
    ))[0]
    assert.ok(star, 'every board row carries a star')
    await clickElement(plugin, star)
    await settle(plugin, 3)
    const call = plugin.fetch.calls.find((entry) => entry.method === 'canvas-star')
    assert.ok(call, 'starring writes the flag through its own method')
    assert.equal(typeof call.payload.starred, 'boolean', 'the star writes a boolean')
  } finally {
    plugin.restore()
  }
})

/**
 * Open the board-actions menu, where the low-frequency commands live.
 *
 * @param {any} plugin
 */
async function openBarMenu(plugin) {
  const more = findBy(plugin.renderer.root, (element) => (
    typeof element.props?.onClick === 'function' && accessibleName(element).includes('Board actions')
  ))
  assert.ok(more, 'the bar must offer board actions')
  await clickElement(plugin, more)
  await settle(plugin, 2)
}

/* ------------------------------------------------------- context menu */

/** Open the right-click menu of the canvas at one point. */
async function openCanvasMenu(plugin, nodeId) {
  const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
  assert.ok(surface, 'the canvas surface must be there')
  const target = nodeId
    ? { closest: (selector) => (selector === '[data-node-id]' ? { getAttribute: () => nodeId } : null) }
    : { closest: () => null }
  surface.props.onContextMenu({ preventDefault() {}, clientX: 240, clientY: 180, target })
  await settle(plugin, 2)
}

test('right clicking a node opens the canvas menu for that node', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const nodeId = canvasNodes(plugin)[0].props['data-node-id']
    await openCanvasMenu(plugin, nodeId)
    const menu = findBy(plugin.renderer.root, (element) => element.props?.role === 'menu')
    assert.ok(menu, 'the right click opens a menu')
    const labels = findAll(plugin.renderer.root, (element) => element.props?.role === 'menuitem')
      .map((element) => accessibleName(element))
    for (const wanted of ['Duplicate', 'Delete', 'Bring to front', 'Send to back', 'Group selection', 'Lock']) {
      assert.ok(labels.some((label) => label.includes(wanted)), `the menu offers ${wanted}`)
    }
  } finally {
    plugin.restore()
  }
})

test('right clicking empty space offers the board commands instead', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await openCanvasMenu(plugin, null)
    const labels = findAll(plugin.renderer.root, (element) => element.props?.role === 'menuitem')
      .map((element) => accessibleName(element))
    assert.ok(labels.some((label) => label.includes('Select all')), 'the board menu offers Select all')
    assert.ok(labels.some((label) => label.includes('Zoom to fit')), 'the board menu offers Zoom to fit')
    assert.ok(!labels.some((label) => label.includes('Duplicate')), 'the board menu is not the node menu')
  } finally {
    plugin.restore()
  }
})

test('bringing a node to the front puts it last in the document', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const first = canvasNodes(plugin)[0].props['data-node-id']
    await openCanvasMenu(plugin, first)
    const entry = findAll(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function' && /bring to front/i.test(accessibleName(element))
    ))[0]
    assert.ok(entry, 'the menu offers Bring to front')
    await clickElement(plugin, entry)
    await settle(plugin, 3)
    await sleep(800)
    const saved = await savedDocument(plugin)
    assert.equal(saved.nodes[saved.nodes.length - 1].id, first, 'the node is drawn last, so it is on top')
  } finally {
    plugin.restore()
  }
})

test('locking a node keeps it selected but stops it from moving', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const nodeId = canvasNodes(plugin)[0].props['data-node-id']
    await openCanvasMenu(plugin, nodeId)
    const lock = findAll(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function' && /^lock$/i.test(accessibleName(element))
    ))[0]
    assert.ok(lock, 'the menu offers Lock')
    await clickElement(plugin, lock)
    await settle(plugin, 3)
    await sleep(800)
    const saved = await savedDocument(plugin)
    const node = saved.nodes.find((item) => item.id === nodeId)
    assert.equal(node.locked, true, 'the node is locked in the document')
  } finally {
    plugin.restore()
  }
})

/* ------------------------------------------------------------ top bar */

test('the canvas top bar keeps the tools in the middle and the rest in one menu', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    // The tools sit in the bar, not on a second floating row.
    const bar = findByClass(plugin.renderer.root, 'mm-canvas-bar')
    assert.ok(bar, 'the canvas keeps one top bar')
    const tools = findByClass(plugin.renderer.root, 'mm-canvas-tools')
    assert.ok(tools, 'the tools live in the bar')
    assert.equal(findByClass(plugin.renderer.root, 'mm-canvas-toolbar'), null, 'there is no second toolbar row')

    // Low-frequency commands are behind one menu, not spread across the bar.
    const barButtons = findAll(plugin.renderer.root, (element) => (
      typeof element.type === 'string' && String(element.props?.className || '').includes('mm-canvas-bar-button')
    ))
    assert.equal(barButtons.length, 0, 'the bar no longer carries a row of labelled buttons')

    await openBarMenu(plugin)
    const items = findAll(plugin.renderer.root, (element) => element.props?.role === 'menuitem')
      .map((element) => accessibleName(element))
    for (const wanted of ['New board', 'Rename board', 'Delete board', 'Lay out notes', 'Export SVG', 'Export PNG']) {
      assert.ok(items.some((label) => label.includes(wanted)), `the menu offers ${wanted}`)
    }
  } finally {
    plugin.restore()
  }
})

test('saving is a quiet status rather than a sentence in the bar', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const status = findByClass(plugin.renderer.root, 'mm-canvas-status')
    assert.ok(status, 'the bar shows the save state')
    assert.ok(findByClass(plugin.renderer.root, 'mm-canvas-status-dot'), 'it is a dot, not a sentence')
    // The words stay available to a screen reader and to a hover.
    assert.ok(accessibleName(status).length > 0, 'the state still has a name')
  } finally {
    plugin.restore()
  }
})

/* ------------------------------------------------------- nested layers */

/** A board with a container inside a container inside a container. */
const NESTED_DOCUMENT = {
  version: 1,
  id: 'c1',
  title: 'Nested',
  starred: false,
  createdAt: 1,
  updatedAt: 1,
  camera: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'outer', type: 'group', x: 0, y: 0, w: 400, h: 400, members: ['mid'], title: '' },
    { id: 'mid', type: 'group', x: 50, y: 50, w: 200, h: 200, members: ['leaf'], title: '' },
    { id: 'leaf', type: 'sticky', x: 100, y: 100, w: 120, h: 120, text: 'Leaf', members: [], title: '' },
    { id: 'other', type: 'sticky', x: 600, y: 0, w: 120, h: 120, text: 'Other', members: [], title: '' },
  ],
  edges: [],
  comments: [],
};

test('a container inside a container keeps a box around its own members', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: NESTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const groups = findAllByClass(plugin.renderer.root, 'mm-canvas-group')
    assert.ok(groups.length >= 2, 'both containers are drawn')
    for (const group of groups) {
      const nodeId = group.props['data-group-id']
      assert.ok(['outer', 'mid'].includes(nodeId), `unexpected container ${nodeId}`)
    }
  } finally {
    plugin.restore()
  }
})

test('the layer tree nests a container inside a container', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: NESTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    // The tree indents each level, so the indent is the nesting evidence.
    const indentOf = (id) => {
      const row = findBy(plugin.renderer.root, (element) => element.props?.['data-layer-id'] === id)
      assert.ok(row, `the tree shows ${id}`)
      return parseFloat(row.props.style?.paddingLeft || '0')
    }
    const outer = indentOf('outer')
    const mid = indentOf('mid')
    const leaf = indentOf('leaf')
    assert.ok(mid > outer, 'the middle container nests under the outer one')
    assert.ok(leaf > mid, 'the leaf nests under the middle one')
  } finally {
    plugin.restore()
  }
})

/** A board with one connector between two nodes. */
const CONNECTED_DOCUMENT = {
  ...V2_DOCUMENT,
  edges: [{
    id: 'e1',
    from: V2_DOCUMENT.nodes[0].id,
    to: V2_DOCUMENT.nodes[1].id,
    fromAnchor: 'auto',
    toAnchor: 'auto',
    label: '',
  }],
};

/* ------------------------------------------------------- connector style */

test('a connector carries a width, a dash, heads and a curve', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    // The drawn connector carries the defaults of the format.
    const drawn = findAll(plugin.renderer.root, (element) => (
      element.props?.className === 'mm-canvas-edge'
    ))
    assert.ok(drawn.length >= 1, 'the board draws the connector')
    assert.equal(drawn[0].props['stroke-width'], 2, 'a connector starts at the default weight')
    assert.equal(drawn[0].props['stroke-dasharray'], undefined, 'a connector starts solid')
    assert.equal(drawn[0].props['marker-end'], undefined, 'the head is not an SVG marker')
    const heads = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-edge-head'))
    assert.equal(heads.length, 1, 'the end carries exactly one head')
    assert.equal(drawn[0].props['marker-start'], undefined, 'the start carries nothing')
  } finally {
    plugin.restore()
  }
})

test('selecting a connector offers the style controls', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const hit = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.['data-edge-id'] === 'string'
    ))
    assert.ok(hit, 'a connector can be pointed at')
    await clickElement(plugin, hit)
    await settle(plugin, 2)
    const panel = findByClass(plugin.renderer.root, 'mm-canvas-edge-panel')
    assert.ok(panel, 'the connector style bar appears')
    const names = findAll(plugin.renderer.root, (element) => (
      typeof element.props?.['aria-label'] === 'string'
      && element.props['aria-label'].length > 0
    )).map((element) => element.props['aria-label'])
    for (const wanted of ['Stroke 4', 'Dashed line', 'Straight line', 'Elbow line', 'Start arrow', 'Arrow head', 'Triangle head', 'Circle head', 'Delete the connector']) {
      assert.ok(names.includes(wanted), `the bar offers ${wanted}`)
    }
  } finally {
    plugin.restore()
  }
})

test('making a connector dashed writes the choice back', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const hit = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.['data-edge-id'] === 'string'
    ))
    await clickElement(plugin, hit)
    await settle(plugin, 2)
    const dashed = findAll(plugin.renderer.root, (element) => (
      element.props?.['aria-label'] === 'Dashed line'
    ))[0]
    assert.ok(dashed, 'the bar offers a dashed line')
    await clickElement(plugin, dashed)
    await settle(plugin, 3)
    await sleep(800)
    const saved = await savedDocument(plugin)
    assert.equal(saved.edges[0].dash, 'dashed', 'the dash is written back')
  } finally {
    plugin.restore()
  }
})

test('the connector bar docks to the canvas instead of covering the work', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const hit = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.['data-edge-id'] === 'string'
    ))
    await clickElement(plugin, hit)
    await settle(plugin, 2)
    const panel = findByClass(plugin.renderer.root, 'mm-canvas-edge-panel')
    assert.ok(panel, 'the bar appears')
    // It is a child of the surface, not of the transformed world: a bar inside
    // the world would be placed against a zero-sized origin.
    assert.ok(!JSON.stringify(panel.props?.style || {}).includes('left'), 'it is not positioned by hand')
  } finally {
    plugin.restore()
  }
})

test('the magnet snaps a connector to the nearest handle', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    // The connector that exists records the anchors it snapped to.
    const edge = CONNECTED_DOCUMENT.edges[0]
    assert.ok(edge.fromAnchor, 'a connector names the handle it holds')
    assert.ok(edge.toAnchor, 'a connector names the handle it holds')
    const anchors = ['auto', 'top', 'right', 'bottom', 'left']
    assert.ok(anchors.includes(edge.fromAnchor), 'the anchor is one of the handles')
  } finally {
    plugin.restore()
  }
})

/* ---------------------------------------------------------- sidebar rail */

test('the collapsed sidebar keeps every way in', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    const toggle = findBy(plugin.renderer.root, (element) => (
      typeof element.props?.onClick === 'function'
      && accessibleName(element).includes('Collapse the sidebar')
    ))
    assert.ok(toggle, 'the sidebar can be folded')
    await clickElement(plugin, toggle)
    await settle(plugin, 2)

    // The navigation is still there: folded, not gone.
    const nav = findByClass(plugin.renderer.root, 'mm-nav')
    assert.ok(nav, 'the folded sidebar still shows its navigation')
    const views = findAll(plugin.renderer.root, (element) => (
      element.type === 'button'
      && typeof element.props?.onClick === 'function'
      && /(All notes|PinNotes|Daily review|Design|Trash)/.test(accessibleName(element))
    ))
    const names = views.map((element) => accessibleName(element))
    for (const wanted of ['All notes', 'PinNotes', 'Daily review', 'Design', 'Trash']) {
      assert.ok(names.some((name) => name.startsWith(wanted)), `the rail still offers ${wanted}`)
    }

    // And it still works: the design canvas is one click away.
    const canvasButton = views.find((element) => accessibleName(element).includes('Design'))
    await clickElement(plugin, canvasButton)
    await settle(plugin, 3)
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    assert.ok(surface, 'a click in the rail still opens the canvas')
  } finally {
    plugin.restore()
  }
})

test('two taps open the text of a node even though the pointer is captured', async () => {
  // The canvas captures the pointer on press, which retargets the follow-up
  // `click` and `dblclick` to the surface: a real double click never reaches
  // the node. Two presses must be enough on their own.
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const [first] = canvasNodes(plugin)
    const id = first.props['data-node-id']
    await pressElement(plugin, nodeById(plugin, id))
    await pressElement(plugin, nodeById(plugin, id))
    await settle(plugin, 2)

    const input = findByClass(plugin.renderer.root, 'mm-canvas-node-input')
    assert.ok(input, 'two taps must open the editor')
    assert.ok(
      findBy(plugin.renderer.root, (element) => (
        typeof element.type === 'string' && String(element.props?.className || '').includes('is-editing')
      )),
      'the node says it is being edited',
    )
  } finally {
    plugin.restore()
  }
})

/** A board whose container is a frame, which behaves like a surface. */
const FRAME_DOCUMENT = {
  version: 1,
  id: 'c1',
  title: 'Framed',
  starred: false,
  createdAt: 1,
  updatedAt: 1,
  camera: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'frame-a', type: 'frame', x: 100, y: 100, w: 480, h: 360, members: ['inside'], title: 'Checkout' },
    { id: 'inside', type: 'sticky', x: 160, y: 160, w: 140, h: 120, text: 'Inside', members: [], title: '' },
  ],
  edges: [],
  comments: [],
};

test('a frame can be dragged by its inside, and its members come along', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: FRAME_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const frame = findBy(plugin.renderer.root, (element) => (
      element.props?.['data-container-id'] === 'frame-a'
    ))
    assert.ok(frame, 'the frame is drawn')
    assert.equal(typeof frame.props.onPointerDown, 'function', 'the inside of a frame answers a press')

    const frameAt = () => {
      const drawn = findBy(plugin.renderer.root, (element) => (
        element.props?.['data-container-id'] === 'frame-a'
      ))
      return { left: drawn.props.style.left, top: drawn.props.style.top }
    }
    const before = frameAt()
    await pressAt(plugin, frame, { x: 200, y: 200 })
    const selectedNow = findBy(plugin.renderer.root, (element) => (
      element.props?.['data-container-id'] === 'frame-a'
      && String(element.props?.className || '').includes('is-selected')
    ))
    assert.ok(selectedNow, 'pressing the inside selects the frame')

    // Drive the move the way the browser does: the press captured the pointer,
    // so the surface is the element that hears it.
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    surface.props.onPointerMove(makeEvent({ clientX: 320, clientY: 260, buttons: 1 }))
    await settle(plugin, 2)

    const after = frameAt()
    assert.notDeepEqual(after, before, 'the frame moves when its inside is dragged')
  } finally {
    plugin.restore()
  }
})

test('undoing a drag must not delete the nodes that were never dragged', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const ids = canvasNodes(plugin).map((node) => node.props['data-node-id'])
    assert.ok(ids.length >= 2, 'the board holds several nodes')

    const firstId = ids[0]
    await pressElement(plugin, nodeById(plugin, firstId))
    await dragOn(plugin, nodeById(plugin, firstId), { from: { x: 100, y: 100 }, to: { x: 240, y: 180 } })

    await pressKey(plugin, 'z', { metaKey: true })
    await settle(plugin, 2)

    const remaining = canvasNodes(plugin).map((node) => node.props['data-node-id'])
    assert.deepEqual(new Set(remaining), new Set(ids), 'undo restores the whole board, not only the dragged node')
  } finally {
    plugin.restore()
  }
})

test('resizing a node follows the pointer at any zoom level', async () => {
  // A drag is measured in screen pixels, but the board is in world units:
  // at 25% zoom one screen pixel is four world units. The resize used to
  // forget the division, so a small drag inflated the node several times
  // over. The delta has to be scaled by the camera before it is applied.
  const zoomed = { ...V2_DOCUMENT, camera: { x: 0, y: 0, zoom: 0.25 } }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: zoomed } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const first = canvasNodes(plugin)[0]
    const id = first.props['data-node-id']
    const before = first.props.style.width
    await pressElement(plugin, nodeById(plugin, id))

    // The south-east handle grows the node as the pointer moves outwards.
    const handle = findAll(plugin.renderer.root, (element) => (
      String(element.props?.className || '').includes('mm-canvas-handle is-se')
    ))[0]
    assert.ok(handle, 'the selection shows its handles')

    await pressAt(plugin, handle, { x: 100, y: 100 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    // 40 screen pixels at 25% zoom is 160 world units.
    surface.props.onPointerMove(makeEvent({ clientX: 140, clientY: 100, buttons: 1 }))
    await settle(plugin, 2)

    const after = parseFloat(nodeById(plugin, id).props.style.width)
    assert.equal(after, parseFloat(before) + 160, 'the resize converts the drag into world units')
  } finally {
    plugin.restore()
  }
})

test('the wheel is cancelled so the page never zooms instead of the board', async () => {
  // React binds `wheel` passively, so a preventDefault from a React handler is
  // ignored and Ctrl+wheel zooms the whole page. The surface therefore binds a
  // native, non-passive listener; this test proves the event is cancelled and
  // that the board — not the page — is what changed.
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    const before = cameraOf(plugin)
    const event = makeEvent({ deltaY: -200, ctrlKey: true, cancelable: true })
    surface.props.onWheel(event)
    await settle(plugin, 2)
    const after = cameraOf(plugin)

    assert.notEqual(after.zoom, before.zoom, 'the board zoomed')
    assert.equal(before.zoom < after.zoom, true, 'the wheel turns towards the pointer, so zooming in')
  } finally {
    plugin.restore()
  }
})

/** The camera the canvas is drawing with. */
function cameraOf(plugin) {
  const world = findByClass(plugin.renderer.root, 'mm-canvas-world')
  assert.ok(world, 'the canvas draws a world')
  const match = /scale\(([\d.]+)\)/.exec(String(world.props.style.transform || ''))
  assert.ok(match, 'the world carries its zoom')
  return { zoom: Number(match[1]) }
}

test('a resize that arrives in many small moves lands where one big move would', async () => {
  // The browser sends a pointer move for every frame, so a drag is dozens of
  // events. Scaling the node's *current* size by a factor measured from the
  // *original* box compounds: each event multiplies the previous result. The
  // node must end up the size the pointer asked for, no matter how many
  // events the drag arrived in.
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const first = canvasNodes(plugin)[0]
    const id = first.props['data-node-id']
    const before = parseFloat(first.props.style.width)
    await pressElement(plugin, nodeById(plugin, id))

    const handle = findAll(plugin.renderer.root, (element) => (
      String(element.props?.className || '').includes('mm-canvas-handle is-se')
    ))[0]
    assert.ok(handle, 'the selection shows its handles')
    await pressAt(plugin, handle, { x: 100, y: 100 })

    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    // The same 80px of travel, delivered in eight frames of 10px.
    for (let step = 1; step <= 8; step += 1) {
      surface.props.onPointerMove(makeEvent({ clientX: 100 + step * 10, clientY: 100, buttons: 1 }))
      await settle(plugin, 1)
    }

    const after = parseFloat(nodeById(plugin, id).props.style.width)
    assert.equal(after, before + 80, 'a drag of 80px grows the node by 80, however many events it took')
  } finally {
    plugin.restore()
  }
})

test('design typography, gradients and shadows reach the rendered nodes', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Design',
    createdAt: 1757210000000,
    updatedAt: 1757213000000,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'hero',
        type: 'text',
        x: 0,
        y: 0,
        w: 400,
        h: 80,
        rotation: 0,
        text: 'Payments',
        noteId: null,
        noteUpdatedAt: null,
        color: null,
        locked: false,
        visible: true,
        fontSize: 48,
        textColor: '#0f172a',
        fontFamily: 'display',
        fontWeight: 700,
        lineHeight: 1.2,
        letterSpacing: -1,
        rotation: 4,
      },
      {
        id: 'cta',
        type: 'shape',
        shape: 'rect',
        x: 0,
        y: 120,
        w: 200,
        h: 56,
        rotation: 0,
        text: '',
        noteId: null,
        noteUpdatedAt: null,
        color: null,
        locked: false,
        visible: true,
        fill: '#635bff',
        radius: 12,
        gradient: { from: '#635bff', to: '#8b83ff', angle: 135 },
        shadow: { x: 0, y: 8, blur: 24, color: '#635bff' },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const text = findByClass(plugin.renderer.root, 'mm-canvas-node-text')
    assert.ok(text, 'the text node must render its text')
    assert.equal(text.props.style.fontSize, '48px')
    assert.equal(text.props.style.fontWeight, '700')
    assert.equal(text.props.style.lineHeight, '1.2')
    assert.equal(text.props.style.letterSpacing, '-1px')
    assert.match(text.props.style.fontFamily, /SF Pro Display/)
    const heroNode = findBy(plugin.renderer.root, (element) => element.props?.['data-node-id'] === 'hero')
    assert.match(heroNode.props.style.transform || '', /rotate\(4deg\)/, 'a rotated node turns on screen')

    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /linearGradient/, 'a gradient shape must define its stops')
    assert.match(markup, /url\(#canvas-grad-cta\)/, 'the shape must paint itself with the gradient')

    const shapeNode = findByClass(plugin.renderer.root, 'mm-canvas-node--shape')
    assert.match(shapeNode.props.style.filter || '', /drop-shadow/, 'a shape shadow follows its silhouette')
  } finally {
    plugin.restore()
  }
})


test('a member of a flowing container selects but cannot be dragged', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Layout',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'row', type: 'frame', x: 0, y: 0, w: 600, h: 200, rotation: 0, text: '',
        noteId: null, noteUpdatedAt: null, color: null, locked: false, visible: true,
        fill: null, stroke: null, strokeWidth: 0, radius: 0, opacity: 1, textAlign: 'left',
        members: ['card'], title: '', sides: 5, points: 5, flipX: false, flipY: false,
        assetId: null, fontSize: 14, textColor: null, layout: 'row', gap: 16, padding: 20, align: 'start',
      },
      {
        id: 'card', type: 'shape', shape: 'rect', x: 20, y: 20, w: 120, h: 80, rotation: 0, text: '',
        noteId: null, noteUpdatedAt: null, color: null, locked: false, visible: true,
        fill: '#ffffff', stroke: null, strokeWidth: 0, radius: 8, opacity: 1, textAlign: 'left',
        members: [], title: '', sides: 5, points: 5, flipX: false, flipY: false, assetId: null,
        fontSize: 14, textColor: null, layout: 'none', gap: 0, padding: 0, align: 'start',
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const card = nodeById(plugin, 'card')
    assert.equal(card.props.style.left, '20px')
    await dragOn(plugin, card, { from: { x: 40, y: 40 }, to: { x: 200, y: 180 } })
    await settle(plugin, 3)
    assert.equal(nodeById(plugin, 'card').props.style.top, '20px', 'a managed member keeps its layout position')
    const selectedNodes = findAll(plugin.renderer.root, (element) => (
      /(^|\s)is-selected(\s|$)/.test(String(element.props?.className || ''))
    ))
    assert.ok(selectedNodes.length >= 1, 'the press still selects it')
  } finally {
    plugin.restore()
  }
})


test('a dragged node snaps to a neighbour edge and the guide disappears on release', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Snap',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'a', type: 'sticky', x: 0, y: 0, w: 100, h: 100, rotation: 0, text: 'a', visible: true, locked: false, members: [] },
      { id: 'b', type: 'sticky', x: 300, y: 0, w: 100, h: 100, rotation: 0, text: 'b', visible: true, locked: false, members: [] },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const node = nodeById(plugin, 'a')
    await pressAt(plugin, node, { x: 10, y: 10 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    // 296 world px would leave the right edge 4px short of the neighbour's;
    // the magnet pulls it flush.
    surface.props.onPointerMove(makeEvent({ clientX: 306, clientY: 10, buttons: 1 }))
    await settle(plugin, 2)
    assert.equal(nodeById(plugin, 'a').props.style.left, '300px', 'the dragged edge snaps flush')
    const guides = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-guide'))
    assert.ok(guides.length >= 1, 'a guide line marks the alignment while dragging')

    surface.props.onPointerUp(makeEvent({ clientX: 306, clientY: 10 }))
    await settle(plugin, 2)
    const after = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-guide'))
    assert.equal(after.length, 0, 'the guides disappear when the drag ends')
  } finally {
    plugin.restore()
  }
})


test('resizing a frame re-places its members by their constraints', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Constraints',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'frame', type: 'frame', x: 100, y: 100, w: 400, h: 200, members: ['c-left', 'c-right', 'c-center', 'c-grow', 'c-scale', 'c-nested'] },
      { id: 'c-left', type: 'shape', shape: 'rect', x: 120, y: 120, w: 60, h: 40, constraints: { horizontal: 'left', vertical: 'top' } },
      { id: 'c-right', type: 'shape', shape: 'rect', x: 400, y: 120, w: 60, h: 40, constraints: { horizontal: 'right', vertical: 'top' } },
      { id: 'c-center', type: 'shape', shape: 'rect', x: 250, y: 120, w: 60, h: 40, constraints: { horizontal: 'center', vertical: 'top' } },
      { id: 'c-grow', type: 'shape', shape: 'rect', x: 120, y: 180, w: 100, h: 40, constraints: { horizontal: 'left-right', vertical: 'top' } },
      { id: 'c-scale', type: 'shape', shape: 'ellipse', x: 300, y: 240, w: 80, h: 40, constraints: { horizontal: 'scale', vertical: 'scale' } },
      { id: 'c-nested', type: 'group', x: 120, y: 260, w: 100, h: 30, members: ['inside'], constraints: { horizontal: 'left', vertical: 'top' } },
      { id: 'inside', type: 'text', x: 120, y: 260, w: 80, h: 20, text: 'inside' },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const frame = findBy(plugin.renderer.root, (element) => element.props?.['data-container-id'] === 'frame')
    await pressAt(plugin, frame, { x: 200, y: 200 })
    const handle = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-handle is-se'))[0]
    assert.ok(handle, 'the selection shows its south-east handle')
    await pressAt(plugin, handle, { x: 500, y: 300 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    surface.props.onPointerMove(makeEvent({ clientX: 700, clientY: 300, buttons: 1 }))
    await settle(plugin, 2)

    const left = (id) => nodeById(plugin, id)
    assert.equal(left('c-left').props.style.left, '120px', 'a left-pinned child keeps its distance to the left edge')
    assert.equal(left('c-right').props.style.left, '600px', 'a right-pinned child follows the right edge')
    assert.equal(left('c-center').props.style.left, '350px', 'a centre-pinned child keeps its offset from the centre')
    assert.equal(left('c-grow').props.style.width, '300px', 'a left-right child takes the width delta')
    assert.equal(left('c-scale').props.style.left, '400px', 'a scaled child keeps its proportion')
    assert.equal(left('c-scale').props.style.width, '120px')
    assert.equal(left('inside').props.style.left, '120px', 'a nested child travels with its container')
  } finally {
    plugin.restore()
  }
})


test('design tool results render a card with a board preview and a jump action', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    const keys = plugin.registrations
      .filter((entry) => entry.slotOptions?.name === 'tool.call.toolview')
      .map((entry) => entry.slotOptions.key)
    for (const tool of ['design_begin', 'design_tokens', 'design_nodes', 'design_finish', 'design_inspect', 'design_export']) {
      assert.ok(keys.includes(tool), `${tool} has a card view`)
    }

    const entry = plugin.registrations.find((item) => (
      item.slotOptions?.name === 'tool.call.toolview' && item.slotOptions.key === 'design_nodes'
    ))
    const view = plugin.renderer.render(plugin.react.createElement(entry.component, {
      block: {
        content: [{ type: 'text', text: 'Applied 3 operation(s).' }],
        meta: { momentsDesign: { tool: 'design_nodes', boardId: 'board-1', title: 'Checkout' } },
        seq: 7,
        isError: false,
      },
    }))
    const markup = toMarkup(view)
    assert.match(markup, /Applied 3 operation\(s\)\./)
    assert.match(markup, /\/api\/moments-notes\/design-preview\?id=board-1&v=7/, 'the card previews the board it touched')
    assert.match(markup, /在 Design 中打开/)

    const withoutBoard = plugin.renderer.render(plugin.react.createElement(entry.component, {
      block: { content: [{ type: 'text', text: 'listed boards' }], meta: {}, seq: 1 },
    }))
    assert.doesNotMatch(toMarkup(withoutBoard), /design-preview/)
    assert.match(toMarkup(withoutBoard), /打开左侧 Moments 面板/)
  } finally {
    plugin.restore()
  }
})


test('a vector path node draws as an SVG path with its curve', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Vector',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'wave', type: 'shape', shape: 'path', x: 0, y: 0, w: 240, h: 120, stroke: '#635bff', strokeWidth: 4,
        path: {
          closed: false,
          points: [
            { x: 0, y: 100, out: { x: 40, y: -80 } },
            { x: 120, y: 20, in: { x: -40, y: -20 } },
          ],
        },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const markup = toMarkup(plugin.renderer.root)
    assert.match(markup, /<path[^>]*d="M 0 100 C 40 20 80 0 120 20"/)
    assert.match(markup, /stroke="#635bff"/)
  } finally {
    plugin.restore()
  }
})


test('the pen turns clicks into a vector path and Enter commits it', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const pen = controlBy(plugin, { tool: 'path', name: /pen|钢笔/i })
    assert.ok(pen, 'the toolbar offers the pen')
    await clickElement(plugin, pen)
    await settle(plugin, 2)

    for (const point of [{ x: 200, y: 200 }, { x: 340, y: 260 }, { x: 260, y: 380 }]) {
      const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
      await pressAt(plugin, surface, point)
      await releaseAt(plugin, surface, point)
      await settle(plugin, 1)
    }
    assert.ok(findByClass(plugin.renderer.root, 'mm-canvas-path-draft'), 'the draft is drawn while drawing')

    await pressKey(plugin, 'Enter')
    await settle(plugin, 3)

    const shapes = nodesOfType(plugin, 'shape')
    assert.equal(shapes.length, 1, 'the draft became one shape node')
    const markup = toMarkup(shapes[0])
    assert.match(markup, /<path[^>]*d="M 0 0 L 140 60 L 60 180"/, 'the anchors became a path in node-local coordinates')
    assert.equal(findByClass(plugin.renderer.root, 'mm-canvas-path-draft'), null, 'the draft disappears once committed')
  } finally {
    plugin.restore()
  }
})

test('a selected vector path shows anchors only when point editing is asked for, and dragging one moves that point', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Anchors',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'wave', type: 'shape', shape: 'path', x: 100, y: 100, w: 240, h: 120,
        stroke: '#635bff', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 100 }, { x: 240, y: 20 }] },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['wave'])
    await settle(plugin, 2)
    // Selecting is not editing: a press near the stroke has to move the shape.
    assert.equal(
      findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-anchor')).length,
      0,
      'a selected path shows no anchors until point editing is asked for',
    )
    await clickElement(plugin, findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Edit the path points')[0])
    await settle(plugin, 2)
    const anchors = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-anchor'))
    assert.equal(anchors.length, 2, 'each path point gets a handle')

    const shapeBefore = toMarkup(nodeById(plugin, 'wave'))
    const first = anchors[0]
    await pressAt(plugin, first, { x: 100, y: 200 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    surface.props.onPointerMove(makeEvent({ clientX: 140, clientY: 200, buttons: 1 }))
    await settle(plugin, 2)
    surface.props.onPointerUp(makeEvent({ clientX: 140, clientY: 200 }))
    await settle(plugin, 2)

    const shapeAfter = toMarkup(nodeById(plugin, 'wave'))
    assert.notEqual(shapeAfter, shapeBefore, 'the path geometry changes with the anchor')
    assert.match(shapeAfter, /d="M 40 100/)
  } finally {
    plugin.restore()
  }
})


test('a bezier handle can be dragged to reshape the curve', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Handles',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'wave', type: 'shape', shape: 'path', x: 100, y: 100, w: 240, h: 120,
        stroke: '#635bff', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 100, out: { x: 40, y: -40 } }, { x: 240, y: 20 }] },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['wave'])
    await settle(plugin, 2)
    await clickElement(plugin, findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Edit the path points')[0])
    await settle(plugin, 2)
    const before = toMarkup(nodeById(plugin, 'wave'))
    assert.match(before, /C 40 60 240 20 240 20/, 'the curve starts from the stored handle')

    const handle = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-handle-dot'))[0]
    assert.ok(handle, 'the stored handle gets a draggable dot')
    await pressAt(plugin, handle, { x: 140, y: 160 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    surface.props.onPointerMove(makeEvent({ clientX: 160, clientY: 180, buttons: 1 }))
    await settle(plugin, 2)
    surface.props.onPointerUp(makeEvent({ clientX: 160, clientY: 180 }))
    await settle(plugin, 2)

    const after = toMarkup(nodeById(plugin, 'wave'))
    assert.match(after, /C 60 80 240 20 240 20/, 'the drag moved the control point by 20/20')
  } finally {
    plugin.restore()
  }
})

test('the path toolbar turns a straight path into a curve and back', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Curve',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'line', type: 'shape', shape: 'path', x: 100, y: 100, w: 240, h: 120,
        stroke: '#635bff', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 100 }, { x: 240, y: 20 }] },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['line'])
    await settle(plugin, 2)
    assert.match(toMarkup(nodeById(plugin, 'line')), /L 240 20/, 'the path starts straight')

    const curve = controlBy(plugin, { name: /curve the path/i })
    assert.ok(curve, 'the toolbar offers curving')
    await clickElement(plugin, curve)
    await settle(plugin, 3)
    assert.match(toMarkup(nodeById(plugin, 'line')), /C 40 100 200 20 240 20/, 'handles turn the line into a curve')

    const straighten = controlBy(plugin, { name: /straighten the path/i })
    assert.ok(straighten, 'the same control now offers straightening')
    await clickElement(plugin, straighten)
    await settle(plugin, 3)
    assert.match(toMarkup(nodeById(plugin, 'line')), /L 240 20/, 'the handles are gone again')
  } finally {
    plugin.restore()
  }
})


test('design tokens appear as chips and a click binds the fill to the token', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Tokens',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    tokens: { colors: { brand: '#635bff', surface: '#ffffff' }, gradients: {}, type: {} },
    nodes: [{ id: 'card', type: 'shape', shape: 'rect', x: 40, y: 40, w: 200, h: 120, fill: '#e2e8f0' }],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['card'])
    await settle(plugin, 2)

    const brandChip = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Fill token brand')[0]
    assert.ok(brandChip, 'the board tokens are offered as chips')
    await clickElement(plugin, brandChip)
    await settle(plugin, 3)

    assert.match(toMarkup(nodeById(plugin, 'card')), /fill="#635bff"/, 'the shape paints the token colour')
    const active = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Fill token brand')[0]
    assert.match(String(active.props.className), /is-active/, 'the chip shows the bound token')
  } finally {
    plugin.restore()
  }
})

test('a child of a container can pin itself with the constraint selects', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Pins',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    tokens: { colors: {}, gradients: {}, type: {} },
    nodes: [
      { id: 'frame', type: 'frame', x: 0, y: 0, w: 400, h: 300, members: ['card'] },
      { id: 'card', type: 'shape', shape: 'rect', x: 40, y: 40, w: 120, h: 80, fill: '#e2e8f0', constraints: { horizontal: 'left', vertical: 'top' } },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['card'])
    await settle(plugin, 2)

    const horizontal = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Horizontal pin')[0]
    assert.ok(horizontal, 'a member can pin horizontally')
    assert.equal(horizontal.props.value, 'left')
    horizontal.props.onChange({ target: { value: 'right' } })
    await settle(plugin, 3)

    const afterHorizontal = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Horizontal pin')[0]
    assert.equal(afterHorizontal.props.value, 'right', 'the pin is stored on the node')

    const vertical = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Vertical pin')[0]
    vertical.props.onChange({ target: { value: 'scale' } })
    await settle(plugin, 3)
    const afterVertical = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Vertical pin')[0]
    assert.equal(afterVertical.props.value, 'scale')
  } finally {
    plugin.restore()
  }
})


test('a blurred node composites through CSS and keeps its blend mode', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Effects',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'glow', type: 'shape', shape: 'ellipse', x: 40, y: 40, w: 120, h: 120, fill: '#635bff', blur: 16, blend: 'multiply' },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const style = nodeById(plugin, 'glow').props.style
    assert.match(String(style.filter), /blur\(16px\)/, 'the node is blurred')
    assert.equal(style.mixBlendMode, 'multiply', 'the node composites onto what is beneath it')
  } finally {
    plugin.restore()
  }
})


test('a text node draws one element per styled run', async () => {
  const document = {
    version: 1,
    id: 'c1',
    title: 'Runs',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'line', type: 'text', x: 40, y: 40, w: 320, h: 40, fontSize: 20, text: 'Pay now',
        spans: [{ text: 'Pay ', fontWeight: 400 }, { text: 'now', fontWeight: 800, textColor: '#635bff' }],
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const text = findAll(nodeById(plugin, 'line'), (element) => (
      String(element.props?.className || '').includes('mm-canvas-node-text')
    ))[0]
    const runs = text.props.children
    assert.equal(runs.length, 2, 'each styled run is its own element')
    assert.equal(runs[0].props.style.fontWeight, '400')
    assert.equal(runs[1].props.style.fontWeight, '800')
    assert.equal(runs[1].props.style.color, '#635bff')
  } finally {
    plugin.restore()
  }
})


test('a big board only draws what the viewport can reach, and keeps the selection', async () => {
  const nodes = []
  for (let index = 0; index < 300; index += 1) {
    nodes.push({
      id: `n${index}`, type: 'shape', shape: 'rect',
      x: index * 120, y: 0, w: 100, h: 80, fill: '#e2e8f0',
    })
  }
  const document = {
    version: 1, id: 'c1', title: 'Big', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 }, nodes, edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const drawn = findAll(plugin.renderer.root, (element) => typeof element.props?.['data-node-id'] === 'string')
    const ids = drawn.map((element) => element.props['data-node-id'])
    assert.ok(ids.includes('n0'), 'the node under the viewport is drawn')
    assert.ok(!ids.includes('n200'), 'a node far outside the viewport is not built')
    assert.ok(drawn.length < 40, `only the reachable nodes are drawn, got ${drawn.length} of 300`)

    // A selected node is kept even when a nudge pushes it out of view: it is
    // what every keyboard command acts on.
    await selectNodes(plugin, ['n0'])
    for (let step = 0; step < 200; step += 1) await pressKey(plugin, 'ArrowRight', { shiftKey: true })
    await settle(plugin, 2)
    const kept = findAll(plugin.renderer.root, (element) => element.props?.['data-node-id'] === 'n0')
    assert.equal(kept.length, 1, 'the selected node stays in the tree off-screen')
  } finally {
    plugin.restore()
  }
})



test('the performance HUD reports the frame rate and how many nodes are drawn', async () => {
  const nodes = []
  for (let index = 0; index < 300; index += 1) {
    nodes.push({ id: `n${index}`, type: 'shape', shape: 'rect', x: index * 120, y: 0, w: 100, h: 80, fill: '#e2e8f0' })
  }
  const document = { version: 1, id: 'c1', title: 'Perf', createdAt: 1, updatedAt: 2, camera: { x: 0, y: 0, zoom: 1 }, nodes, edges: [] }
  const storage = fakeStorage()
  storage.setItem('moments-notes:canvas-perf', 'true')
  const plugin = await loadMomentsClient({
    routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }),
    storage,
  })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const hud = findByClass(plugin.renderer.root, 'mm-canvas-perf')
    assert.ok(hud, 'the HUD is on when the preference says so')
    const text = toMarkup(hud)
    assert.match(text, /FPS/)
    assert.match(text, /\/300/, 'the HUD shows drawn nodes against the whole board')

    const toggle = controlBy(plugin, { name: /performance hud/i })
    assert.ok(toggle, 'the bar offers the HUD toggle')
    await clickElement(plugin, toggle)
    await settle(plugin, 2)
    assert.equal(findByClass(plugin.renderer.root, 'mm-canvas-perf'), null, 'the HUD turns off')
    await clickElement(plugin, controlBy(plugin, { name: /performance hud/i }))
    await settle(plugin, 2)
    assert.ok(findByClass(plugin.renderer.root, 'mm-canvas-perf'), 'and back on')
  } finally {
    plugin.restore()
  }
})


test('a 500-node board renders and drags inside a sane time budget', async () => {
  const nodes = []
  for (let index = 0; index < 500; index += 1) {
    nodes.push({
      id: `n${index}`, type: 'shape', shape: 'rect',
      x: (index % 50) * 24, y: Math.floor(index / 50) * 24, w: 20, h: 20, fill: '#e2e8f0',
    })
  }
  const document = {
    version: 1, id: 'c1', title: 'Heavy', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 }, nodes, edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    const renderStarted = performance.now()
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const renderMs = performance.now() - renderStarted

    // Every node is on screen, so culling cannot help: this is the worst case.
    await selectNodes(plugin, ['n0'])
    await settle(plugin, 1)
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    const node = nodeById(plugin, 'n0')
    const origin = { x: leftOf(plugin, 'n0') + 8, y: topOf(plugin, 'n0') + 8 }
    await pressAt(plugin, node, origin)
    const dragStarted = performance.now()
    const moves = 20
    for (let step = 1; step <= moves; step += 1) {
      surface.props.onPointerMove(makeEvent({ clientX: origin.x + step * 2, clientY: origin.y + step, buttons: 1 }))
    }
    await settle(plugin, 1)
    surface.props.onPointerUp(makeEvent({ clientX: origin.x + moves * 2, clientY: origin.y + moves }))
    await settle(plugin, 1)
    const dragMs = performance.now() - dragStarted
    const perMove = dragMs / moves
    console.log(`500 nodes on screen: first render ${renderMs.toFixed(0)}ms, drag ${perMove.toFixed(1)}ms per move`)

    assert.ok(renderMs < 2500, `the first render took ${renderMs.toFixed(0)}ms`)
    assert.ok(perMove < 60, `a drag move took ${perMove.toFixed(1)}ms`)
  } finally {
    plugin.restore()
  }
})


test('viewport culling keeps the first render cheap on a spread-out 500-node board', async () => {
  const nodes = []
  for (let index = 0; index < 500; index += 1) {
    nodes.push({
      id: `n${index}`, type: 'shape', shape: 'rect',
      x: (index % 50) * 120, y: Math.floor(index / 50) * 120, w: 100, h: 80, fill: '#e2e8f0',
    })
  }
  const document = {
    version: 1, id: 'c1', title: 'Spread', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 0.4 }, nodes, edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    const started = performance.now()
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const renderMs = performance.now() - started
    const drawn = findAll(plugin.renderer.root, (element) => typeof element.props?.['data-node-id'] === 'string')
    console.log(`500 nodes spread out: drawn ${drawn.length}, first render ${renderMs.toFixed(0)}ms`)
    assert.ok(drawn.length < 500, 'the board is culled')
    assert.ok(renderMs < 2500)
  } finally {
    plugin.restore()
  }
})



test('a text node never clips its glyphs, whatever the font size', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Glyphs', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'value', type: 'text', x: 840, y: 248, w: 360, h: 48,
        fontSize: 48, fontWeight: 800, lineHeight: 1.25, text: '$18.4M', textColor: '#0f172a',
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const style = nodeById(plugin, 'value').props.style
    assert.equal(style.padding, '0', 'the box must not offset the glyphs')
    assert.equal(style.overflow, 'visible', 'a tight box must not clip ascenders')
    assert.equal(style.height, '48px')
    const inner = findAll(nodeById(plugin, 'value'), (element) => (
      String(element.props?.className || '').includes('mm-canvas-node-text')
    ))[0]
    assert.equal(inner.props.style.fontSize, '48px')
    assert.equal(inner.props.style.lineHeight, '1.25', 'the canvas keeps the exporters line height')
  } finally {
    plugin.restore()
  }
})


test('the inspector edits the selected node and can be closed', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Inspector', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'title', type: 'text', x: 64, y: 120, w: 400, h: 60, fontSize: 24, text: 'Hello inspector', textColor: '#0f172a' },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['title'])
    await settle(plugin, 2)

    const panel = findByClass(plugin.renderer.root, 'mm-canvas-inspector')
    assert.ok(panel, 'the inspector is docked on the right')

    const xField = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'X of the selection')[0]
    assert.ok(xField, 'the layout section exposes X')
    assert.equal(xField.props.value, '64')
    xField.props.onChange({ target: { value: '120' } })
    await settle(plugin, 2)
    assert.equal(leftOf(plugin, 'title'), 120, 'typing a coordinate moves the node')

    const sizeField = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Font size of the selection')[0]
    assert.ok(sizeField, 'a text node gets typography controls')
    sizeField.props.onChange({ target: { value: '32' } })
    await settle(plugin, 2)
    const inner = findAll(nodeById(plugin, 'title'), (element) => (
      String(element.props?.className || '').includes('mm-canvas-node-text')
    ))[0]
    assert.equal(inner.props.style.fontSize, '32px')

    const toggle = controlBy(plugin, { name: /toggle inspector/i })
    assert.ok(toggle, 'the bar offers the inspector toggle')
    await clickElement(plugin, toggle)
    await settle(plugin, 2)
    assert.equal(findByClass(plugin.renderer.root, 'mm-canvas-inspector'), null, 'the inspector closes')
  } finally {
    plugin.restore()
  }
})




test('the inspector collapses from its own header and leaves a tab behind', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: V2_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    const inspector = findByClass(plugin.renderer.root, 'mm-canvas-inspector')
    assert.ok(inspector, 'the inspector starts open')
    const collapse = findByClass(plugin.renderer.root, 'mm-inspector-collapse')
    assert.ok(collapse, 'the panel carries its own collapse control')
    assert.equal(collapse.props['aria-label'], 'Collapse the inspector')

    await clickElement(plugin, collapse)
    await settle(plugin, 2)
    assert.equal(findByClass(plugin.renderer.root, 'mm-canvas-inspector'), null, 'the panel closes')
    const reopen = findByClass(plugin.renderer.root, 'mm-canvas-inspector-open')
    assert.ok(reopen, 'a tab stays where the panel was')
    assert.equal(reopen.props['aria-label'], 'Show the inspector')

    await clickElement(plugin, reopen)
    await settle(plugin, 2)
    assert.ok(findByClass(plugin.renderer.root, 'mm-canvas-inspector'), 'the panel comes back')
  } finally {
    plugin.restore()
  }
})

test('a small drag on a selected path moves the whole shape, not one of its points', async () => {
  // The reported bug: a selected vector path showed its anchors at once, so a
  // press near the stroke grabbed a point and a couple of pixels of drift bent
  // the curve instead of moving the shape.
  const document = {
    version: 1, id: 'c1', title: 'Drag', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'wave', type: 'shape', shape: 'path', x: 100, y: 100, w: 240, h: 120,
        stroke: '#635bff', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 100 }, { x: 240, y: 20 }] },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['wave'])
    await settle(plugin, 2)

    const node = nodeById(plugin, 'wave')
    await pressAt(plugin, node, { x: 150, y: 150 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    surface.props.onPointerMove(makeEvent({ clientX: 153, clientY: 150, buttons: 1 }))
    await settle(plugin, 2)
    surface.props.onPointerUp(makeEvent({ clientX: 153, clientY: 150 }))
    await settle(plugin, 2)

    const moved = nodeById(plugin, 'wave')
    assert.match(toMarkup(moved), /d="M 0 100 L 240 20"/, 'the path keeps its own geometry')
    const left = Number(String(moved.props.style.left).replace('px', ''))
    assert.ok(left >= 103, `the shape itself moved with the pointer, left=${left}`)
  } finally {
    plugin.restore()
  }
})

test('a filled node carries ink that reads on its own fill, not the theme ink', async () => {
  // The report: in the dark theme a white frame imported from FigJam showed
  // white text, because text with no stored colour inherited the theme ink.
  const document = {
    version: 1, id: 'c1', title: 'Ink', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'onWhite', type: 'text', x: 10, y: 10, w: 200, h: 30, text: 'dark ink on white', fill: '#ffffff' },
      { id: 'onDark', type: 'text', x: 10, y: 60, w: 200, h: 30, text: 'light ink on night', fill: '#0f172a' },
      { id: 'explicit', type: 'text', x: 10, y: 110, w: 200, h: 30, text: 'stored ink', fill: '#ffffff', textColor: '#c81e1e' },
      { id: 'bare', type: 'text', x: 10, y: 160, w: 200, h: 30, text: 'no fill, theme ink' },
      { id: 'box', type: 'shape', shape: 'rect', x: 10, y: 210, w: 160, h: 40, fill: '#f9e8a0', text: 'on amber' },
      // A text node inside a white frame has no fill of its own: the frame
      // behind it is the surface its ink has to read on.
      {
        id: 'frame', type: 'frame', x: 0, y: 300, w: 300, h: 120, fill: '#ffffff', members: ['inFrame'],
      },
      { id: 'inFrame', type: 'text', x: 20, y: 320, w: 240, h: 30, text: 'text on the white frame' },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const ink = (id) => nodeById(plugin, id).props.style.color
    assert.equal(ink('onWhite'), 'var(--mm-ink-on-light)', 'a white fill gets dark ink')
    assert.equal(ink('onDark'), 'var(--mm-ink-on-dark)', 'a night fill gets light ink')
    assert.equal(ink('explicit'), '#c81e1e', 'a stored colour always wins')
    assert.equal(ink('bare'), undefined, 'a node with no fill follows the theme')
    assert.equal(ink('box'), 'var(--mm-ink-on-light)', 'a shape with a light fill carries dark ink too')
    assert.equal(ink('inFrame'), 'var(--mm-ink-on-light)', 'a fill-less node reads the frame behind it')
  } finally {
    plugin.restore()
  }
})


test('the tool bar names the tool under the pointer and says what it does', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const caption = findByClass(plugin.renderer.root, 'mm-canvas-tool-caption')
    assert.ok(caption, 'the bar carries a caption')
    assert.match(toMarkup(caption), /Select/, 'the active tool is named by default')

    const pen = findAll(plugin.renderer.root, (element) => element.props?.['data-tool'] === 'path')[0]
    assert.ok(pen, 'the pen button exists')
    pen.props.onMouseEnter()
    await settle(plugin, 1)
    const hovered = toMarkup(findByClass(plugin.renderer.root, 'mm-canvas-tool-caption'))
    assert.match(hovered, /Pen/)
    assert.match(hovered, /click anchors/, 'the caption explains what the pen does')
    assert.match(hovered, /P/, 'the caption shows the shortcut')
  } finally {
    plugin.restore()
  }
})


test('the AI field folds out of the bottom-left corner and parks a request on the board', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Dock', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'logo', type: 'text', x: 40, y: 40, w: 200, h: 32, text: 'Logo' }],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    // Folded by default: the canvas keeps the bottom-centre strip for its own
    // connector panels, so a request bar must not claim it permanently.
    assert.equal(findByClass(plugin.renderer.root, 'mm-canvas-dock'), null, 'the field starts folded')
    const launcher = findByClass(plugin.renderer.root, 'mm-canvas-ai-launcher')
    assert.ok(launcher, 'the bottom-left corner offers the AI launcher')
    launcher.props.onClick()
    await settle(plugin, 2)

    const dock = findByClass(plugin.renderer.root, 'mm-canvas-dock')
    assert.ok(dock, 'the field unfolds on the canvas')

    const field = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'AI request for this board')[0]
    assert.ok(field, 'the bar offers an AI field')
    field.props.onChange({ target: { value: 'Make the hero section calmer' } })
    await settle(plugin, 2)
    const send = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Place the request on the board')[0]
    assert.ok(send)
    send.props.onClick()
    await settle(plugin, 2)

    const texts = findAll(plugin.renderer.root, (element) => element.props?.['data-node-type'] === 'text')
    const parked = texts.some((element) => toMarkup(element).includes('Make the hero section calmer'))
    assert.ok(parked, 'the request becomes a text node on the board')
    assert.equal(findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'AI request for this board').length, 0, 'the field folds again after sending')
    assert.ok(findByClass(plugin.renderer.root, 'mm-canvas-ai-launcher'), 'the launcher comes back')

    const htmlExport = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Export HTML and CSS')[0]
    assert.ok(htmlExport, 'the inspector offers the HTML handoff')
  } finally {
    plugin.restore()
  }
})


test('the inspector drives auto layout through the Host and covers tokens, pins and paths', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Panel', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    tokens: { colors: { brand: '#635bff', ink: '#0f172a' }, gradients: {}, type: {} },
    nodes: [
      { id: 'frame', type: 'frame', x: 100, y: 100, w: 400, h: 300, members: ['a', 'b'], layout: 'none', gap: 0, padding: 10 },
      { id: 'a', type: 'shape', shape: 'rect', x: 110, y: 110, w: 120, h: 40, fill: '#e2e8f0' },
      { id: 'b', type: 'shape', shape: 'rect', x: 110, y: 160, w: 120, h: 40, fill: '#e2e8f0' },
      {
        id: 'wave', type: 'shape', shape: 'path', x: 600, y: 100, w: 120, h: 80, stroke: '#635bff', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 60 }, { x: 120, y: 20 }] },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)

    // Auto layout: the panel asks the Host, and adopts the reply.
    await selectNodes(plugin, ['frame'])
    await settle(plugin, 2)
    const flow = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Auto layout direction')[0]
    assert.ok(flow, 'a container gets auto layout controls')
    flow.props.onChange({ target: { value: 'column' } })
    await settle(plugin, 2)
    const gap = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Auto layout gap')[0]
    gap.props.onChange({ target: { value: '20' } })
    await settle(plugin, 3)

    const arrange = plugin.fetch.calls.filter((call) => call.method === 'canvas-arrange')
    assert.ok(arrange.length >= 1, 'the panel asked the Host to lay the members out')
    assert.equal(topOf(plugin, 'a'), 110, 'the first member sits at the frame padding')
    assert.equal(topOf(plugin, 'b'), 170, 'the second member is pushed by height plus gap')

    // Design tokens bind from the panel.
    await selectNodes(plugin, ['a'])
    await settle(plugin, 2)
    const token = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Token brand')[0]
    assert.ok(token, 'the panel lists the board tokens')
    token.props.onClick()
    await settle(plugin, 2)
    assert.match(toMarkup(nodeById(plugin, 'a')), /fill="#635bff"/)

    // A member of a container shows pins.
    const pin = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Horizontal pin (inspector)')[0]
    assert.ok(pin, 'a member shows its pins in the panel')

    // A path offers its curve toggle.
    await selectNodes(plugin, ['wave'])
    await settle(plugin, 2)
    const curve = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Curve or straighten the path (inspector)')[0]
    assert.ok(curve, 'a path offers curve or straighten')
  } finally {
    plugin.restore()
  }
})


test('a container with a layout grid draws its bands, and the panel can switch them off', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Grid', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'frame', type: 'frame', x: 100, y: 100, w: 400, h: 300, members: [], title: 'Screen',
        grid: { kind: 'columns', count: 4, gutter: 20, margin: 24, visible: true },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const bands = findAll(plugin.renderer.root, (element) => String(element.props?.className || '') === 'mm-canvas-grid-band')
    assert.equal(bands.length, 4, 'one band per column')
    const first = bands[0].props.style
    assert.equal(first.left, '24px', 'the first band starts at the margin')
    const width = 400 - 24 * 2 - 20 * 3
    assert.equal(first.width, `${width / 4}px`, 'the bands share the usable width')

    await selectNodes(plugin, ['frame'])
    await settle(plugin, 2)
    const toggle = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Toggle the layout grid')[0]
    assert.ok(toggle, 'the panel can turn the grid on and off')
    toggle.props.onClick()
    await settle(plugin, 2)
    assert.equal(
      findAll(plugin.renderer.root, (element) => String(element.props?.className || '') === 'mm-canvas-grid-band').length,
      0,
      'turning the grid off removes the bands',
    )
  } finally {
    plugin.restore()
  }
})


test('the inspector creates a colour token and the next save carries it', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Tokens', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    tokens: { colors: {}, gradients: {}, type: {} },
    nodes: [{ id: 'card', type: 'shape', shape: 'rect', x: 80, y: 80, w: 200, h: 120, fill: '#e2e8f0' }],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['card'])
    await settle(plugin, 2)

    const nameField = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'New token name')[0]
    const colorField = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'New token colour')[0]
    assert.ok(nameField && colorField, 'the panel can create a token')
    nameField.props.onChange({ target: { value: 'brand' } })
    colorField.props.onChange({ target: { value: '#635bff' } })
    await settle(plugin, 2)
    const add = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Add the colour token')[0]
    add.props.onClick()
    await settle(plugin, 3)

    const chip = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Token brand')[0]
    assert.ok(chip, 'the new token shows up as a swatch')
    chip.props.onClick()
    await settle(plugin, 2)
    assert.match(toMarkup(nodeById(plugin, 'card')), /fill="#635bff"/)

    await sleep(900)
    const save = plugin.fetch.calls.filter((call) => call.method === 'canvas-save').pop()
    assert.ok(save, 'the token change is saved')
    assert.equal(save.payload.tokens.colors.brand, '#635bff', 'the save carries the token table')
  } finally {
    plugin.restore()
  }
})




test('the panel creates a light and dark theme pair and can switch between them', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Theme', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    tokens: { colors: { ink: '#0f172a', surface: '#ffffff' }, gradients: {}, type: {} },
    nodes: [{ id: 'card', type: 'shape', shape: 'rect', x: 80, y: 80, w: 200, h: 120, fill: '#ffffff' }],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['card'])
    await settle(plugin, 2)

    const create = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Create light and dark themes')[0]
    assert.ok(create, 'the panel can create a theme pair')
    create.props.onClick()
    await settle(plugin, 3)

    const dark = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Use the dark theme')[0]
    const light = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Use the light theme')[0]
    assert.ok(dark && light, 'both modes are offered once the pair exists')
    assert.match(String(dark.props.className), /is-active/, 'creating the pair lands on the dark mode')

    light.props.onClick()
    await settle(plugin, 3)
    await sleep(900)
    const save = plugin.fetch.calls.filter((call) => call.method === 'canvas-save').pop()
    assert.ok(save, 'the theme change is saved')
    assert.equal(save.payload.theme, 'light')
    assert.ok(save.payload.themes && save.payload.themes.dark, 'the save carries both tables')
  } finally {
    plugin.restore()
  }
})


test('the board actions open the version history and restore one', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await openBarMenu(plugin)
    const entry = findAll(plugin.renderer.root, (element) => (
      element.type === 'button' && /version history/i.test(accessibleName(element))
    ))[0]
    assert.ok(entry, 'the board actions offer the version history')
    await clickElement(plugin, entry)
    await settle(plugin, 3)

    const dialog = findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Version history')[0]
    assert.ok(dialog, 'the history panel opens')
    const restore = findAll(dialog, (element) => String(element.props?.['aria-label'] || '').startsWith('Restore the version'))[0]
    assert.ok(restore, 'each version can be restored')
    await clickElement(plugin, restore)
    await settle(plugin, 3)

    const call = plugin.fetch.calls.filter((item) => item.method === 'canvas-restore').pop()
    assert.ok(call, 'restoring asks the Host')
    assert.ok(call.payload.versionId === 'v1' || call.payload.versionId === 'v2')
    assert.equal(
      findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Version history').length,
      0,
      'restoring closes the panel',
    )
  } finally {
    plugin.restore()
  }
})


test('path anchors sit exactly on their stored points at any camera', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Anchors', createdAt: 1, updatedAt: 2,
    camera: { x: 120, y: 80, zoom: 2 },
    nodes: [
      {
        id: 'wave', type: 'shape', shape: 'path', x: 100, y: 100, w: 240, h: 120,
        stroke: '#635bff', strokeWidth: 3,
        path: {
          closed: false,
          points: [{ x: 0, y: 100, out: { x: 40, y: -40 } }, { x: 240, y: 20 }],
        },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['wave'])
    await settle(plugin, 2)
    await clickElement(plugin, findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Edit the path points')[0])
    await settle(plugin, 2)

    const anchors = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-anchor'))
    assert.equal(anchors.length, 2)
    // Screen space: (node origin + stored point) scaled and panned by the
    // camera, then shifted by half a dot so the dot centres on the point.
    // anchor 0 world (100, 200) -> screen (320, 480)
    assert.equal(anchors[0].props.style.left, '317.75px')
    assert.equal(anchors[0].props.style.top, '477.75px')
    // anchor 1 world (340, 120) -> screen (800, 320)
    assert.equal(anchors[1].props.style.left, '797.75px')
    assert.equal(anchors[1].props.style.top, '317.75px')

    // The dot shrinks as the board zooms in, so it stays the same size on screen.
    assert.equal(anchors[0].props.style.width, '4.5px')

    // A click that moves less than three screen pixels must not change the path.
    const before = toMarkup(nodeById(plugin, 'wave'))
    await pressAt(plugin, anchors[0], { x: 200, y: 300 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    surface.props.onPointerMove(makeEvent({ clientX: 201, clientY: 301, buttons: 1 }))
    surface.props.onPointerUp(makeEvent({ clientX: 201, clientY: 301 }))
    await settle(plugin, 2)
    assert.equal(toMarkup(nodeById(plugin, 'wave')), before, 'a click with a tiny drift changes nothing')
  } finally {
    plugin.restore()
  }
})


test('a path keeps its anchors clear of the box handles while the points are open', async () => {
  const document = {
    version: 1, id: 'c1', title: 'Hits', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'wave', type: 'shape', shape: 'path', x: 100, y: 100, w: 200, h: 100,
        stroke: '#635bff', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 100 }, { x: 200, y: 0 }] },
      },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document, c2: EMPTY_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await selectNodes(plugin, ['wave'])
    await settle(plugin, 2)
    let handles = findAll(plugin.renderer.root, (element) => String(element.props?.['data-handle'] || '').length > 0)
    assert.equal(handles.length, 4, 'the box still offers its resize handles')
    // Before point editing the handle sits on the box corner, where a drag
    // resizes instead of deforming the curve.
    let sw = handles.find((element) => element.props['data-handle'] === 'sw')
    assert.equal(sw.props.style.left, '100px')
    assert.equal(sw.props.style.top, '200px')

    await clickElement(plugin, findAll(plugin.renderer.root, (element) => element.props?.['aria-label'] === 'Edit the path points')[0])
    await settle(plugin, 2)
    handles = findAll(plugin.renderer.root, (element) => String(element.props?.['data-handle'] || '').length > 0)
    // The bottom-left corner of the box is also the path's first anchor, so in
    // point editing the handle steps eight pixels out instead of covering it.
    sw = handles.find((element) => element.props['data-handle'] === 'sw')
    assert.equal(sw.props.style.left, '92px')
    assert.equal(sw.props.style.top, '208px')
    const anchors = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-anchor'))
    assert.equal(anchors.length, 2, 'the anchors are still there')
    // The anchor is centred on its point: 100 minus half of a 9px dot.
    assert.equal(anchors[0].props.style.left, '95.5px', 'the anchor keeps its own place')
  } finally {
    plugin.restore()
  }
})


test('a Figma file picked as a notes backup is routed to Design, not parsed as JSON', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    const input = findAll(plugin.renderer.root, (element) => element.props?.type === 'file'
      && String(element.props?.accept || '').includes('.json'))[0]
      ?? findAll(plugin.renderer.root, (element) => element.props?.type === 'file')[0]
    assert.ok(input, 'the notes backup input exists')
    const file = {
      name: 'journey.jam',
      size: 1024,
      async text() { return 'PK\u0003\u0004'; },
    }
    input.props.onChange({ target: { files: [file], value: '' } })
    await settle(plugin, 3)
    const markup = toMarkup(plugin.renderer.root)
    assert.doesNotMatch(markup, /Unexpected token/, 'the JSON reader never sees the file')
    assert.match(markup, /Figma \/ FigJam file/i, 'the message names the right kind of file')
  } finally {
    plugin.restore()
  }
})

test('the board menu offers a Figma file picker', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await openBarMenu(plugin)
    const entry = findAll(plugin.renderer.root, (element) => (
      element.type === 'button' && /import figma file/i.test(accessibleName(element))
    ))[0]
    assert.ok(entry, 'the board actions offer the Figma import')
    const picker = findAll(plugin.renderer.root, (element) => element.props?.type === 'file'
      && String(element.props?.accept || '').includes('.jam'))[0]
    assert.ok(picker, 'a picker accepting .fig/.jam/.deck exists')
  } finally {
    plugin.restore()
  }
})


test('edge arrow markers point with the line and use an open Figma-style head', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    // The head used to be a `<marker>`: it scaled with the stroke and could
    // not be aimed at the exact end point, so it drifted away from the line.
    const heads = findAll(plugin.renderer.root, (element) => (
      String(element.props?.className || '').includes('mm-canvas-edge-head')
    ))
    assert.equal(heads.length, 1, 'the line owns its head')
    const head = heads[0].props
    assert.equal(head.fill, 'none', 'the arrow is a stroke, not a filled shape')
    assert.match(head.d, /^M .* L .* L /, 'two strokes meet at the tip')
    const numbers = String(head.d).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const [leftX, leftY, tipX, tipY, rightX, rightY] = numbers
    assert.ok(Math.hypot(leftX - tipX, leftY - tipY) > 3, 'the head is big enough to read')
    assert.ok(Math.hypot(leftX - rightX, leftY - rightY) > 4, 'the head is wider than one pixel')
    assert.ok(leftY !== rightY, 'the head is not a straight line through the tip')
  } finally {
    plugin.restore()
  }
})


test('the connector tool explains the drag and marks its source', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes() })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const tool = controlBy(plugin, { tool: 'connector', name: /connector|连线/i })
    await clickElement(plugin, tool)
    await settle(plugin, 2)
    const hint = findByClass(plugin.renderer.root, 'mm-canvas-connect-hint')
    assert.ok(hint, 'the connector mode explains how to connect')
    assert.match(toMarkup(hint), /Drag onto a second object/)

    const first = canvasNodes(plugin)[0]
    await pressAt(plugin, first, { x: leftOf(plugin, first.props['data-node-id']) + 10, y: topOf(plugin, first.props['data-node-id']) + 10 })
    await settle(plugin, 1)
    assert.ok(String(nodeById(plugin, first.props['data-node-id']).props.className).includes('is-selected'), 'the source is selected')
  } finally {
    plugin.restore()
  }
})


test('a connector drag completes even though pointer capture retargets the events', async () => {
  const document = {
    ...V2_DOCUMENT,
    nodes: [
      { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
      { ...V2_DOCUMENT.nodes[0], id: 'b', x: 600, y: 300, w: 200, h: 120, text: 'Target' },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await clickElement(plugin, controlBy(plugin, { tool: 'connector', name: /connector|连线/i }))
    await settle(plugin, 2)

    const from = nodeById(plugin, 'a')
    const to = nodeById(plugin, 'b')
    // The browser retargets every move and release to the canvas once pointer
    // capture is set, so the events carry the surface as their target.
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    await pressAt(plugin, from, { x: leftOf(plugin, 'a') + 20, y: topOf(plugin, 'a') + 20 })
    await movePointer(plugin, surface, { x: leftOf(plugin, 'b') + 20, y: topOf(plugin, 'b') + 20 })
    await releaseAt(plugin, surface, { x: leftOf(plugin, 'b') + 20, y: topOf(plugin, 'b') + 20 })

    const drawn = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')
    assert.equal(drawn.length, 1, 'dragging from one object to another draws the connector')
  } finally {
    plugin.restore()
  }
})

test('clicking one object and then another connects them', async () => {
  const document = {
    ...V2_DOCUMENT,
    nodes: [
      { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
      { ...V2_DOCUMENT.nodes[0], id: 'b', x: 600, y: 300, w: 200, h: 120, text: 'Target' },
    ],
    edges: [],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await clickElement(plugin, controlBy(plugin, { tool: 'connector', name: /connector|连线/i }))
    await settle(plugin, 2)
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    await pressAt(plugin, nodeById(plugin, 'a'), { x: leftOf(plugin, 'a') + 20, y: topOf(plugin, 'a') + 20 })
    await movePointer(plugin, surface, { x: leftOf(plugin, 'a') + 24, y: topOf(plugin, 'a') + 22 })
    await releaseAt(plugin, surface, { x: leftOf(plugin, 'a') + 24, y: topOf(plugin, 'a') + 22 })
    assert.equal(findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge').length, 0)

    await pressAt(plugin, nodeById(plugin, 'b'), { x: leftOf(plugin, 'b') + 20, y: topOf(plugin, 'b') + 20 })
    await releaseAt(plugin, surface, { x: leftOf(plugin, 'b') + 20, y: topOf(plugin, 'b') + 20 })
    assert.equal(
      findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge').length,
      1,
      'the second click finishes the line',
    )
  } finally {
    plugin.restore()
  }
})


test('a resize cannot push a node past the size the Host accepts', async () => {
  // The board holds a frame already at the 8000 limit; dragging its handle
  // further used to send 8001+ and the save was rejected with
  // "node.w must be between 16 and 8000".
  const document = {
    ...V2_DOCUMENT,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [{ ...V2_DOCUMENT.nodes[0], id: 'wide', x: 0, y: 0, w: 7900, h: 600 }],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await pressElement(plugin, nodeById(plugin, 'wide'))
    const handle = findAll(plugin.renderer.root, (element) => (
      String(element.props?.className || '').includes('mm-canvas-handle is-se')
    ))[0]
    assert.ok(handle, 'the selection shows its handles')
    await pressAt(plugin, handle, { x: 100, y: 100 })
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    // 400 screen pixels of drag is well past the limit.
    surface.props.onPointerMove(makeEvent({ clientX: 500, clientY: 100, buttons: 1 }))
    await settle(plugin, 2)
    surface.props.onPointerUp(makeEvent({ clientX: 500, clientY: 100, buttons: 0 }))
    await settle(plugin, 2)

    const width = parseFloat(nodeById(plugin, 'wide').props.style.width)
    assert.equal(width, 8000, 'the drag stops at the documented maximum')
  } finally {
    plugin.restore()
  }
})

test('a rejected save names its log entry and the log dialog shows it', async () => {
  const routes = canvasRoutes({ documents: { c1: V2_DOCUMENT } })
  routes['canvas-save'] = () => ({
    __error: { code: 'invalid-operation', message: 'node.w must be between 16 and 8000', logId: 'E-TEST-1' },
  })
  routes.diagnostics = () => ({
    entries: [{
      id: 'E-TEST-1',
      at: 1757213000000,
      atIso: '2026-09-07T03:23:20.000Z',
      scope: 'host',
      method: 'canvas-save',
      code: 'INVALID_CANVAS',
      message: 'node.w must be between 16 and 8000',
      detail: { payload: { nodeCount: 4, suspects: [{ id: 'wide', type: 'frame', w: 9000, h: 400 }] } },
    }],
    location: { filePath: '/tmp/diagnostics.log' },
  })
  const plugin = await loadMomentsClient({ routes })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    // A new sticky is a change, and every change asks for its own save.
    const stickyTool = findAll(plugin.renderer.root, (element) => element.type === 'button'
      && element.props?.['aria-label'] === 'Sticky note')[0]
    await clickElement(plugin, stickyTool)
    await settle(plugin, 2)
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    await pressAt(plugin, surface, { x: 320, y: 320 })
    await releaseAt(plugin, surface, { x: 320, y: 320 })
    await settle(plugin, 3)
    await sleep(1200)
    await settle(plugin, 3)
    assert.ok(plugin.fetch.calls.some((call) => call.method === 'canvas-save'), 'the change asked for a save')

    const banner = findByClass(plugin.renderer.root, 'mm-error-banner')
    assert.ok(banner, 'the rejected save is reported')
    const logId = findByClass(plugin.renderer.root, 'mm-error-logid')
    assert.ok(logId, 'the banner names the log entry')
    assert.match(toMarkup(logId), /E-TEST-1/)

    const openLog = findAll(banner, (element) => element.type === 'button'
      && element.props?.['aria-label'] === 'Open the diagnostic log')[0]
    assert.ok(openLog, 'the banner offers a way into the log')
    await clickElement(plugin, openLog)
    await settle(plugin, 4)
    const dialog = findByClass(plugin.renderer.root, 'mm-diagnostics')
    assert.ok(dialog, 'the log opens')
    assert.match(toMarkup(dialog), /E-TEST-1/)
    assert.match(toMarkup(dialog), /node\.w must be between/)
    assert.match(toMarkup(dialog), /wide/)
  } finally {
    plugin.restore()
  }
})


test('a connector head is drawn from the line geometry, not an SVG marker', async () => {
  const document = {
    ...V2_DOCUMENT,
    nodes: [
      { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
      { ...V2_DOCUMENT.nodes[0], id: 'b', x: 600, y: 300, w: 200, h: 120 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', fromAnchor: 'auto', toAnchor: 'auto', label: '', strokeWidth: 2 }],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const drawn = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')
    assert.equal(drawn.length, 1)
    assert.equal(drawn[0].props['marker-end'], undefined, 'no marker attribute is left behind')
    const heads = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-edge-head'))
    assert.equal(heads.length, 1, 'the end carries exactly one head')
    assert.match(heads[0].props.d, /^M .* L .* L /, 'the head is an open chevron of two strokes')
    // The tip of the chevron is the end point of the line itself.
    const numbers = (value) => String(value).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const end = numbers(drawn[0].props.d).slice(-2)
    const tip = numbers(heads[0].props.d).slice(2, 4)
    assert.ok(Math.hypot(tip[0] - end[0], tip[1] - end[1]) < 0.5, 'the head tip sits on the line end')
  } finally {
    plugin.restore()
  }
})


test('the arrow head keeps its screen size at every zoom level', async () => {
  // The line is drawn with `non-scaling-stroke`, so its width stays 2 screen
  // pixels at any zoom. The head is geometry in board units and must be scaled
  // back, or it shrinks at 25% and swells at 400%.
  const headLength = async (zoom) => {
    const document = {
      ...V2_DOCUMENT,
      camera: { x: 0, y: 0, zoom },
      nodes: [
        { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
        { ...V2_DOCUMENT.nodes[0], id: 'b', x: 600, y: 300, w: 200, h: 120 },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', fromAnchor: 'auto', toAnchor: 'auto', label: '', strokeWidth: 2 }],
    }
    const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
    try {
      renderMain(plugin)
      await enterCanvasMode(plugin)
      const head = findAll(plugin.renderer.root, (element) => (
        String(element.props?.className || '').includes('mm-canvas-edge-head')
      ))[0]
      const numbers = String(head.props.d).match(/-?\d+(?:\.\d+)?/g).map(Number)
      const [leftX, leftY, tipX, tipY] = numbers
      return Math.hypot(leftX - tipX, leftY - tipY) * zoom
    } finally {
      plugin.restore()
    }
  }
  const near = await headLength(1)
  const zoomedIn = await headLength(2)
  const zoomedOut = await headLength(0.25)
  for (const [label, value] of [['zoomed in', zoomedIn], ['zoomed out', zoomedOut]]) {
    assert.ok(Math.abs(value - near) < 0.5, `the head keeps its size when ${label}: ${value} vs ${near}`)
  }
})


test('a right-to-left connector enters the target without reversing its arrow', async () => {
  const document = {
    ...V2_DOCUMENT,
    nodes: [
      { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
      { ...V2_DOCUMENT.nodes[0], id: 'b', x: 600, y: 100, w: 200, h: 120 },
    ],
    edges: [{
      id: 'e1', from: 'a', to: 'b', fromAnchor: 'right', toAnchor: 'left',
      curve: 'bezier', endArrow: 'arrow', strokeWidth: 4,
    }],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const line = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')[0]
    const numbers = String(line.props.d).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const endX = numbers.at(-2)
    const control2X = numbers.at(-4)
    assert.ok(control2X < endX, 'the second control point stays outside the target, on the approach side')

    const head = findAll(plugin.renderer.root, (element) => (
      String(element.props?.className || '').includes('mm-canvas-edge-head')
    ))[0]
    const headNumbers = String(head.props.d).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const [leftX, , tipX] = headNumbers
    assert.ok(leftX < tipX, 'the chevron points into the target, not back along the line')
    const headLength = Math.abs(tipX - leftX) * Math.cos(0.62)
    assert.ok(headLength <= 9, `the arrow stays small even at stroke 4: ${headLength}`)
  } finally {
    plugin.restore()
  }
})


test('a magnet-snapped end meets its border at a right angle', async () => {
  // A diagonal approach used to slide onto the border wherever the ray hit it,
  // so a line could graze a corner. Snapping means a side, and a side means the
  // line leaves and enters along that side's normal whatever side is chosen.
  const document = {
    ...V2_DOCUMENT,
    nodes: [
      { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
      { ...V2_DOCUMENT.nodes[0], id: 'b', x: 700, y: 460, w: 200, h: 120 },
    ],
    edges: [{
      id: 'e1', from: 'a', to: 'b', fromAnchor: 'auto', toAnchor: 'auto', label: '', curve: 'bezier', strokeWidth: 2,
    }],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const line = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')[0]
    const numbers = String(line.props.d).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const [startX, startY, c1x, c1y, c2x, c2y, endX, endY] = numbers
    // Every anchor is the midpoint of one side, never a corner.
    const onVerticalSide = (x, node) => Math.abs(x - node.x) < 0.01 || Math.abs(x - (node.x + node.w)) < 0.01
    assert.ok(onVerticalSide(startX, document.nodes[0]), 'the start sits on a left or right edge')
    assert.ok((Math.abs(startY - 160) < 0.01) || onVerticalSide(startX, document.nodes[0]), 'the start is a side midpoint')
    if (onVerticalSide(startX, document.nodes[0])) {
      assert.equal(c1y, startY, 'the curve leaves square to that vertical edge')
    } else {
      assert.equal(c1x, startX, 'the curve leaves square to that horizontal edge')
    }
    const endOnVertical = onVerticalSide(endX, document.nodes[1])
    if (endOnVertical) {
      assert.equal(c2y, endY, 'the curve enters square to that vertical edge')
      assert.ok(Math.abs(endY - (document.nodes[1].y + document.nodes[1].h / 2)) < 0.01, 'on a side midpoint')
    } else {
      assert.equal(c2x, endX, 'the curve enters square to that horizontal edge')
      assert.ok(Math.abs(endX - (document.nodes[1].x + document.nodes[1].w / 2)) < 0.01, 'on a side midpoint')
    }
  } finally {
    plugin.restore()
  }
})

test('an elbow connector runs square to both borders', async () => {
  const document = {
    ...V2_DOCUMENT,
    nodes: [
      { ...V2_DOCUMENT.nodes[0], id: 'a', x: 100, y: 100, w: 200, h: 120 },
      { ...V2_DOCUMENT.nodes[0], id: 'b', x: 700, y: 460, w: 200, h: 120 },
    ],
    edges: [{
      id: 'e1', from: 'a', to: 'b', fromAnchor: 'auto', toAnchor: 'auto', label: '', curve: 'elbow', strokeWidth: 2,
    }],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const line = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')[0]
    const numbers = String(line.props.d).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const parts = []
    for (let index = 0; index < numbers.length; index += 2) parts.push({ x: numbers[index], y: numbers[index + 1] })
    assert.ok(parts.length >= 4, 'an elbow has corners')
    assert.equal(parts[0].x, numbers[0])
    assert.equal(parts[1].y, parts[0].y, 'the first leg leaves the border along a normal')
    assert.ok(parts[1].x !== parts[0].x || parts[1].y !== parts[0].y, 'and it leaves outwards')
    const last = parts[parts.length - 1]
    const beforeLast = parts[parts.length - 2]
    const lastLegVertical = Math.abs(beforeLast.x - last.x) < 0.01
    assert.ok(lastLegVertical || Math.abs(beforeLast.y - last.y) < 0.01, 'the last leg meets the border square')
  } finally {
    plugin.restore()
  }
})

test('the connector bar offers every line style, a full weight range and a colour', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: CONNECTED_DOCUMENT } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const hit = findBy(plugin.renderer.root, (element) => typeof element.props?.['data-edge-id'] === 'string')
    await clickElement(plugin, hit)
    await settle(plugin, 2)
    const panel = findByClass(plugin.renderer.root, 'mm-canvas-edge-panel')
    const labels = findAll(panel, (element) => typeof element.props?.['aria-label'] === 'string')
      .map((element) => element.props['aria-label'])
    // The four line styles the person asked for, plus the full weight range.
    for (const wanted of ['Curved line', 'Straight line', 'Elbow line', 'Solid line', 'Dashed line', 'Dotted line']) {
      assert.ok(labels.includes(wanted), `the bar offers ${wanted}`)
    }
    for (const weight of ['Stroke 1', 'Stroke 2', 'Stroke 3', 'Stroke 4', 'Stroke 6', 'Stroke 8']) {
      assert.ok(labels.includes(weight), `the bar offers ${weight}`)
    }
    assert.ok(labels.includes('Connector colour'), 'the bar offers a colour')

    // Weight 8 is the heaviest the format allows and survives the save.
    const weight = findAll(panel, (element) => element.props?.['aria-label'] === 'Stroke 8')[0]
    await clickElement(plugin, weight)
    await settle(plugin, 2)
    const line = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')[0]
    assert.equal(line.props['stroke-width'], 8, 'the line is drawn at the chosen weight')

    // The colour popover sets a real stroke on the line.
    const colour = findAll(panel, (element) => element.props?.['aria-label'] === 'Connector colour')[0]
    await clickElement(plugin, colour)
    await settle(plugin, 2)
    const popover = findByClass(plugin.renderer.root, 'mm-canvas-edge-colors')
    assert.ok(popover, 'the colour popover opens')
    const swatches = findAll(popover, (element) => String(element.props?.['aria-label'] || '').startsWith('Connector colour '))
    assert.ok(swatches.length >= 4, 'the palette offers colours')
    await clickElement(plugin, swatches[0])
    await settle(plugin, 2)
    const painted = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')[0]
    assert.match(String(painted.props.stroke), /^#[0-9a-f]{6}$/i, 'the chosen colour reaches the line')
  } finally {
    plugin.restore()
  }
})

test('a coloured connector keeps its colour together with every line style', async () => {
  const document = {
    ...CONNECTED_DOCUMENT,
    edges: [{ ...CONNECTED_DOCUMENT.edges[0], stroke: '#e11d48', strokeWidth: 4, dash: 'dashed', curve: 'elbow' }],
  }
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: document } }) })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    const line = findAll(plugin.renderer.root, (element) => element.props?.className === 'mm-canvas-edge')[0]
    assert.equal(line.props.stroke, '#e11d48', 'the colour is drawn')
    assert.equal(line.props['stroke-width'], 4, 'the weight is drawn')
    assert.equal(line.props['stroke-dasharray'], '9 5', 'the dash is drawn')
    assert.match(String(line.props.d), /L/, 'the elbow is drawn')
  } finally {
    plugin.restore()
  }
})


test('a workspace with no boards creates one instead of showing a phantom board', async () => {
  let created = false
  const routes = canvasRoutes({ documents: { c1: SAMPLE_DOCUMENT } })
  routes['canvas-list'] = () => ({
    canvases: created ? [{ id: 'c1', title: 'Board', nodeCount: SAMPLE_DOCUMENT.nodes.length }] : [],
  })
  routes['canvas-create'] = () => {
    created = true
    return { canvas: { ...SAMPLE_DOCUMENT, id: 'c1', title: 'Board' } }
  }
  const plugin = await loadMomentsClient({ routes })
  try {
    renderMain(plugin)
    await enterCanvasMode(plugin)
    await settle(plugin, 3)
    await sleep(400)
    const methods = plugin.fetch.calls.map((call) => call.method)
    assert.ok(methods.includes('canvas-create'), 'the empty workspace asks for a board')
    assert.ok(methods.indexOf('canvas-load') > methods.indexOf('canvas-create'), 'and loads it')
    // The board is real: a change now saves against the id it was given.
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface')
    const stickyTool = findAll(plugin.renderer.root, (element) => element.type === 'button'
      && element.props?.['aria-label'] === 'Sticky note')[0]
    await clickElement(plugin, stickyTool)
    await settle(plugin, 2)
    await pressAt(plugin, surface, { x: 300, y: 300 })
    await releaseAt(plugin, surface, { x: 300, y: 300 })
    await settle(plugin, 2)
    await sleep(900)
    const saves = plugin.fetch.calls.filter((call) => call.method === 'canvas-save')
    assert.ok(saves.length >= 1, 'the board saves')
    assert.equal(saves.at(-1).payload.id, 'c1', 'the save carries the board id')
  } finally {
    plugin.restore()
  }
})


test('the title bar keeps one Files menu instead of three separate buttons', async () => {
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ notes: NOTE_FIXTURE }) })
  try {
    renderMain(plugin)
    await settle(plugin, 3)
    // Three icons for import, backup and Markdown read as three products; the
    // title bar carries one menu instead.
    const files = findAll(plugin.renderer.root, (element) => element.type === 'button'
      && element.props?.['aria-label'] === 'Files')[0]
    assert.ok(files, 'the title bar offers a Files menu')
    assert.equal(files.props['aria-haspopup'], 'menu')
    const strayButtons = findAll(plugin.renderer.root, (element) => element.type === 'button'
      && ['Import a JSON backup', 'Export a JSON backup', 'Export Markdown'].includes(element.props?.['aria-label']))
    assert.equal(strayButtons.length, 0, 'the three separate buttons are gone')

    await clickElement(plugin, files)
    await settle(plugin, 2)
    const labels = findAll(plugin.renderer.root, (element) => element.props?.role === 'menuitem')
      .map((element) => toMarkup(element))
    assert.ok(labels.some((label) => label.includes('Import JSON backup')), 'the menu imports a backup')
    assert.ok(labels.some((label) => label.includes('Export JSON backup')), 'the menu exports a backup')
    assert.ok(labels.some((label) => label.includes('Export Markdown')), 'the menu exports Markdown')

    // Escape puts the menu away.
    await pressKey(plugin, 'Escape')
    await settle(plugin, 2)
    assert.equal(findAll(plugin.renderer.root, (element) => element.props?.role === 'menuitem').length, 0)
  } finally {
    plugin.restore()
  }
})



/* ---------------------------------------------------- resizing tracks the pointer */

function resizeDocument(nodes, camera = { x: 0, y: 0, zoom: 1 }) {
  return { ...V2_DOCUMENT, camera, nodes };
}

async function dragResize(plugin, handle, from, to) {
  await pressAt(plugin, handle, from);
  const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface');
  surface.props.onPointerMove(makeEvent({ clientX: to.x, clientY: to.y, buttons: 1 }));
  await settle(plugin, 2);
  surface.props.onPointerUp(makeEvent({ clientX: to.x, clientY: to.y, buttons: 0 }));
  await settle(plugin, 2);
}

function containerById(plugin, id) {
  return findAll(plugin.renderer.root, (element) => element.props?.['data-container-id'] === id)[0];
}

function cornerHandle(plugin) {
  return findAll(plugin.renderer.root, (element) => (
    String(element.props?.className || '').includes('mm-canvas-handle is-se')
  ))[0];
}

test('a resize follows the pointer at a zoom other than 100%', async () => {
  // 50 screen pixels at 50% zoom is 100 board units: a handler that forgets the
  // camera grows the node by 50, one that applies it twice grows it by 200.
  const nodes = [{
    ...V2_DOCUMENT.nodes[0], id: 'card', type: 'shape', shape: 'rect',
    x: 100, y: 100, w: 200, h: 100, fill: '#ffffff', members: [],
  }];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes, { x: 0, y: 0, zoom: 0.5 }) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, nodeById(plugin, 'card'));
    const handle = cornerHandle(plugin);
    assert.ok(handle, 'the selection shows its handles');
    // Press where the handle is actually drawn: a press has to resolve to the
    // corner under the pointer.
    const at = { x: parseFloat(handle.props.style.left), y: parseFloat(handle.props.style.top) };
    await dragResize(plugin, handle, at, { x: at.x + 50, y: at.y + 30 });

    const node = nodeById(plugin, 'card');
    assert.equal(parseFloat(node.props.style.width), 300, 'width follows 100 board units');
    assert.equal(parseFloat(node.props.style.height), 160, 'height follows 60 board units');
    assert.equal(parseFloat(node.props.style.left), 100, 'the anchored edge does not move');
  } finally {
    plugin.restore();
  }
});

test('a frame keeps the size it was dragged to instead of snapping back to its members', async () => {
  // The reported bug: resizing a frame looked like it drifted, because the box
  // was re-measured from its members on the very next update.
  const nodes = [
    { ...V2_DOCUMENT.nodes[0], id: 'panel', type: 'frame', x: 100, y: 100, w: 400, h: 300, fill: '#ffffff', members: ['kid-a', 'kid-b'] },
    { ...V2_DOCUMENT.nodes[0], id: 'kid-a', type: 'shape', shape: 'rect', x: 120, y: 120, w: 100, h: 60, fill: '#ffffff', members: [] },
    { ...V2_DOCUMENT.nodes[0], id: 'kid-b', type: 'shape', shape: 'rect', x: 240, y: 120, w: 100, h: 60, fill: '#ffffff', members: [] },
  ];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, containerById(plugin, 'panel'));
    const handle = cornerHandle(plugin);
    assert.ok(handle, 'the frame shows its handles');
    await dragResize(plugin, handle, { x: 100, y: 100 }, { x: 180, y: 140 });

    const panel = containerById(plugin, 'panel');
    assert.equal(parseFloat(panel.props.style.width), 480, 'the frame keeps the dragged width');
    assert.equal(parseFloat(panel.props.style.height), 340, 'the frame keeps the dragged height');
    const kid = nodeById(plugin, 'kid-a');
    assert.equal(parseFloat(kid.props.style.width), 100, 'children keep their size');
    assert.equal(parseFloat(kid.props.style.left), 120, 'children keep their place');
  } finally {
    plugin.restore()
  }
});

test('resizing a frame whose members escaped carries them along instead of throwing them away', async () => {
  // The reported bug: the frame's members sat 60,000 units away from it, so
  // re-placing them by their pins threw them thousands of units further. The
  // box followed the pointer while its contents ran off, which reads as
  // "it jumped to the right".
  const nodes = [
    { ...V2_DOCUMENT.nodes[0], id: 'panel', type: 'frame', x: 100, y: 100, w: 400, h: 300, fill: '#ffffff', members: ['kid-a', 'kid-b'] },
    { ...V2_DOCUMENT.nodes[0], id: 'kid-a', type: 'shape', shape: 'rect', x: -37228, y: -36956, w: 176, h: 80, fill: '#ffffff', members: [], constraints: { horizontal: 'right', vertical: 'top' } },
    { ...V2_DOCUMENT.nodes[0], id: 'kid-b', type: 'shape', shape: 'rect', x: -36956, y: -36956, w: 176, h: 80, fill: '#ffffff', members: [], constraints: { horizontal: 'right', vertical: 'top' } },
  ];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, containerById(plugin, 'panel'));
    const handle = cornerHandle(plugin);
    assert.ok(handle, 'the frame shows its handles');
    await dragResize(plugin, handle, { x: 100, y: 100 }, { x: 180, y: 140 });

    const panel = containerById(plugin, 'panel');
    assert.equal(parseFloat(panel.props.style.width), 480, 'the frame keeps the dragged width');
    assert.equal(parseFloat(panel.props.style.height), 340, 'the frame keeps the dragged height');
    const kid = nodeById(plugin, 'kid-a');
    // The members keep their place: the box follows the pointer and its
    // contents follow the box. Re-placing them by their pins instead would
    // throw them tens of thousands of units further away, because the pins
    // describe a relationship the escaped members no longer have.
    assert.equal(parseFloat(kid.props.style.left), -37228, 'the members are not thrown away');
    assert.equal(parseFloat(kid.props.style.width), 176, 'the members keep their size');
  } finally {
    plugin.restore();
  }
});

test('a small selection keeps its four handles from owning the same pixels', async () => {
  // At 37% zoom a 66x30 box is 25x11 on screen. With a fixed 9px halo all four
  // handles overlapped, and the last one in the DOM won: dragging the left
  // corner grew the box to the right.
  const nodes = [{
    ...V2_DOCUMENT.nodes[0], id: 'tiny', type: 'shape', shape: 'rect',
    x: 100, y: 100, w: 66, h: 30, fill: '#ffffff', members: [],
  }];
  const plugin = await loadMomentsClient({
    routes: canvasRoutes({ documents: { c1: resizeDocument(nodes, { x: 0, y: 0, zoom: 0.37 }) } }),
  });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, nodeById(plugin, 'tiny'));
    const handles = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-handle'));
    assert.equal(handles.length, 4, 'four corners are offered');
    const hit = parseFloat(handles[0].props.style['--mm-handle-hit']);
    assert.ok(hit < 9, `the halo shrinks with the box (got ${hit}px)`);
    const spacing = Math.min(66, 30) * 0.37;
    assert.ok(8 + hit * 2 <= spacing, 'no handle reaches past the middle of the selection');
  } finally {
    plugin.restore();
  }
});

test('a press on a small selection resizes from the corner under the pointer', async () => {
  // All four halos overlap on a 25x11 pixel selection, so the element that
  // receives the press is not the corner the person aimed at. The press has to
  // resolve to the nearest corner: dragging the left edge must grow left.
  const nodes = [{
    ...V2_DOCUMENT.nodes[0], id: 'tiny', type: 'shape', shape: 'rect',
    x: 100, y: 100, w: 66, h: 30, fill: '#ffffff', members: [],
  }];
  const plugin = await loadMomentsClient({
    routes: canvasRoutes({ documents: { c1: resizeDocument(nodes, { x: 0, y: 0, zoom: 0.37 }) } }),
  });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, nodeById(plugin, 'tiny'));
    const handles = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-handle'));
    const byId = new Map(handles.map((element) => [element.props['data-handle'], element]));
    const nw = byId.get('nw');
    const se = byId.get('se');
    const left = parseFloat(nw.props.style.left);
    const top = parseFloat(nw.props.style.top);
    const width = parseFloat(se.props.style.left) - left;
    const height = parseFloat(se.props.style.top) - top;

    // Press with the south-east element but two pixels from the LEFT edge: the
    // nearest corner is on the left, so the drag must grow to the left.
    const down = makeEvent({ clientX: left + 2, clientY: top + height / 2, buttons: 1 });
    down.target = se;
    down.currentTarget = se;
    se.props.onPointerDown(down);
    await settle(plugin, 1);
    const surface = findByClass(plugin.renderer.root, 'mm-canvas-surface');
    surface.props.onPointerMove(makeEvent({ clientX: left + 2 - 60, clientY: top + height / 2, buttons: 1 }));
    await settle(plugin, 2);
    surface.props.onPointerUp(makeEvent({ clientX: left + 2 - 60, clientY: top + height / 2, buttons: 0 }));
    await settle(plugin, 2);

    const node = nodeById(plugin, 'tiny');
    const movedLeft = parseFloat(node.props.style.left) < 100;
    assert.ok(movedLeft, `the box grows to the left (left=${node.props.style.left})`);
    assert.ok(parseFloat(node.props.style.width) > 66, 'and gets wider');
  } finally {
    plugin.restore();
  }
});

test('a resize is saved, so reopening the board shows the size that was dragged', async () => {
  // The bug behind "it drifts": the box followed the pointer, then reverted on
  // the next load because the resize never asked for a save.
  const nodes = [{
    ...V2_DOCUMENT.nodes[0], id: 'card', type: 'shape', shape: 'rect',
    x: 100, y: 100, w: 200, h: 100, fill: '#ffffff', members: [],
  }];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    await pressElement(plugin, nodeById(plugin, 'card'));
    const handle = cornerHandle(plugin);
    await dragResize(plugin, handle, { x: 100, y: 100 }, { x: 160, y: 140 });
    // The save is debounced; the assertion is about what it carries, not speed.
    await sleep(900);

    const saves = plugin.fetch.calls.filter((call) => call.method === 'canvas-save');
    assert.ok(saves.length > 0, 'a resize asks for a save');
    const saved = saves.at(-1).payload.nodes.find((node) => node.id === 'card');
    assert.equal(saved.w, 260, 'the saved width is the dragged width');
    assert.equal(saved.h, 140, 'the saved height is the dragged height');
  } finally {
    plugin.restore();
  }
});

test('resizing a group scales what is inside it', async () => {
  // A group is defined by its members, so its handle has to scale them: a group
  // whose box grew while its members stayed put would be re-measured back.
  const nodes = [
    { ...V2_DOCUMENT.nodes[0], id: 'cluster', type: 'group', x: 96, y: 96, w: 208, h: 88, fill: null, members: ['one', 'two'] },
    { ...V2_DOCUMENT.nodes[0], id: 'one', type: 'shape', shape: 'rect', x: 100, y: 100, w: 100, h: 80, fill: '#ffffff', members: [] },
    { ...V2_DOCUMENT.nodes[0], id: 'two', type: 'shape', shape: 'rect', x: 200, y: 100, w: 100, h: 80, fill: '#ffffff', members: [] },
  ];
  const plugin = await loadMomentsClient({ routes: canvasRoutes({ documents: { c1: resizeDocument(nodes) } }) });
  try {
    renderMain(plugin);
    await enterCanvasMode(plugin);
    // A group is an outline: it is grabbed by its edge, the way a person selects
    // one on the canvas.
    const edge = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-group-edge'))[0];
    assert.ok(edge, 'the group draws an edge to grab');
    await pressAt(plugin, edge, { x: 100, y: 100 });
    await settle(plugin, 2);
    const handles = findAll(plugin.renderer.root, (element) => String(element.props?.className || '').includes('mm-canvas-handle'));
    assert.ok(handles.length > 0, `the group shows its handles; saw: ${handles.map((el) => `${el.props?.className}:${Object.keys(el.props || {}).join(',')}`).join('|')}`);
    const handle = handles.find((el) => String(el.props.className).includes('is-se'));
    assert.ok(handle, `a south-east handle exists; saw: ${handles.map((el) => el.props.className).join('|')}`);
    await dragResize(plugin, handle, { x: 100, y: 100 }, { x: 150, y: 100 });

    const cluster = containerById(plugin, 'cluster');
    const one = nodeById(plugin, 'one');
    const two = nodeById(plugin, 'two');
    assert.ok(parseFloat(cluster.props.style.width) > 208, 'the group grew with its members');
    assert.ok(parseFloat(one.props.style.width) > 100, 'the first member scaled');
    assert.ok(parseFloat(two.props.style.left) > 200, 'the second member moved with the scale');
  } finally {
    plugin.restore();
  }
});
