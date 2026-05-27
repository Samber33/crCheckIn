/**
 * Shared confirmation dialog — replaces native confirm() with a styled modal.
 * Usage: const ok = await showConfirmDialog('标题', '描述内容', '确认删除', 'danger')
 * Styles: 'danger' (red) | 'warn' (orange) | 'info' (blue) | 'primary' (terracotta)
 */
function showConfirmDialog(title, message, confirmText = '确认', style = 'danger') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'

    const iconMap = {
      danger: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z"/>',
      warn: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      info: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      primary: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
    }

    overlay.innerHTML = `
      <div class="confirm-card">
        <div class="confirm-icon-wrap ${style}">
          <svg style="width:24px;height:24px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            ${iconMap[style] || iconMap.danger}
          </svg>
        </div>
        <p class="confirm-title">${title}</p>
        <p class="confirm-message">${message}</p>
        <div class="confirm-actions">
          <button class="confirm-btn" id="confirmCancelBtn">取消</button>
          <button class="confirm-btn ${style}" id="confirmOkBtn">${confirmText}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    document.body.style.overflow = 'hidden'

    const cleanup = () => {
      overlay.remove()
      document.body.style.overflow = ''
    }

    document.getElementById('confirmCancelBtn').onclick = () => { cleanup(); resolve(false) }
    document.getElementById('confirmOkBtn').onclick = () => { cleanup(); resolve(true) }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false) } })
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { cleanup(); resolve(false); document.removeEventListener('keydown', onKey) }
    })
  })
}
