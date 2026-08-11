import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertBanner } from './AlertBanner';

const meta = {
  title: 'Components/AlertBanner',
  component: AlertBanner,
} satisfies Meta<typeof AlertBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
  args: { tone: 'info', title: 'Heads up', message: 'Maintenance window Sunday 02:00–04:00 UTC.' },
};

export const Success: Story = {
  args: { tone: 'success', title: 'Saved', message: 'Your changes are live.' },
};

export const Warning: Story = {
  args: { tone: 'warning', title: 'Almost full', message: 'You have used 90% of your storage.' },
};

export const Danger: Story = {
  args: { tone: 'danger', title: 'Payment failed', message: 'Update your card to keep your plan.' },
};
