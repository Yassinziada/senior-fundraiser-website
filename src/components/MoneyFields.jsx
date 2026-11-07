import { useSettings } from '../context/SettingsContext.jsx';
import { centsToAmount, parseAmountInput } from '../utils/money.js';
export function AccountSelect({ value, onChange, label = 'Paid from', disabled = false }) {
  return <label className="f">{label}<select aria-label={label} className="input" value={value} onChange={e => onChange(e.target.value)} disabled={disabled} required>
    <option value="CASH">Cash</option><option value="TELDA">Telda</option><option value="INSTAPAY">InstaPay</option>
  </select></label>;
}
export default function MoneyFields({ cost, setCost, account, setAccount, quantity, disabled = false }) {
  const { money } = useSettings();
  const cents = parseAmountInput(cost);
  return <div>
    <label className="f">Buying price per item<input className="input" type="number" min="0" step="0.01" required value={cost} onChange={e => setCost(e.target.value)} disabled={disabled} /></label>
    <AccountSelect value={account} onChange={setAccount} disabled={disabled} />
    {Number.isFinite(cents) && quantity > 0 && <p className="notice info">Deduct {money(centsToAmount(cents * quantity))} from {account === 'INSTAPAY' ? 'InstaPay' : account === 'TELDA' ? 'Telda' : 'Cash'} when confirmed. This means the goods have been paid for.</p>}
  </div>;
}
