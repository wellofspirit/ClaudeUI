import { useEffect, useState } from 'react'

/**
 * `flag`, but only once it has been continuously true for `delayMs`. It drops to
 * false at once when `flag` does, and a true -> false -> true blip shorter than
 * the delay never shows. For UI that must not flash for a transient state.
 */
export function useSettledFlag(flag: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!flag) {
      setSettled(false)
      return
    }
    const id = setTimeout(() => setSettled(true), delayMs)
    return () => clearTimeout(id)
  }, [flag, delayMs])

  // The effect clears `settled` after the commit that dropped `flag`; gating on
  // `flag` here keeps that one commit from still showing the settled state.
  return flag && settled
}
