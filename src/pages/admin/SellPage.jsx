import { useState } from 'react';
import { useSettings } from '../../context/SettingsContext.jsx';
import { SectionFilter } from '../../components/Filters.jsx';
import PosPage from '../pos/PosPage.jsx';

/** Admin can also sell (e.g. covering a break). Sales are recorded under the admin's name. */
export default function SellPage() {
  const { sections } = useSettings();
  const [section, setSection] = useState('BAZAAR');
  if (!sections.length) return null;
  return (
    <div className="sell-wrap">
      <div className="sell-bar">
        <span className="muted">Selling in:</span>
        <SectionFilter value={section} onChange={setSection} allowAll={false} />
      </div>
      <div className="main-pos-wrap">
        <PosPage key={section} section={section} />
      </div>
    </div>
  );
}
