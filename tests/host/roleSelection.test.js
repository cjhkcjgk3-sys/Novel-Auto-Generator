import { expect, it } from 'vitest';
import { selectedRole } from '../../src/host/roleSelection.js';

it('resolves only the selected recorded role, including non-ASCII names', () => {
    const batch = {
        id: 'batch',
        items: [
            { id: 'a', name: '八重神子', swipe: 0 },
            { id: 'b', name: '雷电将军', swipe: 1 },
        ],
        history: [],
    };
    const message = {
        swipes: ['A', 'B'],
        swipe_id: 1,
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'batch', itemId: 'a' } } },
            { extra: { nag_role_batch: { taskId: 'batch', itemId: 'b' } } },
        ],
    };
    expect(selectedRole(batch, message)).toMatchObject({ index: 1, item: { name: '雷电将军' } });
    message.swipe_id = 0;
    expect(selectedRole(batch, message)).toMatchObject({ index: 0, item: { name: '八重神子' } });
});

it('refuses unknown, temporary, mismatched or ambiguous bindings', () => {
    const batch = { id: 'batch', items: [{ id: 'a', name: '甲', swipe: 0 }], history: [] };
    const message = {
        swipes: ['A', 'TEMP'],
        swipe_id: 1,
        swipe_info: [{}, { extra: { nag_role_batch: { taskId: 'batch', itemId: 'a' } } }],
    };
    expect(selectedRole(batch, message)).toBeNull();
    message.swipe_info[1].extra.nag_role_batch.taskId = 'other';
    expect(selectedRole(batch, message)).toBeNull();
    message.swipe_id = 0;
    expect(selectedRole(batch, message)).toBeNull();
});
