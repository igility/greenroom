import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';

const meta = {
  title: 'Components/Badge',
  component: Badge,
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = { args: { label: 'Draft', tone: 'neutral' } };
export const Success: Story = { args: { label: 'Active', tone: 'success' } };
export const Warning: Story = { args: { label: 'Pending', tone: 'warning' } };
export const Danger: Story = { args: { label: 'Overdue', tone: 'danger' } };
