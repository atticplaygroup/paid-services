import React, { useEffect } from 'react';
export type NextSeoProps = Record<string, any>;
export function NextSeo({ title, description }: NextSeoProps) {
  useEffect(() => { if (title) document.title = title; }, [title]);
  return description ? <meta name="description" content={description} /> : null;
}
export const DefaultSeo = NextSeo;
export function ArticleJsonLd(props: any) { return <script type="application/ld+json">{JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', ...props }).replace(/</g, '\\u003c')}</script>; }
