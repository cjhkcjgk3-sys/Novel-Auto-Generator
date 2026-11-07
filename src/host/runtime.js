import * as tavern from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { createSillyTavernHost } from './sillyTavern.js';
export const host = createSillyTavernHost({
    extensionSettings: extension_settings,
    saveSettings: tavern.saveSettingsDebounced,
    syncMesToSwipe: tavern.syncMesToSwipe,
    syncSwipeToMes: tavern.syncSwipeToMes,
    readSavedChat: async (context) => {
        const character = context.characters?.[context.characterId];
        if (!character?.avatar || !character.chat) throw new Error('无法可靠确认当前聊天文件');
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            cache: 'no-cache',
            headers: tavern.getRequestHeaders(),
            body: JSON.stringify({ ch_name: character.name, file_name: character.chat, avatar_url: character.avatar }),
        });
        if (!response.ok) throw new Error('无法核对酒馆保存的聊天');
        const data = await response.json();
        if (!Array.isArray(data) || !data.length) throw new Error('酒馆没有返回可核对的聊天');
        return data.slice(1);
    },
    swipeReply:
        typeof tavern.swipe === 'function'
            ? (floor, swipeId) =>
                  tavern.swipe(null, 'right', { forceMesId: floor, forceSwipeId: swipeId, forceDuration: 0 })
            : null,
});
