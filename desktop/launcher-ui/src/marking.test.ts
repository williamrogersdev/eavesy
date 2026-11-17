import { expect, test } from 'bun:test';
import { DRAG_FROM, gesture } from './marking';

test('a press that barely moves is a click on what is outlined', () => {
  expect(gesture({ x: 100, y: 100 }, { x: 100, y: 100 }, false)).toBe('click');
  expect(gesture({ x: 100, y: 100 }, { x: 104, y: 103 }, false)).toBe('click');
});

test('a drag is a box', () => {
  expect(gesture({ x: 100, y: 100 }, { x: 300, y: 220 }, true)).toBe('box');
  // Released before the move was drawn: the distance alone makes it a drag.
  expect(gesture({ x: 100, y: 100 }, { x: 300, y: 220 }, false)).toBe('box');
  expect(gesture({ x: 300, y: 220 }, { x: 100, y: 100 }, true)).toBe('box');
});

test('a drag too thin to be a box highlights nothing, and never falls back to a click', () => {
  expect(gesture({ x: 100, y: 100 }, { x: 300, y: 102 }, true)).toBeNull();
  expect(gesture({ x: 100, y: 100 }, { x: 100 + DRAG_FROM, y: 100 }, false)).toBeNull();
  // Dragged out and back to the start: still a drag.
  expect(gesture({ x: 100, y: 100 }, { x: 101, y: 101 }, true)).toBeNull();
});
