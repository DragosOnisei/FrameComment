'use client'

/**
 * In-app emoji picker (1.1.1+).
 *
 * Built because Chrome on macOS Sequoia silently drops every event
 * fired by the system Apple Intelligence emoji picker when the
 * focused element is a `<textarea>` — even the `input` /
 * `beforeinput` / `compositionstart` events never reach the page.
 * Frame.io / Slack / Discord all ship their own picker for exactly
 * this reason; this is ours. Lightweight (~3 KB minified, no deps),
 * keyboard-friendly, with search + categories.
 *
 * Usage:
 *   <EmojiPicker onSelect={(emoji) => insertAtCursor(emoji)} />
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Smile } from 'lucide-react'

interface EmojiCategory {
  id: string
  label: string
  // Single emoji used as the tab glyph.
  tabEmoji: string
  emojis: string[]
}

// Curated lists — roughly what Slack/Discord show by default.
const CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Smileys & emotion',
    tabEmoji: '😀',
    emojis: [
      '😀','😃','😄','😁','😆','😅','😂','🤣','🥲','🥹',
      '😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗',
      '😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓',
      '😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕',
      '🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤',
      '😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰',
      '😥','😓','🤗','🤔','🤭','🫢','🫣','🤫','🤥','😶',
      '🫥','😐','😑','😬','🫨','🙄','😯','😦','😧','😮',
      '😲','🥱','😴','🤤','😪','😵','🥴','🤢','🤮','🤧',
      '😷','🤒','🤕','🤑','🤠','💩','🤡','👹','👺','😺',
    ],
  },
  {
    id: 'gestures',
    label: 'People & gestures',
    tabEmoji: '🙏',
    emojis: [
      '🙏','👍','👎','👌','🤌','🤏','✌️','🤞','🫰','🤟',
      '🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👋',
      '🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','🫷','🫸',
      '👏','🙌','🫶','👐','🤲','🤝','✍️','💅','🤳','💪',
      '🦾','🦵','🦿','🦶','👂','🦻','👃','🧠','🫀','🫁',
      '🦷','🦴','👀','👁️','👅','👄','🫦','🧑','👶','🧒',
      '👦','👧','🧑‍🦰','🧑‍🦱','🧑‍🦳','🧑‍🦲','👨','👩','🧓','👴',
      '👵','🙇','💁','🙅','🙆','🙋','🧏','🤦','🤷','🧑‍⚕️',
      '🧑‍🎓','🧑‍🏫','🧑‍⚖️','🧑‍🌾','🧑‍🍳','🧑‍🔧','🧑‍🏭','🧑‍💼','🧑‍🔬','🧑‍💻',
      '🧑‍🎤','🧑‍🎨','🧑‍✈️','🧑‍🚀','🧑‍🚒','👮','🕵️','💂','🥷','👷',
    ],
  },
  {
    id: 'hearts',
    label: 'Hearts & symbols',
    tabEmoji: '❤️',
    emojis: [
      '❤️','🩷','🧡','💛','💚','💙','🩵','💜','🖤','🩶',
      '🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘',
      '💝','💟','♥️','💯','💢','💥','💫','💦','💨','🕳️',
      '💬','💭','🗯️','♨️','🛑','⛔','📛','🚫','✅','❌',
      '⭕','🆗','🆒','🆕','🆓','💠','🔘','🔴','🟠','🟡',
      '🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔼','🔽',
      '⏫','⏬','⬆️','⬇️','⬅️','➡️','↗️','↘️','↙️','↖️',
      '↕️','↔️','↩️','↪️','⤴️','⤵️','🔀','🔁','🔂','▶️',
      '⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','🔼','🔽',
    ],
  },
  {
    id: 'objects',
    label: 'Work & video',
    tabEmoji: '🎬',
    emojis: [
      '🎬','🎥','📹','📷','📸','🎞️','🎙️','🎚️','🎛️','📺',
      '💻','⌨️','🖥️','🖨️','🖱️','🖲️','💾','💿','📀','📼',
      '☎️','📞','📟','📠','📱','📲','🔋','🔌','💡','🔦',
      '🕯️','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰',
      '💳','🧾','📊','📈','📉','📋','📌','📍','📎','🖇️',
      '📏','📐','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐',
      '🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','💣',
      '🧨','🪃','🏹','🛡️','🪚','🔧','🪛','🔩','⚙️','🗜️',
      '📝','✏️','🖊️','🖋️','🖌️','🖍️','📒','📕','📗','📘',
      '📙','📚','📖','📰','🗞️','🔖','🏷️','📇','📃','📄',
    ],
  },
  {
    id: 'fire',
    label: 'Reactions',
    tabEmoji: '🔥',
    emojis: [
      '🔥','⭐','🌟','✨','💫','⚡','💥','☀️','🌞','🌈',
      '🎉','🎊','🥂','🍾','🍻','🎁','🏆','🥇','🥈','🥉',
      '🎯','🎮','🕹️','🎲','🎰','🎳','♟️','🧩','🎼','🎵',
      '🎶','🎤','🎧','📣','📢','🔔','🔕','📯','🎺','🥁',
      '👀','👁️','🧠','💀','☠️','👻','👽','👾','🤖','😺',
      '🚀','🛸','🛰️','✈️','🛫','🛬','🚗','🚙','🚌','🚕',
      '🍕','🍔','🍟','🌭','🥪','🌮','🌯','🥙','🥗','🍝',
      '🍜','🍲','🍣','🍱','🍤','🍰','🎂','🧁','🍫','🍿',
      '☕','🍵','🍺','🍷','🥃','🍹','🧃','🥤','🧋','🍾',
    ],
  },
]

const ALL_EMOJIS = CATEGORIES.flatMap((c) =>
  c.emojis.map((e) => ({ emoji: e, category: c.id })),
)

interface EmojiPickerProps {
  /** Called with the emoji character (e.g. `"😀"`) when the user
   *  picks one. The picker closes itself afterwards. */
  onSelect: (emoji: string) => void
  /** Optional override for the trigger button's title attribute. */
  title?: string
  /** Disable the button (e.g. while loading). */
  disabled?: boolean
}

// 1.1.1+: localStorage key for the user's recently-picked emojis.
// Single global list (not per-project) — same emoji population
// regardless of which comment thread they're in.
const RECENTS_KEY = 'framecomment:emoji-recents:v1'
const RECENTS_MAX = 24
// Default seed for the quick-pick row before the user has selected
// anything. Same five glyphs we used to render as category tabs —
// keeps the picker's empty state familiar.
const DEFAULT_QUICK_PICK: string[] = ['😀', '🙏', '❤️', '🎬', '🔥']
// Number of slots shown in the quick-pick row directly under the
// search box. The row is fixed-width so the picker layout doesn't
// jump as the user accumulates recents.
const QUICK_PICK_SLOTS = 5

function loadRecents(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX)
  } catch {
    return []
  }
}

function saveRecents(emoji: string, prev: string[]): string[] {
  // Move the picked emoji to the front, drop the rest of any prior
  // copies, cap at RECENTS_MAX.
  const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, RECENTS_MAX)
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* Quota / private mode — ignore, recents just won't persist. */
  }
  return next
}

export default function EmojiPicker({
  onSelect,
  title = 'Insert emoji',
  disabled,
}: EmojiPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<string[]>([])

  // Lazy-load recents on first open (avoids touching localStorage
  // during SSR / when the picker is never opened).
  useEffect(() => {
    if (!open) return
    if (recents.length === 0) {
      setRecents(loadRecents())
    }
    // We deliberately don't depend on `recents` here — re-loading
    // every time the picker opens would clobber in-memory updates
    // made during this session before they're committed to storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  // 1.1.1+: anchor the popover via `position: fixed` so it floats
  // above the rest of the UI instead of fighting the parent flex /
  // sidebar layout for space. We re-compute coordinates whenever the
  // popover opens so it lands directly above the trigger button.
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const POPOVER_W = 340
  const POPOVER_H = 360

  // Outside-click + Esc close. Matches the kebab/popover pattern
  // used elsewhere in the app.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Auto-focus the search box every time the picker opens — typing
  // immediately filters without the user having to click first.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => searchInputRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [open])

  // Compute the popover position relative to the trigger every time
  // the picker opens. We anchor above the button by default; if the
  // trigger is too close to the top of the viewport we flip the
  // popover below it. Horizontal: align left edge to the trigger but
  // clamp inside the viewport so it never bleeds off the right.
  useEffect(() => {
    if (!open) return
    const compute = () => {
      const t = triggerRef.current
      if (!t) return
      const rect = t.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Prefer above (so the popover doesn't cover the typing area).
      const placeAbove = rect.top - 8 >= POPOVER_H || rect.top > vh / 2
      const top = placeAbove
        ? Math.max(8, rect.top - POPOVER_H - 8)
        : Math.min(vh - POPOVER_H - 8, rect.bottom + 8)
      // 2.5.1+: position the popover HALFWAY between left-aligned
      // and fully centered on the trigger, then nudge 50 px further
      // LEFT so the popover sits visibly closer to the centre of
      // the comments sidebar (the smiley trigger lives in the
      // bottom-left of the action row). Halfway = average of the
      // two anchor offsets; the additional nudge is empirical.
      const triggerCenter = rect.left + rect.width / 2
      const leftAligned = rect.left
      const centered = triggerCenter - POPOVER_W / 2
      const halfway = (leftAligned + centered) / 2 - 60
      const left = Math.min(
        Math.max(8, halfway),
        vw - POPOVER_W - 8,
      )
      setCoords({ left, top })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open])

  // 1.1.1+: single flat list. When searching we filter by the
  // (very rough) category-name match; otherwise we show every
  // emoji in catalog order. Category navigation tabs were dropped
  // — the quick-pick row at the top covers the user's hot keys
  // and the search box covers everything else.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      return ALL_EMOJIS.filter((e) => e.category.includes(q))
    }
    return ALL_EMOJIS
  }, [query])

  // The five quick-pick slots = the user's last-used emojis,
  // padded with defaults until they've actually picked enough.
  // Filter the defaults so we don't render duplicates when a
  // default also lives in recents.
  const quickPick = useMemo(() => {
    const merged = [...recents]
    for (const d of DEFAULT_QUICK_PICK) {
      if (merged.length >= QUICK_PICK_SLOTS) break
      if (!merged.includes(d)) merged.push(d)
    }
    return merged.slice(0, QUICK_PICK_SLOTS)
  }, [recents])

  const handlePick = (emoji: string) => {
    onSelect(emoji)
    // 1.1.1+: bump to recents so the next open shows it first.
    setRecents((prev) => saveRecents(emoji, prev))
    // Close after one pick — matches Frame.io. Users wanting to
    // insert several can re-open. Less surprising than a "stays
    // open" mode that swallows clicks elsewhere.
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-50"
      >
        <Smile className="h-4 w-4" />
      </button>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Emoji picker"
          // 2.5.1+: portal to document.body so the popover escapes
          // any ancestor that creates a containing block for fixed-
          // position descendants. `backdrop-filter` / `filter` /
          // `transform` on the CommentSection card and the
          // CommentInput composer card both establish containing
          // blocks, which previously made `position: fixed` resolve
          // relative to those ancestors instead of the viewport —
          // pushing the popover off-screen and visually shifting
          // the entire comments column. Porting to body sidesteps
          // the issue entirely (PlayerTopMenu uses the same trick).
          style={{
            position: 'fixed',
            left: coords.left,
            top: coords.top,
            width: POPOVER_W,
            // 2.5.1+: TRUE frosted glass — same recipe used across
            // the v2.5 dropdowns (mic picker, PlayerTopMenu, All
            // comments filter, CommentsKebabMenu): low-opacity navy
            // base + accent-tinted radial bleed + heavy blur + GPU
            // layer hints so backdrop-filter actually samples the
            // page behind.
            backgroundColor: 'rgba(22, 37, 51, 0.35)',
            backgroundImage:
              'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.05) 45%, transparent 75%)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            transform: 'translate3d(0, 0, 0)',
            willChange: 'backdrop-filter, transform',
            isolation: 'isolate',
          }}
          className="z-[100] rounded-lg ring-1 ring-white/15 text-white shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-2"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search row — 2.5.1+ glass input */}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-md bg-white/[0.06] ring-1 ring-white/10 px-2 py-1.5 text-sm text-white outline-none placeholder:text-white/45 focus-visible:ring-2 focus-visible:ring-[hsl(var(--spotlight-tint)/0.55)]"
          />

          {/* Quick-pick row (1.1.1+). */}
          {!query.trim() && (
            <div className="mt-2 flex items-center gap-0.5 border-b border-white/10 pb-1">
              {quickPick.map((emoji, i) => (
                <button
                  key={`quick-${emoji}-${i}`}
                  type="button"
                  onClick={() => handlePick(emoji)}
                  title={`Insert ${emoji}`}
                  className="flex h-8 w-9 items-center justify-center rounded-md text-xl hover:bg-white/[0.08] transition-colors"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          {/* Emoji grid — 2.5.1+ scroll bar hidden via the
              `scrollbar-hide` utility. Scroll behaviour intact, just
              no visible bar (the partial last row makes overflow
              obvious without it). pr-1 also dropped since we no
              longer need a gutter for the scrollbar track. */}
          <div className="mt-2 grid max-h-[260px] grid-cols-10 gap-0.5 overflow-y-auto scrollbar-hide">
            {visible.length === 0 ? (
              <div className="col-span-10 py-6 text-center text-xs text-white/55">
                No emoji matches
              </div>
            ) : (
              visible.map(({ emoji }, i) => (
                <button
                  key={`${emoji}-${i}`}
                  type="button"
                  onClick={() => handlePick(emoji)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-white/[0.08] transition-colors"
                  aria-label={`Insert ${emoji}`}
                >
                  {emoji}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
