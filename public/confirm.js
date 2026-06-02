/**
 * Shared confirmation dialog — replaces native confirm() with a styled modal.
 * Usage: const ok = await showConfirmDialog('标题', '描述内容', '确认删除', 'danger')
 * Styles: 'danger' (red) | 'warn' (orange) | 'info' (blue) | 'primary' (terracotta)
 */
function ensureConfirmDialogStyles() {
  if (document.getElementById('confirmDialogStyles')) return
  const style = document.createElement('style')
  style.id = 'confirmDialogStyles'
  style.textContent = `
    .confirm-overlay {
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center; padding: 24px;
      background: rgba(20,20,19,.45); backdrop-filter: blur(2px);
      animation: confirmFadeIn .16s ease;
    }
    .confirm-card {
      width: min(100%, 420px); box-sizing: border-box;
      background: #fff; border: 1px solid #e6dfd8; border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.06);
      padding: 28px; text-align: left;
      animation: confirmSlideUp .2s cubic-bezier(.22,1,.36,1);
    }
    .confirm-icon-wrap {
      width: 44px; height: 44px; border-radius: 12px;
      display: flex; align-items: center; justify-content: center; margin-bottom: 16px;
    }
    .confirm-icon-wrap.danger { background: #fef2f2; color: #c64545; }
    .confirm-icon-wrap.warn { background: #fff7ed; color: #c2410c; }
    .confirm-icon-wrap.info { background: #eff6ff; color: #4a90d9; }
    .confirm-icon-wrap.primary { background: #fdf2f0; color: #cc785c; }
    .confirm-title {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 18px; font-weight: 400; color: #141413;
      letter-spacing: -.3px; line-height: 1.35; margin: 0 0 8px;
    }
    .confirm-message { font-size: 14px; color: #3d3d3a; line-height: 1.65; margin: 0; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
    .confirm-btn {
      min-width: 96px; height: 40px; padding: 0 18px; border-radius: 8px;
      border: 1px solid #e6dfd8; background: #fff; color: #3d3d3a;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background .15s, border-color .15s, color .15s, transform .15s;
    }
    .confirm-btn:hover { background: #faf9f5; border-color: #d5cec5; }
    .confirm-btn:focus-visible { outline: 2px solid rgba(204,120,92,.35); outline-offset: 2px; }
    .confirm-btn.danger { background: #c64545; color: #fff; border-color: #c64545; }
    .confirm-btn.warn { background: #c2410c; color: #fff; border-color: #c2410c; }
    .confirm-btn.info { background: #4a90d9; color: #fff; border-color: #4a90d9; }
    .confirm-btn.primary { background: #cc785c; color: #fff; border-color: #cc785c; }
    .confirm-btn.danger:hover { background: #b53d3d; border-color: #b53d3d; }
    .confirm-btn.warn:hover { background: #a3370a; border-color: #a3370a; }
    .confirm-btn.info:hover { background: #3a7fc8; border-color: #3a7fc8; }
    .confirm-btn.primary:hover { background: #a9583e; border-color: #a9583e; }
    @keyframes confirmFadeIn { from { opacity: 0 } to { opacity: 1 } }
    @keyframes confirmSlideUp {
      from { opacity: 0; transform: translateY(12px) scale(.97) }
      to { opacity: 1; transform: translateY(0) scale(1) }
    }
    @media (max-width: 520px) {
      .confirm-overlay { align-items: flex-end; padding: 16px }
      .confirm-card { padding: 24px 20px 20px }
      .confirm-actions { flex-direction: column-reverse }
      .confirm-btn { width: 100% }
    }
  `
  document.head.appendChild(style)
}

function escapeConfirmHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function showConfirmDialog(title, message, confirmText = '确认', style = 'danger') {
  return new Promise((resolve) => {
    ensureConfirmDialogStyles()

    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')

    const iconMap = {
      danger: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z"/>',
      warn: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      info: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      primary: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
    }
    const safeStyle = iconMap[style] ? style : 'danger'

    overlay.innerHTML = `
      <div class="confirm-card">
        <div class="confirm-icon-wrap ${safeStyle}">
          <svg style="width:24px;height:24px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            ${iconMap[safeStyle]}
          </svg>
        </div>
        <p class="confirm-title">${escapeConfirmHtml(title)}</p>
        <p class="confirm-message">${escapeConfirmHtml(message)}</p>
        <div class="confirm-actions">
          <button class="confirm-btn" id="confirmCancelBtn">取消</button>
          <button class="confirm-btn ${safeStyle}" id="confirmOkBtn">${escapeConfirmHtml(confirmText)}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const cancelBtn = overlay.querySelector('#confirmCancelBtn')
    const okBtn = overlay.querySelector('#confirmOkBtn')
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const cleanup = () => {
      overlay.remove()
      document.body.style.overflow = previousBodyOverflow
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(false) }
      if (e.key === 'Enter') { cleanup(); resolve(true) }
    }

    cancelBtn.onclick = () => { cleanup(); resolve(false) }
    okBtn.onclick = () => { cleanup(); resolve(true) }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false) } })
    document.addEventListener('keydown', onKey)
    okBtn.focus()
  })
}
