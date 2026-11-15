import { useEffect, type RefObject } from 'react'

/** The CSS variable styles.css lifts the toast viewport by. */
export const TOAST_CLEARANCE_PROPERTY = '--toast-clearance'

// Where Kumo's toast viewport sits (`right-4 bottom-4 w-[calc(100%-2rem)]`, from `sm`
// `right-8 bottom-8 w-[340px]`), and room for one toast with a title, a description and an action.
const SM_BREAKPOINT = 640
const TOAST_HEIGHT = 160
const GAP = 8

type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>

/**
 * How far above the window's bottom edge the toasts must sit to clear `composer`, or 0 when they
 * do not overlap it where Kumo puts them. A persistent toast (a new version, an update) otherwise
 * covers the composer's Send button and swallows the click (SCHO-411).
 */
export const toastClearance = (composer: Box, window: { width: number; height: number }): number => {
  const inset = window.width >= SM_BREAKPOINT ? 32 : 16
  const toastLeft = window.width >= SM_BREAKPOINT ? window.width - inset - 340 : inset
  const toastTop = window.height - inset - TOAST_HEIGHT
  const overlaps = composer.right > toastLeft && composer.left < window.width - inset &&
    composer.bottom > toastTop && composer.top < window.height - inset
  return overlaps ? Math.ceil(window.height - composer.top + GAP) : 0
}

/**
 * Keeps the app's toasts clear of the composer `ref` points at while it is mounted, by setting
 * {@link TOAST_CLEARANCE_PROPERTY} on the document root as the composer grows, the window resizes
 * or the page scrolls.
 */
export const useToastClearance = (ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const root = document.documentElement
    let frame = 0
    const measure = () => {
      frame = 0
      const clearance = toastClearance(element.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight })
      if (clearance > 0) root.style.setProperty(TOAST_CLEARANCE_PROPERTY, `${clearance}px`)
      else root.style.removeProperty(TOAST_CLEARANCE_PROPERTY)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    // Capturing, since the page scrolls inside the app shell rather than the window.
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, { capture: true })
      root.style.removeProperty(TOAST_CLEARANCE_PROPERTY)
    }
  }, [ref])
}
