import { Link as RouterLink } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

type LinkProps = {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  replace?: boolean;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

export function Link({
  href,
  prefetch: _prefetch,
  scroll: _scroll,
  shallow: _shallow,
  replace,
  children,
  ...rest
}: LinkProps) {
  if (/^(https?:|mailto:|tel:|#)/.test(href)) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <RouterLink to={href as never} replace={replace} {...rest}>
      {children}
    </RouterLink>
  );
}

export default Link;
