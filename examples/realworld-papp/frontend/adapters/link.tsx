import React from 'react';
import { Link } from 'react-router-dom';
export type LinkProps = { href: string | { pathname: string; query?: Record<string, string> }; children?: React.ReactNode; [key: string]: any };
export default function NextLink({ href, children, passHref, prefetch, replace, shallow, scroll, ...props }: LinkProps) {
  const to = typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`;
  const child = React.isValidElement(children) && children.type === 'a' ? children as React.ReactElement<any> : undefined;
  return <Link to={to} replace={replace} {...props} {...child?.props}>{child ? child.props.children : children}</Link>;
}
