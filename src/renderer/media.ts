/** Native players share one playback channel; no remote or generated fallback. */
export function pauseOtherMedia(current?: HTMLMediaElement): void {
  document.querySelectorAll<HTMLMediaElement>('audio, video').forEach(player => {
    if (player !== current) player.pause()
  })
}
