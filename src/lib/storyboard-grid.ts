/**
 * 6.9.3 — how dense the hover-scrub sprite is, and how to read it.
 *
 * The problem this fixes: the sprite was a fixed 10×10 = 100 frames for ANY
 * video. On a 7-minute clip that's one frame every 4.2 seconds, so the frame
 * under your cursor could be up to ~2 seconds away from where a click actually
 * lands. You'd line the preview up on the exact moment an actor turns his
 * head, click, and arrive somewhere else. The preview wasn't lying about the
 * time — it was showing the nearest frame it HAD.
 *
 * So: the grid now scales with duration, targeting roughly one frame per
 * second, and the geometry is stored per video because a fixed 10×10 on the
 * reader side would misread every new sprite.
 *
 * Honest limit, worth stating plainly: a sprite is a SAMPLE. Even at one
 * frame per second the preview is the nearest sampled frame, not the exact
 * frame you'll land on. Frame-exact preview needs a real video seek per hover,
 * which costs a request and a decode every time the mouse moves. This gets the
 * error down from ±2s to ±0.5s, which is the difference between "wrong shot"
 * and "same moment".
 */

export interface StoryboardGrid {
  cols: number
  rows: number
  cells: number
}

/** What every sprite generated before 6.9.3 is. Sprites carry no metadata of
 *  their own, so a video without recorded geometry must be read as 10×10. */
export const LEGACY_STORYBOARD_GRID: StoryboardGrid = { cols: 10, rows: 10, cells: 100 }

/** Sampling target and bounds. 400 cells at 192×108 is a ~3840×2160 JPEG,
 *  which lands around 300–700 KB at q5 — acceptable for a review tool, and
 *  fetched once per video. */
const TARGET_SECONDS_PER_FRAME = 1
const MIN_CELLS = 100
const MAX_CELLS = 400

/**
 * Pick a grid for a video of this length. Always a rectangle that holds at
 * least the wanted number of frames; extra trailing cells simply repeat the
 * last frame, which is harmless.
 */
export function planStoryboardGrid(durationSeconds: number): StoryboardGrid {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return LEGACY_STORYBOARD_GRID
  }
  const wanted = Math.round(durationSeconds / TARGET_SECONDS_PER_FRAME)
  const cells = Math.max(MIN_CELLS, Math.min(MAX_CELLS, wanted))
  const cols = Math.ceil(Math.sqrt(cells))
  const rows = Math.ceil(cells / cols)
  return { cols, rows, cells: cols * rows }
}

/** Read the geometry off a video row, falling back to the legacy grid. */
export function storyboardGridOf(video: {
  storyboardCols?: number | null
  storyboardRows?: number | null
} | null | undefined): StoryboardGrid {
  const cols = video?.storyboardCols
  const rows = video?.storyboardRows
  if (typeof cols === 'number' && typeof rows === 'number' && cols > 1 && rows > 1) {
    return { cols, rows, cells: cols * rows }
  }
  return LEGACY_STORYBOARD_GRID
}

/**
 * CSS for showing the sprite cell nearest a 0…1 position.
 *
 * ffmpeg's `fps` filter emits frame i at input time `i * duration / cells`,
 * so the nearest cell to a fraction is `round(fraction * cells)` — rounding,
 * not flooring, because flooring always shows a frame from BEFORE the cursor
 * and reads as lag.
 *
 * The fraction must be measured against the SAME duration the sprite was
 * built from — see `storyboardFraction`.
 */
export function storyboardCellStyle(
  url: string,
  fraction: number,
  grid: StoryboardGrid = LEGACY_STORYBOARD_GRID,
): React.CSSProperties {
  const clamped = Math.max(0, Math.min(1, fraction))
  const idx = Math.max(0, Math.min(grid.cells - 1, Math.round(clamped * grid.cells)))
  const col = idx % grid.cols
  const row = Math.floor(idx / grid.cols)
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: `${grid.cols * 100}% ${grid.rows * 100}%`,
    backgroundPosition: `${(col / (grid.cols - 1)) * 100}% ${(row / (grid.rows - 1)) * 100}%`,
    backgroundRepeat: 'no-repeat',
  }
}

/**
 * 6.12.0 — the fraction to look up, measured on the sprite's own timebase.
 *
 * The sprite is generated in the worker from the ORIGINAL file, with
 * `fps = cells / probedDuration`. The player, meanwhile, measures the cursor
 * against `videoElement.duration` — the duration of the TRANSCODED preview.
 * Those two numbers are usually equal, and when they are not (variable frame
 * rate exports, an audio track longer than the picture, a container whose
 * header rounds up) the sprite is effectively stretched against the timeline:
 * dead-on at the start, and further out the closer you get to the end.
 *
 * That is the drift 6.9.3 did not fix. Denser sampling made each cell shorter
 * but left the scale wrong, so hovering at 93% of a clip could still show the
 * end card. Mapping through the recorded duration fixes every sprite already
 * on disk, with no re-encode.
 *
 * `recordedDuration` is `Video.duration` — the exact value the worker passed
 * to ffmpeg. When it is missing or nonsense we fall back to the player's own
 * duration, which is what the code did before.
 */
export function storyboardFraction(
  timeSeconds: number,
  playerDuration: number,
  recordedDuration?: number | null,
): number {
  const base =
    typeof recordedDuration === 'number' && Number.isFinite(recordedDuration) && recordedDuration > 0
      ? recordedDuration
      : playerDuration
  if (!Number.isFinite(base) || base <= 0) return 0
  return Math.max(0, Math.min(1, timeSeconds / base))
}
