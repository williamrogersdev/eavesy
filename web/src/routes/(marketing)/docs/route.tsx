import { Outlet, createFileRoute } from '@tanstack/react-router';
import { getDocsByCategory } from '@/lib/content';
import { Container } from '@/components/marketing/page-chrome';
import {
  DocsSidebar,
  type DocNavGroup,
} from '@/components/marketing/docs-sidebar';

export const Route = createFileRoute('/(marketing)/docs')({
  component: DocsLayout,
});

function DocsLayout() {
  const groups: DocNavGroup[] = getDocsByCategory().map((g) => ({
    category: g.category,
    items: g.docs.map((d) => ({ slug: d.slug, title: d.frontmatter.title })),
  }));

  return (
    <main className="flex flex-1 flex-col py-8 lg:py-12">
      <Container className="grid gap-8 lg:grid-cols-[15rem_1fr] lg:gap-12">
        <aside className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto lg:pb-8">
          <DocsSidebar groups={groups} />
        </aside>
        <div className="min-w-0">
          <Outlet />
        </div>
      </Container>
    </main>
  );
}
