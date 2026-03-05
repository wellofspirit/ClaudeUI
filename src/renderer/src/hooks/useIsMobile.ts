import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 768

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= MOBILE_BREAKPOINT)

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
    const handler = (e: MediaQueryListEvent): void => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}

/**
 * On mobile browsers, window.visualViewport.height gives the actual visible
 * area after all browser chrome (address bar, bottom nav bar) is excluded.
 * Returns the pixel height so the root layout div can use it directly,
 * bypassing dvh/vh issues with Edge/Chrome/Safari mobile.
 *
 * Returns undefined on desktop or when visualViewport is unavailable.
 */
export function useVisualViewportHeight(isMobile: boolean): number | undefined {
  const [height, setHeight] = useState<number | undefined>(() => {
    if (!isMobile || !window.visualViewport) return undefined
    return window.visualViewport.height
  })

  useEffect(() => {
    if (!isMobile || !window.visualViewport) {
      setHeight(undefined)
      return
    }

    const update = (): void => {
      setHeight(window.visualViewport!.height)
    }

    update()
    window.visualViewport.addEventListener('resize', update)
    // Also listen to scroll — on mobile browsers the address bar collapses
    // on scroll, changing the visual viewport height
    window.visualViewport.addEventListener('scroll', update)

    return () => {
      window.visualViewport!.removeEventListener('resize', update)
      window.visualViewport!.removeEventListener('scroll', update)
    }
  }, [isMobile])

  return height
}
