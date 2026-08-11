import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = {
  title: 'Components/Button',
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { label: 'Save changes', variant: 'primary' },
};

export const Secondary: Story = {
  args: { label: 'Cancel', variant: 'secondary' },
};

export const Danger: Story = {
  args: { label: 'Delete account', variant: 'danger' },
};

export const Disabled: Story = {
  args: { label: 'Save changes', disabled: true },
};
