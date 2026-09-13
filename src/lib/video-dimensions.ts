/**
 * 7.9.0: read a video file's pixel dimensions in the browser, before upload.
 *
 * The processing banner wants to say how many tiers a video will get from
 * the first second, and that depends on the source's resolution — which the
 * server only learns when the worker probes the file, minutes later. The
 * browser can usually tell in a few hundred milliseconds by loading the
 * file's metadata into an off-screen <video>. Best effort: formats the
 * browser cannot decode (ProRes, MXF, …) fail or time out and return null,
 * and the server then falls back to the project's cap.
 */
export interface ProbedDimensions {
  width: number
  height: number
}

export function probeVideoDimensions(file: File, timeoutMs = 4000): Promise<ProbedDimensions | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !file || file.size === 0) {
    return Promise.resolve(null)
  }
  const url = URL.createObjectURL(file)
  return new Promise<ProbedDimensions | null>((resolve) => {
    const video = document.createElement('video')
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: ProbedDimensions | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      video.onloadedmetadata = null
      video.onerror = null
      // Release the decoder and the blob reference.
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        /* nothing to release */
      }
      URL.revokeObjectURL(url)
      resolve(result)
    }
    timer = setTimeout(() => finish(null), timeoutMs)
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      const w = video.videoWidth
      const h = video.videoHeight
      finish(w > 0 && h > 0 ? { width: w, height: h } : null)
    }
    video.onerror = () => finish(null)
    video.src = url
  })
}
