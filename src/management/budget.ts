import type { Store } from '../storage/database.js';
import { fail } from '../core/security.js';
export function checkManagementBudget(store:Store,project:string):void{
  for(const b of store.all('SELECT * FROM management_budgets WHERE project_id=?',project)){
    const usage=store.get('SELECT coalesce(sum(cost),0) amount,sum(CASE WHEN cost IS NULL AND finished_at IS NOT NULL THEN 1 ELSE 0 END) unknown FROM model_requests WHERE repository_id=? AND (currency=? OR currency IS NULL)',project,b.currency)!;
    if(usage.unknown)fail(409,'budget_usage_unknown');if(usage.amount>=b.limit_amount)fail(409,'budget_exhausted');
  }
}
