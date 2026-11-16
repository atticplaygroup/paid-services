import React from 'react';
export default function Image({ layout, objectFit, priority, placeholder, blurDataURL, unoptimized, ...props }: any) {
  return <img {...props} style={{ ...(layout === 'fill' ? { position: 'absolute', inset: 0, width: '100%', height: '100%' } : {}), ...props.style, objectFit }} />;
}
