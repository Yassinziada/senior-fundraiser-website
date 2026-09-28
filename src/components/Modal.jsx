import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children, footer, wide = false, closable = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && closable) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector('[autofocus], input, select, textarea, button.primary');
    setTimeout(() => first?.focus(), 30);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, closable]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closable && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        {title !== undefined && (
          <div className="modal-h">
            <h2>{title}</h2>
            {closable && (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
                ✕
              </button>
            )}
          </div>
        )}
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}
