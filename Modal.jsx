import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children, width }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={width ? { maxWidth: width } : undefined}>
        <header><h2>{title}</h2><button className="btn ghost small" onClick={onClose} aria-label="Close">Close</button></header>
        {children}
      </div>
    </div>
  );
}
