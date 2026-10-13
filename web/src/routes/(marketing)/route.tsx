import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Nav } from '@/components/marketing/nav';
import { Footer } from '@/components/marketing/footer';
import {
  JsonLd,
  organizationSchema,
  websiteSchema,
} from '@/components/seo/json-ld';

export const Route = createFileRoute('/(marketing)')({
  component: MarketingLayout,
});

function MarketingLayout() {
  return (
    <div className="theme-dark relative flex flex-1 flex-col overflow-hidden">
      <JsonLd schema={[organizationSchema(), websiteSchema()]} />
      <Nav />
      <div className="flex flex-1 flex-col">
        <Outlet />
      </div>
      <Footer />
    </div>
  );
}
