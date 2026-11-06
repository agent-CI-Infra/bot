import { stop } from '../agent/common.js';
export function validateReview(value: any) {
  if (value?.product_defect !== undefined && typeof value.product_defect !== 'boolean') stop('model_review_invalid');
  if (!value || typeof value.summary !== 'string' || value.summary.length > 16000 || !Array.isArray(value.findings) || value.findings.length > 100
    || ['requires_code_change','issue_requests_code','clarification_required'].some(k => typeof value[k] !== 'boolean')
    || typeof value.implementation_goal !== 'string' || typeof value.request_quote !== 'string' || value.event !== undefined
    || value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.length > 20 || value.labels.some((l: unknown) => typeof l !== 'string' || l.length > 50))) stop('model_review_invalid', undefined, '检视结果的必填字段、类型或长度无效，请检查 finish_review 输出格式。');
  for (const finding of value.findings) if (!finding || typeof finding.body !== 'string' || finding.body.length > 16000 || !['discussion','inline'].includes(finding.format)
    || typeof finding.selection_reason !== 'string' || finding.selection_reason.length > 2000 || finding.event !== undefined) stop('model_finding_invalid', undefined, '检视意见的正文、位置类型或选择原因格式无效，或包含不允许的 event 字段。');
  for(const finding of value.findings)if(['actionable','within_goal','requires_human_decision'].some(key=>finding[key]!==undefined&&typeof finding[key]!=='boolean'))stop('model_finding_invalid', undefined, '检视意见中的 actionable、within_goal 和 requires_human_decision 必须为布尔值。');
  for(const finding of value.findings)if(finding.comment_id!==undefined&&(!Number.isSafeInteger(finding.comment_id)||finding.comment_id<1))stop('model_finding_invalid', undefined, '检视意见的 comment_id 必须是行内评论 ID（正整数）。');
  for(const finding of value.findings)if(finding.requested_in!==undefined&&(typeof finding.requested_in!=='object'||finding.requested_in===null||!['comment','review','review_comment'].includes(finding.requested_in.type)||!Number.isSafeInteger(finding.requested_in.id)||finding.requested_in.id<1))stop('model_finding_invalid', undefined, '检视意见的 requested_in 必须写明提出修改的评论类型（comment、review 或 review_comment）和 GitHub ID（正整数）。');
  for(const finding of value.findings)if(finding.human_action!==undefined&&(typeof finding.human_action!=='string'||finding.human_action.length>2000))stop('model_finding_invalid', undefined, '检视意见的 human_action 必须是不超过 2000 字符的字符串。');
  if(value.resolved_comments!==undefined&&(!Array.isArray(value.resolved_comments)||value.resolved_comments.length>200||value.resolved_comments.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<1)))stop('model_review_invalid', undefined, '检视结果的 resolved_comments 必须是行内评论 ID（正整数）列表。');
  return value;
}
// A custom workflow's reply: a summary and findings, checked the same way as review findings.
export function validateReply(value: any) {
  if (!value || typeof value.summary !== 'string' || value.summary.length > 16000 || !Array.isArray(value.findings) || value.findings.length > 100 || value.event !== undefined
    || value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.length > 20 || value.labels.some((l: unknown) => typeof l !== 'string' || l.length > 50)))
    stop('model_review_invalid', undefined, '工作流结果的 summary、findings 或 labels 无效，请检查 finish_review 输出格式。');
  for (const finding of value.findings) if (!finding || typeof finding.body !== 'string' || finding.body.length > 16000 || !['discussion','inline'].includes(finding.format)
    || typeof finding.selection_reason !== 'string' || finding.selection_reason.length > 2000 || finding.event !== undefined) stop('model_finding_invalid', undefined, '工作流结果的意见正文、位置类型或选择原因格式无效，或包含不允许的 event 字段。');
  return { summary: value.summary, findings: value.findings, ...(value.labels ? { labels: value.labels } : {}) };
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
