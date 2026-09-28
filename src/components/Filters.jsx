import { useSettings } from '../context/SettingsContext.jsx';
import { DATE_PRESETS, rangeForPreset } from '../utils/dates.js';

/** ALL | BAZAAR | SNACKS */
export function SectionFilter({ value, onChange, allowAll = true }) {
  const { sections } = useSettings();
  const opts = [...(allowAll ? [{ code: '', name: 'All' }] : []), ...sections];
  return (
    <div className="seg" role="radiogroup" aria-label="Section">
      {opts.map((s) => (
        <button
          type="button"
          key={s.code || 'all'}
          role="radio"
          aria-checked={value === s.code}
          className={`seg-b ${value === s.code ? 'on' : ''}`}
          onClick={() => onChange(s.code)}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}

/** Date preset + custom range. value = { preset, from, to } */
export function DateRangeFilter({ value, onChange }) {
  const { tz } = useSettings();
  const setPreset = (preset) => {
    if (preset === 'custom') onChange({ ...value, preset });
    else onChange({ preset, ...rangeForPreset(preset, tz) });
  };
  return (
    <div className="daterange">
      <select className="input" value={value.preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
        {DATE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {value.preset === 'custom' && (
        <>
          <input className="input" type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="From" />
          <span className="muted">to</span>
          <input className="input" type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="To" />
        </>
      )}
    </div>
  );
}

export function initialRange(preset, tz) {
  return { preset, ...rangeForPreset(preset, tz) };
}
