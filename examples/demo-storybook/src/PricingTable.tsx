interface PricingTier {
  name: string;
  price: string;
  seats: string;
  highlighted?: boolean;
}

interface PricingTableProps {
  tiers: PricingTier[];
}

export function PricingTable({ tiers }: PricingTableProps) {
  return (
    <table className="demo-pricing">
      <thead>
        <tr>
          <th>Plan</th>
          <th>Price</th>
          <th>Seats</th>
        </tr>
      </thead>
      <tbody>
        {tiers.map((tier) => (
          <tr key={tier.name} className={tier.highlighted ? 'demo-pricing-highlight' : undefined}>
            <td>{tier.name}</td>
            <td className="demo-pricing-price">{tier.price}</td>
            <td>{tier.seats}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
