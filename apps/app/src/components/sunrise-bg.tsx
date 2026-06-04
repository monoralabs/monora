/**
 * Ambient sunrise background: a few large, heavily-blurred organic blobs in the
 * brand's warm palette that slowly morph and drift across the whole viewport.
 * Pure CSS (keyframes in globals.css) - no JS, no hard edges. Sits behind the
 * auth card and respects prefers-reduced-motion.
 */
export function SunriseBg() {
  return (
    <div className="sunrise-bg" aria-hidden>
      <div className="sunrise-blob sunrise-blob--amber" />
      <div className="sunrise-blob sunrise-blob--coral" />
      <div className="sunrise-blob sunrise-blob--peach" />
      <div className="sunrise-blob sunrise-blob--brick" />
    </div>
  );
}
