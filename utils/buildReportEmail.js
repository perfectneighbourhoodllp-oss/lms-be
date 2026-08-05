// Build the HTML body for the agent activity report email.

const fmtDateIST = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const fmtMins = (m) => {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
};

const th = (t, align = 'right') =>
  `<th style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:${align};font-size:12px;color:#374151">${t}</th>`;
const td = (t, align = 'right') =>
  `<td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:${align};font-size:13px">${t}</td>`;

/**
 * @param {{ from: Date, to: Date, agents: Array, totals: Object }} report
 * @param {string} [periodLabel] e.g. "Daily"
 */
module.exports = function buildReportEmail({ from, to, agents, totals }, periodLabel = 'Daily') {
  const sameDay = fmtDateIST(from) === fmtDateIST(to);
  const dateLine = sameDay ? fmtDateIST(from) : `${fmtDateIST(from)} – ${fmtDateIST(to)}`;

  const rows = agents
    .map(
      (a) => `<tr>
        ${td(`<b>${a.name}</b> <span style="color:#9ca3af">(${a.role})</span>`, 'left')}
        ${td(a.leadsAssigned)}
        ${td(a.leadsCalled)}
        ${td(a.callsMade)}
        ${td(a.leadsWhatsapped)}
        ${td(a.followUpsDone)}
        ${td(a.siteVisitsDone)}
        ${td(fmtMins(a.avgFirstContactMins))}
        ${td(a.closed)}
      </tr>`
    )
    .join('');

  const totalRow = `<tr style="font-weight:bold;background:#f3f4f6">
    ${td('Total', 'left')}
    ${td(totals.leadsAssigned)}
    ${td(totals.leadsCalled)}
    ${td(totals.callsMade)}
    ${td(totals.leadsWhatsapped)}
    ${td(totals.followUpsDone)}
    ${td(totals.siteVisitsDone)}
    ${td(fmtMins(totals.avgFirstContactMins))}
    ${td(totals.closed)}
  </tr>`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:0 auto;color:#111827">
    <h2 style="color:#1d4ed8;margin-bottom:2px">${periodLabel} Agent Report</h2>
    <p style="color:#6b7280;margin-top:0">${dateLine} · PNH Lead MS</p>
    <table style="width:100%;border-collapse:collapse;margin-top:14px">
      <thead><tr>
        ${th('Agent', 'left')}
        ${th('Leads Assigned')}
        ${th('Leads Called')}
        ${th('Calls Made')}
        ${th('Leads WhatsApp’d')}
        ${th('Total Remarks')}
        ${th('Site Visits')}
        ${th('Avg 1st Contact')}
        ${th('Closed')}
      </tr></thead>
      <tbody>
        ${rows || `<tr>${td('No agents', 'left')}${td('')}${td('')}${td('')}${td('')}${td('')}${td('')}${td('')}${td('')}</tr>`}
        ${totalRow}
      </tbody>
    </table>
    <p style="color:#9ca3af;font-size:12px;margin-top:18px">
      "Leads Called/WhatsApp'd" = distinct leads contacted per day, summed over the range.
      "Calls Made" = every call logged (not deduped by lead).
      "Total Remarks" = all remarks added. "Avg 1st Contact" counts only
      working-window time (10:00 AM–6:30 PM IST). Auto-sent by PNH Lead Management System.
    </p>
  </div>`;
};
