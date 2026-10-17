import type { ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { LucideIcon } from 'lucide-react';
import { Kbd } from './kbd';

export type MenuItem =
  | {
      label: string;
      /** React key; defaults to the label. Set it when two items share a label. */
      id?: string;
      icon?: LucideIcon;
      kbd?: string;
      onSelect: () => void;
      tone?: 'default' | 'warn';
      disabled?: boolean;
    }
  | 'separator';

export type MenuProps = {
  /** Must be a single focusable element (rendered with asChild). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  /** Non-interactive content above the items, e.g. name and email. */
  header?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Raised, r12 popover with 28px items and full keyboard navigation (Radix). */
export function Menu({ trigger, items, align = 'end', header, open, onOpenChange }: MenuProps) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ev-menu ev" align={align} sideOffset={6} collisionPadding={8}>
          {header && (
            <>
              <div className="ev-menu-header">{header}</div>
              <DropdownMenu.Separator className="ev-menu-sep" />
            </>
          )}
          {items.map((item, i) =>
            item === 'separator' ? (
              <DropdownMenu.Separator key={`sep-${i}`} className="ev-menu-sep" />
            ) : (
              <DropdownMenu.Item
                key={item.id ?? `${i}-${item.label}`}
                className="ev-menu-item"
                data-tone={item.tone ?? 'default'}
                disabled={item.disabled}
                onSelect={item.onSelect}
              >
                {item.icon && <item.icon size={15} strokeWidth={1.75} aria-hidden />}
                <span className="ev-menu-item-label">{item.label}</span>
                {item.kbd && <Kbd keys={item.kbd} />}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
