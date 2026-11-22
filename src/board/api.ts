import type { Store } from '../storage/database.js';
import { type Actor } from '../app/auth.js';
import { fail, type Json } from '../core/security.js';
import { boardIssueDetail, listBoardIssues } from './issues.js';
import { boardPrDetail, listBoardPrs } from './prs.js';

export const boardRetiredMessage =
  '控制台旧任务看板与自定义字段已下线：单项目请使用项目总览（角色视图、任务视图、Issue 进展、PR 进展），全局异常请使用待处理中心。';

/**
 * Serves the Issue Progress (`/api/board/issues*`) and PR Progress (`/api/board/prs*`) endpoints
 * used by the Project Overview workbench, and returns 410 `board_retired` for the retired legacy
 * console Kanban endpoints (`/api/board`, `/api/board/cards*`, `/api/board/fields*`, `/api/board/views*`) (#1222).
 */
export function boardApi(store: Store, user: Actor, method: string, url: URL, _body: Json): Json | undefined {
  const path = url.pathname;
  if (path !== '/api/board' && !path.startsWith('/api/board/')) return undefined;

  if (method === 'GET' && path === '/api/board/issues') return listBoardIssues(store, user, url);
  const issueDetail = /^\/api\/board\/issues\/([^/]+)\/([1-9]\d*)$/.exec(path);
  if (method === 'GET' && issueDetail) return boardIssueDetail(store, user, issueDetail[1]!, Number(issueDetail[2]!));

  if (method === 'GET' && path === '/api/board/prs') return listBoardPrs(store, user, url);
  const prDetail = /^\/api\/board\/prs\/([^/]+)\/([1-9]\d*)$/.exec(path);
  if (method === 'GET' && prDetail) return boardPrDetail(store, user, prDetail[1]!, Number(prDetail[2]!));

  if (
    path === '/api/board'
    || path === '/api/board/cards'
    || path.startsWith('/api/board/cards/')
    || path === '/api/board/fields'
    || path.startsWith('/api/board/fields/')
    || path === '/api/board/views'
    || path.startsWith('/api/board/views/')
  ) {
    fail(410, 'board_retired', boardRetiredMessage);
  }
  return undefined;
}
