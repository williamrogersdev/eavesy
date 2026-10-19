import type { ProjectFields, ProjectSummary } from '@/lib/api/projects';

export interface Draft {
  name: string;
  about: string;
  vocabulary: string[];
  people: string;
  match: string[];
}

export interface FormState {
  open: boolean;
  editingId: string | null;
  deletingId: string | null;
  draft: Draft;
}

export type FormAction =
  | { type: 'new' }
  | { type: 'edit'; project: ProjectSummary }
  | { type: 'close' }
  | { type: 'askDelete'; id: string }
  | { type: 'deleted'; id: string }
  | { type: 'draft'; patch: Partial<Draft> };

const EMPTY: Draft = { name: '', about: '', vocabulary: [], people: '', match: [] };

export const CLOSED: FormState = { open: false, editingId: null, deletingId: null, draft: EMPTY };

function draftOf(project: ProjectSummary): Draft {
  return {
    name: project.name,
    about: project.about ?? '',
    vocabulary: [...project.vocabulary],
    people: project.people ?? '',
    match: [...project.match],
  };
}

/** Opening, closing or switching the form always drops a pending delete confirmation. */
export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'new':
      return { ...CLOSED, open: true };
    case 'edit':
      return { open: true, editingId: action.project.id, deletingId: null, draft: draftOf(action.project) };
    case 'close':
      return CLOSED;
    case 'askDelete':
      return { ...state, deletingId: action.id };
    case 'deleted':
      return state.editingId === action.id ? CLOSED : { ...state, deletingId: null };
    case 'draft':
      return { ...state, draft: { ...state.draft, ...action.patch } };
  }
}

export function fieldsOf(draft: Draft): ProjectFields & { name: string } {
  return {
    name: draft.name.trim(),
    about: draft.about.trim() || null,
    vocabulary: draft.vocabulary,
    people: draft.people.trim() || null,
    match: draft.match,
  };
}

/**
 * Saves the draft. A failed save leaves the form alone so nothing typed is lost;
 * once it's saved the form closes, even if refreshing the list then fails.
 */
export async function saveProject({
  editingId,
  draft,
  create,
  update,
  reload,
  onSaved,
}: {
  editingId: string | null;
  draft: Draft;
  create: (fields: ProjectFields & { name: string }) => Promise<unknown>;
  update: (id: string, fields: ProjectFields) => Promise<unknown>;
  reload: () => Promise<unknown>;
  onSaved: () => void;
}): Promise<{ saved: boolean; message: string }> {
  const fields = fieldsOf(draft);
  try {
    if (editingId) await update(editingId, fields);
    else await create(fields);
  } catch (cause) {
    return { saved: false, message: cause instanceof Error ? cause.message : 'Could not save the project.' };
  }
  const saved = editingId ? 'Project saved.' : 'Project created.';
  onSaved();
  try {
    await reload();
    return { saved: true, message: saved };
  } catch {
    return { saved: true, message: `${saved} Reload the page to see the latest list.` };
  }
}
