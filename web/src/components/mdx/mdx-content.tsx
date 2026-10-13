import { Link } from '@/components/ui/app-link';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { Callout } from './callout';

type MdxComponent = ComponentType<{ components?: Record<string, unknown> }>;

const components = {
  a: ({ href = '', children, ...props }: ComponentProps<'a'>) => {
    if (href.startsWith('/')) {
      return (
        <Link href={href} {...props}>
          {children}
        </Link>
      );
    }
    const external = href.startsWith('http');
    return (
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...props}
      >
        {children}
      </a>
    );
  },
  Callout,
};

function ProseWrapper({ children }: { children?: ReactNode }) {
  return <div className="prose">{children}</div>;
}

export function MdxContent({ Component }: { Component: MdxComponent }) {
  return <Component components={{ ...components, wrapper: ProseWrapper }} />;
}
