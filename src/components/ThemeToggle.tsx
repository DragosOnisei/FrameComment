// 4.0.3: Light mode removed. FrameComment is dark-only, so the theme
// toggle is now a no-op that renders nothing. The component is kept
// (rather than deleted) so the existing imports across the admin +
// share chrome — AdminHeader, ThumbnailReel, the share not-found page
// and the project share page — keep compiling without edits.
export default function ThemeToggle() {
  return null
}
