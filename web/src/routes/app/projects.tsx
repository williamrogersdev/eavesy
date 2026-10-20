import { createFileRoute } from '@tanstack/react-router';
import { ProjectManager } from '@/components/settings/project-manager';
import { AppPage } from '@/components/ui/app-page';

export const Route = createFileRoute('/app/projects')({
  component: ProjectsPage,
});

function ProjectsPage() {
  return (
    <AppPage width="compact">
      <ProjectManager />
    </AppPage>
  );
}
