import { describe, expect, it } from 'vitest'
import { toastClearance } from './useToastClearance'

const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 390, height: 760 }
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

describe('toastClearance', () => {
  it('lifts the toasts above a composer docked under them', () => {
    expect(toastClearance(box(280, 600, 1280, 720), DESKTOP)).toBe(128)
    expect(toastClearance(box(0, 640, 390, 760), PHONE)).toBe(128)
  })

  it('leaves them where they are when the composer is clear of their corner', () => {
    // Beside them, to the left.
    expect(toastClearance(box(280, 600, 880, 720), DESKTOP)).toBe(0)
    // Above them, as the home page's composer sits mid-page.
    expect(toastClearance(box(392, 360, 1160, 500), DESKTOP)).toBe(0)
    // Scrolled out of view below the window.
    expect(toastClearance(box(280, 900, 1280, 1020), DESKTOP)).toBe(0)
  })
})
