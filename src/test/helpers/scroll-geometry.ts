/**
 * jsdom has no layout, no `ResizeObserver` and no scroll physics. This is the
 * smallest model of them that lets a test drive the stick-to-bottom hook the way
 * a browser does: scroll geometry per element, a `ResizeObserver` the test
 * fires by hand (that is "layout changed after commit"), a recording
 * `scrollTo`, and the user-input events the hook listens to.
 *
 * Time is NOT mocked here: the hook's "was there user input just now" test reads
 * `performance.now()`, so a test that needs time to pass uses vitest's fake
 * timers (`toFake` includes `'performance'`).
 */

export interface Geometry {
  scrollHeight: number
  clientHeight: number
  /** Raw offset; reads are clamped to the scrollable range, like a layout would. */
  scrollTop: number
  /** `scrollTo({ top, behavior })` calls, in order. */
  scrollToCalls: Array<{ top: number | undefined; behavior: ScrollBehavior | undefined }>
}

/** What every element reports until a test says otherwise. */
const defaults = { scrollHeight: 0, clientHeight: 0 }
const models = new WeakMap<Element, Geometry>()

export function geo(el: Element): Geometry {
  let model = models.get(el)
  if (!model) {
    model = { ...defaults, scrollTop: 0, scrollToCalls: [] }
    models.set(el, model)
  }
  return model
}

export function maxScrollTop(el: Element): number {
  const g = geo(el)
  return Math.max(0, g.scrollHeight - g.clientHeight)
}

export function distanceFromBottom(el: Element): number {
  return geo(el).scrollHeight - el.scrollTop - geo(el).clientHeight
}

/** Geometry for elements that mount AFTER this call (the hook pins on mount). */
export function setDefaultGeometry(next: { scrollHeight: number; clientHeight: number }): void {
  defaults.scrollHeight = next.scrollHeight
  defaults.clientHeight = next.clientHeight
}

export class MockResizeObserver {
  static instances = new Set<MockResizeObserver>()
  readonly observed = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.add(this)
  }
  observe(target: Element): void {
    this.observed.add(target)
  }
  unobserve(target: Element): void {
    this.observed.delete(target)
  }
  disconnect(): void {
    this.observed.clear()
    MockResizeObserver.instances.delete(this)
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

/** Deliver a resize notification, as the browser does after layout. */
export function fireResize(target?: Element): void {
  for (const observer of [...MockResizeObserver.instances]) {
    if (!target || observer.observed.has(target)) observer.fire()
  }
}

/** Every element a live observer is watching. */
export function observedElements(): Element[] {
  return [...MockResizeObserver.instances].flatMap((o) => [...o.observed])
}

const GEOMETRY_PROPS = ['scrollTop', 'scrollHeight', 'clientHeight'] as const

/** Install the model; returns the restore function. */
export function installScrollGeometry(): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const prop of GEOMETRY_PROPS) {
    saved.set(prop, Object.getOwnPropertyDescriptor(Element.prototype, prop))
  }
  saved.set('scrollTo', Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo'))
  const hadObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')

  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return geo(this).scrollHeight
    }
  })
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return geo(this).clientHeight
    }
  })
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return Math.min(geo(this).scrollTop, maxScrollTop(this))
    },
    set(this: Element, value: number) {
      geo(this).scrollTop = Math.max(0, Math.min(value, maxScrollTop(this)))
    }
  })
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: Element, arg: ScrollToOptions) {
      geo(this).scrollToCalls.push({ top: arg.top, behavior: arg.behavior })
      // A smooth scroll is the test's to advance (set scrollTop, dispatch scroll
      // events); anything else lands at once.
      if (arg.behavior !== 'smooth' && arg.top !== undefined) {
        ;(this as Element).scrollTop = arg.top
      }
    }
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver
  })
  defaults.scrollHeight = 0
  defaults.clientHeight = 0

  return () => {
    for (const [prop, descriptor] of saved) {
      if (descriptor) Object.defineProperty(Element.prototype, prop, descriptor)
      else delete (Element.prototype as unknown as Record<string, unknown>)[prop]
    }
    if (hadObserver) Object.defineProperty(globalThis, 'ResizeObserver', hadObserver)
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    MockResizeObserver.instances.clear()
  }
}

// ── User input, as the events the hook listens to ───────────────────────────

export function dispatchWheel(target: Element, deltaY: number): void {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
}

export function dispatchScroll(el: Element): void {
  el.dispatchEvent(new Event('scroll'))
}

export function dispatchTouch(
  target: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientY: number
): void {
  const event = new Event(type, { bubbles: true })
  // jsdom has no Touch constructor; the hook reads `touches[0].clientY` only.
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY }] })
  target.dispatchEvent(event)
}

export function dispatchPointerDown(target: Element): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
}

export function dispatchPointerUp(target: Element): void {
  target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
}

export function dispatchKey(target: Element, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
}
