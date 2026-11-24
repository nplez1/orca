import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const roots: Root[] = []

/** Drains the microtask queue inside `act` so effects chained across a few awaits settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Mounts a hook probe into a detached root, tracked for `unmountProbes`. */
export async function mountProbe(element: ReactElement): Promise<Root> {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => {
    root.render(element)
  })
  return root
}

/** Unmounts every probe mounted so far; call from `afterEach` to keep cases isolated. */
export function unmountProbes(): void {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
}
