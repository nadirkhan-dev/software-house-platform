import { has, pct, usdK } from '../lib/format';
import type { Project } from '../lib/types';

/**
 * The signature component: contract value left to right, cost in crimson,
 * margin remaining in ink blue, with a tick where delivery actually is.
 *
 * When cost is redacted it degrades to a delivery-progress bar rather than
 * disappearing — a developer still needs to see how far along a project is.
 */
export function LedgerBar({ project: p, big = false }: { project: Project; big?: boolean }) {
  const progress = Math.min(1, p.progress || 0);

  if (!has(p.cost_base) || !has(p.contract_value)) {
    return (
      <div className={`lbar${big ? ' big' : ''}`}>
        <div className="seg margin" style={{ width: `${progress * 100}%` }}>
          <span>{pct(progress)} delivered</span>
        </div>
      </div>
    );
  }

  const cost = p.cost_base!, contract = p.contract_value!;
  const total = Math.max(contract, cost);
  const cw = Math.min(cost, contract) / total * 100;
  const ow = Math.max(0, cost - contract) / total * 100;
  const mw = Math.max(0, 100 - cw - ow);

  return (
    <div className={`lbar${big ? ' big' : ''}`}>
      <div className={`seg cost ${cw < 14 ? 'thin' : ''}`} style={{ width: `${cw}%` }}>
        <span>{usdK(Math.min(cost, contract))} cost</span></div>
      {ow > 0 && <div className={`seg over ${ow < 14 ? 'thin' : ''}`} style={{ width: `${ow}%` }}>
        <span>{usdK(cost - contract)} over</span></div>}
      {mw > 0 && <div className={`seg margin ${mw < 14 ? 'thin' : ''}`} style={{ width: `${mw}%` }}>
        <span>{usdK(contract - cost)} margin</span></div>}
      <div className="tick" style={{ left: `${Math.min(99, progress * 100)}%` }}
        data-l={`${pct(progress)} delivered`} />
    </div>
  );
}
