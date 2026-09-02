/**
 * 7.5.0: anti-overlap layout for timeline comment beads.
 *
 * Since stacking happens only on IDENTICAL frames, two notes a frame apart
 * are two separate ~18px beads whose true positions may be a fraction of a
 * pixel apart. This computes per-bead horizontal nudges (px) so every bead
 * stays visible and hoverable: a forward sweep pushes an overlapping bead
 * just far enough right to keep `spacing` between centres, and a backward
 * sweep pulls any end-of-track pile-up back inside the width, still
 * honouring the spacing. Pure function — CustomVideoControls feeds it the
 * measured track width, and the simulation exercises the same code.
 *
 * The nudge is DISPLAY ONLY. Seeks, drags and saves all use the note's
 * stored time; this moves pixels, never data.
 */
export interface MarkerSlot {
  /** Caller's identity for the slot (the group index in the render array). */
  index: number
  /** True centre position in px from the track's left edge. */
  x: number
}

export function computeMarkerNudges(
  slots: MarkerSlot[],
  trackWidth: number,
  spacing: number,
): Map<number, number> {
  const offsets = new Map<number, number>()
  if (!Number.isFinite(trackWidth) || trackWidth <= 0 || slots.length < 2) return offsets

  const placed = [...slots]
    .sort((a, b) => a.x - b.x)
    .map((s) => ({ index: s.index, want: s.x, x: s.x }))

  // Forward: push right until every neighbour pair clears the spacing.
  let prev = -Infinity
  for (const p of placed) {
    p.x = Math.max(p.want, prev + spacing)
    prev = p.x
  }
  // Backward: pull an overflowing tail back inside the track. A cluster
  // wider than the track collapses against the left edge and overlaps —
  // the degenerate case (more beads than track) has no honest layout.
  let limit = trackWidth
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    placed[i].x = Math.max(0, Math.min(placed[i].x, limit))
    limit = placed[i].x - spacing
  }
  for (const p of placed) {
    const nudge = p.x - p.want
    if (Math.abs(nudge) >= 0.5) offsets.set(p.index, nudge)
  }
  return offsets
}
