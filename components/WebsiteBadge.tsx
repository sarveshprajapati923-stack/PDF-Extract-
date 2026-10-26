import type { AutoWebsiteStatus, WebsiteCheck } from '@/lib/types';
import { websiteInfo } from '@/lib/website';

export function WebsiteBadge({ auto, check }: { auto: AutoWebsiteStatus; check: WebsiteCheck }) {
  const info = websiteInfo(auto, check);
  return (
    <div className="web-state">
      <span className={`badge badge-${info.tone}`}>{info.label}</span>
      <span className="muted small">{info.note}</span>
    </div>
  );
}
