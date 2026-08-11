import { addons } from 'storybook/preview-api';

// Event name is a stable Storybook string constant; using the literal avoids
// depending on storybook/internal/* paths (thin-addon rule).
const STORY_RENDERED = 'storyRendered';

const channel = addons.getChannel();
channel.on(STORY_RENDERED, (_storyId: string) => {
  // Pin-drop overlay + render fingerprinting attach here (build phase 3).
});

export {};
