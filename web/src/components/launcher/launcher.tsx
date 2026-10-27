'use client';

import { isDesktop } from '@/lib/desktop/bridge';
import { DesktopPanel } from './desktop-panel';
import { WebPalette } from './web-palette';

/**
 * The capture panel in the Mac app (`desktop/launcher-ui`), or the command
 * palette at /launcher in a browser. They share primitives, not state.
 */
export function Launcher() {
  return isDesktop() ? <DesktopPanel /> : <WebPalette />;
}
