import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardAction, type KeyInput } from '../../main/shortcuts';

const press = (o: Partial<KeyInput>): KeyInput => ({ control: false, meta: false, shift: false, alt: false, code: '', key: '', ...o });

test('Ctrl+C / X / V are recognised on Latin, Russian layouts and without a key code', () => {
  assert.equal(clipboardAction(press({ control: true, code: 'KeyC', key: 'c' })), 'copy');
  assert.equal(clipboardAction(press({ control: true, code: 'KeyC', key: 'с' })), 'copy'); // Cyrillic es
  assert.equal(clipboardAction(press({ control: true, code: '', key: 'с' })), 'copy'); // driver without code
  assert.equal(clipboardAction(press({ control: true, code: 'KeyX', key: 'ч' })), 'cut');
  assert.equal(clipboardAction(press({ control: true, code: '', key: 'M' })), null); // Latin M is not a clipboard key
  assert.equal(clipboardAction(press({ control: true, code: '', key: 'м' })), 'paste');
  assert.equal(clipboardAction(press({ meta: true, code: 'KeyV', key: 'v' })), 'paste'); // Cmd on macOS
});

test('Insert / Delete variants, and shortcuts that must stay with the page', () => {
  assert.equal(clipboardAction(press({ control: true, key: 'Insert' })), 'copy');
  assert.equal(clipboardAction(press({ shift: true, key: 'Insert' })), 'paste');
  assert.equal(clipboardAction(press({ shift: true, key: 'Delete' })), 'cut');
  assert.equal(clipboardAction(press({ key: 'c', code: 'KeyC' })), null, 'plain C is typing');
  assert.equal(clipboardAction(press({ control: true, shift: true, code: 'KeyC', key: 'C' })), null, 'Ctrl+Shift+C is not copy');
  assert.equal(clipboardAction(press({ control: true, alt: true, code: 'KeyC', key: 'c' })), null);
  assert.equal(clipboardAction(press({ control: true, code: 'KeyA', key: 'a' })), null, 'select all stays with the page');
  assert.equal(clipboardAction(press({ control: true, code: 'KeyZ', key: 'z' })), null, 'undo stays with the page / editor');
});
