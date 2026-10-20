import { describe, expect, test } from 'bun:test';
import type { ProjectSummary } from '@/lib/api/projects';
import { CLOSED, formReducer, saveProject, type Draft } from './project-form';

const project = (id: string): ProjectSummary => ({
  id, name: id, about: null, vocabulary: ['D1'], people: null, match: [], recordingCount: 0,
});

const draft: Draft = { name: ' eavesy ', about: '', vocabulary: ['Tauri'], people: '', match: [] };

function harness({ save, reload }: { save: () => Promise<unknown>; reload: () => Promise<unknown> }) {
  let form = formReducer(CLOSED, { type: 'new' });
  form = formReducer(form, { type: 'draft', patch: draft });
  const calls: string[] = [];
  return {
    get form() { return form; },
    calls,
    run: (editingId: string | null) => saveProject({
      editingId,
      draft: form.draft,
      create: async (fields) => { calls.push(`create ${fields.name}`); return save(); },
      update: async (id) => { calls.push(`update ${id}`); return save(); },
      reload,
      onSaved: () => { form = formReducer(form, { type: 'close' }); },
    }),
  };
}

describe('saving a project', () => {
  test('a failed save keeps the form open with what was typed', async () => {
    const h = harness({ save: () => Promise.reject(new Error('You have reached the project limit.')), reload: async () => {} });
    const result = await h.run(null);
    expect(result).toEqual({ saved: false, message: 'You have reached the project limit.' });
    expect(h.form.open).toBe(true);
    expect(h.form.draft.name).toBe(' eavesy ');
    expect(h.calls).toEqual(['create eavesy']);
  });

  test('a save that worked closes the form even when reloading the list fails', async () => {
    const h = harness({ save: async () => {}, reload: () => Promise.reject(new Error('offline')) });
    const result = await h.run('p1');
    expect(result).toEqual({ saved: true, message: 'Project saved. Reload the page to see the latest list.' });
    expect(h.form).toEqual(CLOSED);
    expect(h.calls).toEqual(['update p1']);
  });

  test('a new project reports it was created', async () => {
    const h = harness({ save: async () => {}, reload: async () => {} });
    expect(await h.run(null)).toEqual({ saved: true, message: 'Project created.' });
  });
});

describe('delete confirmation', () => {
  test('closing the form drops it', () => {
    const asked = formReducer(formReducer(CLOSED, { type: 'edit', project: project('a') }), { type: 'askDelete', id: 'b' });
    expect(asked.deletingId).toBe('b');
    expect(formReducer(asked, { type: 'close' }).deletingId).toBeNull();
  });

  test('editing a project drops it', () => {
    const asked = formReducer(CLOSED, { type: 'askDelete', id: 'a' });
    const editing = formReducer(asked, { type: 'edit', project: project('b') });
    expect(editing.deletingId).toBeNull();
    expect(editing.editingId).toBe('b');
  });

  test('opening a new project drops it', () => {
    expect(formReducer(formReducer(CLOSED, { type: 'askDelete', id: 'a' }), { type: 'new' }).deletingId).toBeNull();
  });

  test('deleting the project being edited closes the form; another one leaves it open', () => {
    const editing = formReducer(CLOSED, { type: 'edit', project: project('a') });
    expect(formReducer(formReducer(editing, { type: 'askDelete', id: 'a' }), { type: 'deleted', id: 'a' })).toEqual(CLOSED);
    const other = formReducer(formReducer(editing, { type: 'askDelete', id: 'b' }), { type: 'deleted', id: 'b' });
    expect(other.open).toBe(true);
    expect(other.deletingId).toBeNull();
  });
});
