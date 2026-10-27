import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Launcher } from '@/components/launcher/launcher';
import './styles.css';

if (import.meta.env.DEV) {
  const { installDevMock } = await import('./dev-mock');
  installDevMock();
}

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <Launcher />
  </StrictMode>,
);
