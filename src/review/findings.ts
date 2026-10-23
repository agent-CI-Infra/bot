import { stop } from '../agent/common.js';
export function validateReview(value: any) {
  if (!value || typeof value.summary !== 'string' || value.summary.length > 16000 || !Array.isArray(value.findings) || value.findings.length > 100
    || ['requires_code_change','issue_requests_code','clarification_required'].some(k => typeof value[k] !== 'boolean')
    || typeof value.implementation_goal !== 'string' || typeof value.request_quote !== 'string' || value.event !== undefined) stop('model_review_invalid');
  for (const finding of value.findings) if (!finding || typeof finding.body !== 'string' || finding.body.length > 16000 || !['discussion','inline'].includes(finding.format)
    || typeof finding.selection_reason !== 'string' || finding.selection_reason.length > 2000 || finding.event !== undefined) stop('model_finding_invalid');
  for(const finding of value.findings)if(['actionable','within_goal','requires_human_decision'].some(key=>finding[key]!==undefined&&typeof finding[key]!=='boolean'))stop('model_finding_invalid');
  return value;
}
function positions(patch: string): Set<string> {
  const result = new Set<string>(); let left=0,right=0,active=false;
  for (const line of patch.split('\n')) {
    const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { left=Number(hunk[1]);right=Number(hunk[2]);active=true;continue; }
    if (!active || line.startsWith('\\')) continue;
    if (line.startsWith('+')) result.add('RIGHT:'+right++);
    else if (line.startsWith('-')) result.add('LEFT:'+left++);
    else if (line.startsWith(' ')) {result.add('LEFT:'+left++);result.add('RIGHT:'+right++);}
    else active=false;
  }
  return result;
}
export function inlineLocation(finding: any, files: any[]): Record<string,unknown> | null {
  const file = files.find(f=>f.filename===finding.path);
  if (!file?.patch || !['LEFT','RIGHT'].includes(finding.side) || !Number.isSafeInteger(finding.line) || finding.line<1) return null;
  const valid=positions(file.patch); if (!valid.has(finding.side+':'+finding.line)) return null;
  const result: Record<string,unknown> = {path:finding.path,line:finding.line,side:finding.side};
  if (finding.start_line !== undefined) {
    if (!Number.isSafeInteger(finding.start_line) || finding.start_line<1 || finding.start_line>finding.line || finding.start_side!==finding.side) return null;
    for(let line=finding.start_line;line<=finding.line;line++) if(!valid.has(finding.side+':'+line)) return null;
    result.start_line=finding.start_line;result.start_side=finding.start_side;
  }
  return result;
}
