import { useEffect, useState } from 'react'

/**
 * A flag that has to outlast a delay before it is shown.
 *
 * Why: the styleguide's in-flight rule defers visible loading ~200ms, so a read that lands quickly
 * never flashes a refreshing label beside content that is already correct.
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) {
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => {
      clearTimeout(timer)
    }
  }, [active, delayMs])
  return active && elapsed
}
