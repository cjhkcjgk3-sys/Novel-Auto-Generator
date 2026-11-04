import * as tavern from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { createSillyTavernHost } from './sillyTavern.js';
export const host = createSillyTavernHost({
    extensionSettings: extension_settings,
    saveSettings: tavern.saveSettingsDebounced,
    swipeReply:
        typeof tavern.swipe === 'function'
            ? (floor, swipeId) =>
                  tavern.swipe(null, 'right', { forceMesId: floor, forceSwipeId: swipeId, forceDuration: 0 })
            : null,
});
