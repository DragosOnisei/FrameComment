'use client'

import { useEffect, useState } from 'react'

/**
 * "Now", as state rather than as a clock read during render.
 *
 * 7.1.0: added while giving compare mode the same uploader line the player has.
 * That line ends in a relative tag ("22 Hours ago"), which needs the current
 * time — and the player had been getting it by calling `Date.now()` straight
 * inside its render. React's purity rule flags that for a real reason: a render
 * that reads the clock produces a different result each time it runs, so React
 * is free to re-render and get a different answer for reasons the code never
 * asked for. Copying that call into a second component would have doubled the
 * problem rather than solved it.
 *
 * The value is captured once and then refreshed on an interval, which also
 * fixes something the old code got wrong by accident: a relative label computed
 * during render only updated when something ELSE re-rendered the component. A
 * player left open said "5 Minutes ago" for an hour. Now it moves on its own.
 *
 * @param refreshMs How often to re-read the clock. The default is a minute,
 *                  which is the smallest unit these labels display, so a
 *                  shorter interval would re-render without changing any text.
 */
export function useNowMs(refreshMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), refreshMs)
    return () => window.clearInterval(id)
  }, [refreshMs])

  return now
}
