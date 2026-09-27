import { useEffect, type MutableRefObject } from 'react'
import {
  changeRuntimePathSearchScope,
  disposeRuntimePathSearchScheduler,
  type RuntimePathSearchScheduler
} from './runtime-path-search-scheduler'

/** Scope switching and teardown for the runtime path-search scheduler. */
export function useRuntimePathSearchSchedulerLifecycle(args: {
  searchScheduler: RuntimePathSearchScheduler
  querySchedulerScope: string | null
  loadingTimerRef: MutableRefObject<number | null>
  setVisibleLoadingRequestKey: (value: string) => void
}): void {
  const { searchScheduler, querySchedulerScope, loadingTimerRef, setVisibleLoadingRequestKey } =
    args
  useEffect(() => {
    const scheduler = searchScheduler
    changeRuntimePathSearchScope(scheduler, querySchedulerScope)
    if (querySchedulerScope === null) {
      if (loadingTimerRef.current !== null) {
        window.clearTimeout(loadingTimerRef.current)
        loadingTimerRef.current = null
      }
      setVisibleLoadingRequestKey('')
    }
  }, [querySchedulerScope, searchScheduler, loadingTimerRef, setVisibleLoadingRequestKey])

  useEffect(
    () => () => {
      disposeRuntimePathSearchScheduler(searchScheduler)
      if (loadingTimerRef.current !== null) {
        window.clearTimeout(loadingTimerRef.current)
      }
    },
    [searchScheduler, loadingTimerRef]
  )
}
