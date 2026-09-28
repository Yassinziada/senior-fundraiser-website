import { useState } from 'react';
import { iconFor } from '../utils/productIcons.js';

/** Uploaded photo if there is one, otherwise the drawing from the original POS. */
export default function ProductImage({ product, className = 'pimg' }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={className}>
      {product.image_url && !broken ? (
        <img src={product.image_url} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        // icon markup is a fixed, trusted constant bundled with the app
        <svg viewBox="0 0 64 64" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconFor(product.name) }} />
      )}
    </span>
  );
}
