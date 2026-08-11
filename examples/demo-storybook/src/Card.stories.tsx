import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from './Card';
import { Button } from './Button';

const meta = {
  title: 'Components/Card',
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  args: {
    title: 'Quarterly report',
    body: 'Revenue and engagement figures for the last quarter, ready for review.',
  },
};

export const WithFooter: Story = {
  args: {
    title: 'Quarterly report',
    body: 'Revenue and engagement figures for the last quarter, ready for review.',
    footer: <Button label="Open report" variant="secondary" />,
  },
};
