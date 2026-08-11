import type { Meta, StoryObj } from '@storybook/react-vite';
import { TextField } from './TextField';

const meta = {
  title: 'Components/TextField',
  component: TextField,
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: 'Work email',
    placeholder: 'you@company.com',
    helpText: 'We only use this to send the report.',
  },
};

export const WithError: Story = {
  args: {
    label: 'Work email',
    value: 'not-an-email',
    error: 'Enter a valid email address.',
  },
};
