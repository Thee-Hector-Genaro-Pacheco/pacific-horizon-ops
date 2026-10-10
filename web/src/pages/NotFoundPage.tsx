import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, Panel } from '../components/primitives';

export function NotFoundPage() {
  return (
    <Panel>
      <EmptyState
        icon={Compass}
        title="This view doesn't exist"
        action={
          <Link to="/" className="btn btn--sm">
            Back to Command Center
          </Link>
        }
      >
        The link may be out of date, or the record was never part of this data source.
      </EmptyState>
    </Panel>
  );
}
