import type { Meta, StoryObj } from '@storybook/react-vite';
import { PricingTable } from './PricingTable';

const meta = {
  title: 'Components/PricingTable',
  component: PricingTable,
} satisfies Meta<typeof PricingTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeTiers: Story = {
  args: {
    tiers: [
      { name: 'Starter', price: '$19/mo', seats: 'Up to 3' },
      { name: 'Team', price: '$49/mo', seats: 'Up to 15', highlighted: true },
      { name: 'Business', price: '$129/mo', seats: 'Unlimited' },
    ],
  },
};
