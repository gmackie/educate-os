/* eslint-disable react/react-in-jsx-scope */

// A persistent toast beside the chat composer, in Chromium with the app's styles: whether the
// toast covers the Send button is a matter of real layout (SCHO-411).

import { useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createKumoToastManager, Toasty } from '@cloudflare/kumo'
import { useToastClearance } from './useToastClearance'
import '../../../styles.css'

let root: Root | undefined
let container: HTMLElement | undefined
let previousViewport: { width: number, height: number } | undefined

afterEach(async () => {
  root?.unmount()
  container?.remove()
  if (previousViewport) await page.viewport(previousViewport.width, previousViewport.height)
  previousViewport = undefined
})

/** A composer docked at the bottom of the window, as on a chat page, with its Send button at right. */
const Composer = ({ style }: { style: React.CSSProperties }) => {
  const ref = useRef<HTMLDivElement>(null)
  useToastClearance(ref)
  return (
    <div ref={ref} style={{ position: 'fixed', height: 120, bottom: 0, ...style }}>
      <button type="button" style={{ position: 'absolute', right: 16, bottom: 16 }}>Send</button>
    </div>
  )
}

const render = async (width: number, height: number, style: React.CSSProperties) => {
  previousViewport ??= { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(width, height)
  container = document.createElement('div')
  document.body.append(container)
  const created = createRoot(container)
  root = created
  const toasts = createKumoToastManager()
  flushSync(() => created.render(<Toasty toastManager={toasts}><Composer style={style} /></Toasty>))
  toasts.add({
    title: 'EducateOS was updated', description: 'Reload to use the new version.',
    variant: 'info', timeout: 0, actions: [{ children: 'Reload', variant: 'primary' }],
  })
  await expect.element(page.getByText('EducateOS was updated')).toBeVisible()
}

const rect = (element: Element) => element.getBoundingClientRect()
const toastRect = () => rect(page.getByRole('dialog', { name: 'EducateOS was updated' }).element())

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

it.each([
  ['desktop', 1280, 720],
  ['phone', 390, 760],
])('keeps a persistent toast off the Send button on a %s', async (_name, width, height) => {
  await render(width, height, { left: 0, right: 0 })
  const send = page.getByRole('button', { name: 'Send' }).element()
  // Polled, as the toast slides in.
  await expect.poll(() => toastRect().bottom).toBeLessThanOrEqual(window.innerHeight - 120)
  expect(overlaps(toastRect(), rect(send))).toBe(false)
})

it('leaves the toast in its corner when the composer is elsewhere', async () => {
  await render(1280, 720, { left: 0, width: 400 })
  // Kumo's place: 2rem from the bottom.
  await expect.poll(() => Math.round(window.innerHeight - toastRect().bottom)).toBe(32)
})
