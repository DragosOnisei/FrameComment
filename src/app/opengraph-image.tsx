import { ImageResponse } from 'next/og'

/**
 * 5.14 SEO — default Open Graph / Twitter card image (1200×630),
 * generated at build time with next/og. Applies to every public page
 * that doesn't define its own. Pure metadata artifact — no UI impact.
 */

export const alt = 'FrameComment — Video review, feedback & deliverables'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0f14',
          backgroundImage:
            'radial-gradient(80% 60% at 30% 0%, rgba(0,122,255,0.35) 0%, rgba(0,122,255,0.08) 45%, transparent 70%), radial-gradient(60% 50% at 85% 20%, rgba(99,102,241,0.25) 0%, transparent 65%)',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 96, fontWeight: 800, letterSpacing: '-2px' }}>
          <span style={{ color: '#ffffff' }}>Frame</span>
          <span style={{ color: '#3b9eff' }}>Comment</span>
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 34,
            color: 'rgba(255,255,255,0.72)',
            textAlign: 'center',
            maxWidth: 900,
          }}
        >
          Video review, feedback &amp; deliverables, finally in one place.
        </div>
        <div
          style={{
            marginTop: 44,
            display: 'flex',
            gap: 14,
            fontSize: 22,
            color: 'rgba(255,255,255,0.55)',
          }}
        >
          <span style={{ padding: '10px 22px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)' }}>
            Frame-accurate comments
          </span>
          <span style={{ padding: '10px 22px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)' }}>
            Client share links
          </span>
          <span style={{ padding: '10px 22px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)' }}>
            Versions &amp; approvals
          </span>
        </div>
      </div>
    ),
    { ...size },
  )
}
