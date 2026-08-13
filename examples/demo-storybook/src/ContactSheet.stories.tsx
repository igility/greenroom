import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertBanner } from './AlertBanner';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { TextField } from './TextField';

/**
 * A contact sheet — a whole class of components on one page, so a reviewer meets a
 * handful of surfaces instead of hundreds of sidebar entries.
 *
 * This is the reference implementation of the host contract, and it is deliberately
 * hand-authored with no Greenroom import anywhere. The contract is two strings:
 *
 *   - `data-greenroom-story="<story id>"` on a wrapper makes that region independently
 *     commentable, fingerprintable and status-decorated.
 *   - the `greenroom:sheet` tag marks this story as a navigation and batch surface
 *     rather than something to approve in its own right.
 *
 * Nothing else is required, and nothing here depends on Greenroom being installed —
 * without it this is simply a page that renders some components.
 */

/** Wraps one component so Greenroom can address it. `story` is that component's story id. */
function Tile({
  story,
  label,
  children,
}: {
  story: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <figure
      data-greenroom-story={story}
      style={{
        margin: 0,
        border: '1px solid #e3e5ea',
        borderRadius: 10,
        background: '#fff',
        // A visible boundary at rest, not on hover: on a touch screen there is no
        // hover, and if the grid is ambiguous about where one component ends the
        // next begins, tapping to comment is ambiguous too.
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '20px 18px', display: 'grid', placeItems: 'center', minHeight: 96 }}>
        {children}
      </div>
      <figcaption
        style={{
          borderTop: '1px solid #eef0f3',
          padding: '8px 12px',
          font: '500 12px/1.4 system-ui, sans-serif',
          color: '#5b6270',
        }}
      >
        {label}
      </figcaption>
    </figure>
  );
}

function Sheet() {
  return (
    <div style={{ font: '400 15px/1.5 system-ui, sans-serif', color: '#1f2430', padding: 24 }}>
      <h1 style={{ font: '700 22px/1.3 system-ui, sans-serif', margin: '0 0 4px' }}>
        Buttons, badges and inputs
      </h1>
      <p style={{ margin: '0 0 24px', color: '#5b6270', maxWidth: '60ch' }}>
        Everything here is live. If something bothers you, click it and say so.
      </p>

      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        }}
      >
        <Tile story="components-button--primary" label="Primary button">
          <Button label="Save changes" variant="primary" />
        </Tile>
        <Tile story="components-button--secondary" label="Secondary button">
          <Button label="Cancel" variant="secondary" />
        </Tile>
        <Tile story="components-button--danger" label="Danger button">
          <Button label="Delete account" variant="danger" />
        </Tile>
        <Tile story="components-badge--neutral" label="Badge">
          <Badge label="Draft" tone="neutral" />
        </Tile>
        <Tile story="components-textfield--default" label="Text field">
          <TextField label="Email" placeholder="you@example.com" />
        </Tile>
        <Tile story="components-textfield--with-error" label="Text field — error">
          <TextField label="Email" value="not-an-email" error="Enter a valid email address." />
        </Tile>
        <Tile story="components-alertbanner--info" label="Alert — info">
          <AlertBanner tone="info" title="Heads up" message="Maintenance window Sunday." />
        </Tile>
        <Tile story="components-card--basic" label="Card">
          <Card title="Quarterly report" body="Revenue is up 12% on the prior quarter." />
        </Tile>
      </div>
    </div>
  );
}

const meta = {
  title: 'Review/Buttons, badges and inputs',
  // Pinning the id keeps this sheet's review history attached to it when the title is
  // reworded — Storybook derives ids from the title, so renaming would otherwise strand
  // every thread on a row nobody can navigate to.
  id: 'review-sheet--controls',
  component: Sheet,
  tags: ['greenroom:sheet'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Sheet>;

export default meta;

export const Controls: StoryObj<typeof meta> = {};
