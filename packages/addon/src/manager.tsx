import React from 'react';
import { addons, types } from 'storybook/manager-api';

export const ADDON_ID = 'greenroom';
export const PANEL_ID = `${ADDON_ID}/panel`;

addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Review',
    render: ({ active }) =>
      active ? (
        <div style={{ padding: 16, fontSize: 13 }}>
          Greenroom review panel — threads and per-story status land here.
        </div>
      ) : null,
  });
});
