let expiredCheckPaused = false

export function pauseExpiredCheck() {
  expiredCheckPaused = true
}

export function resumeExpiredCheck() {
  expiredCheckPaused = false
}

export function isExpiredCheckPaused() {
  return expiredCheckPaused
}
