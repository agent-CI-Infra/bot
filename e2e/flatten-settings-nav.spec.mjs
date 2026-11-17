import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

const settings = [['基本设置','basic'],['监听与触发','triggers'],['机器配置','machine'],['角色','roles'],['模型','model'],['定时任务与通知','schedules'],['外部执行','external'],['成员','members']];
const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };

test('project settings keep eight categories with one current item and share the phone picker', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, manager, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  try {
    const { admin, password }=await setup(h), a=await account(admin); await repository(admin,a.id,'101');
    await page.goto(h.admin+'/#/projects/101/basic');
    await page.getByLabel('用户名',{exact:true}).fill('administrator'); await page.getByLabel('密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    const categories=page.getByRole('navigation',{name:'项目设置类别',includeHidden:true}), picker=page.getByLabel('当前页面',{exact:true});
    for(const width of [1440,768,390]) {
      await page.setViewportSize({width,height:1000});
      for(const [caption,key] of settings) {
        if(width>=768) await categories.getByRole('link',{name:caption,exact:true}).click();
        else await picker.selectOption('#/projects/101/'+key);
        await expect(page).toHaveURL(new RegExp('#/projects/101/'+key+'$'));
        await expect(page.locator('#project-page .project-head h1')).toHaveText(caption);
        await expect(page.locator('#project-page .project-content > .console-state-loading')).toHaveCount(0);
        await expect(categories.getByRole('link',{includeHidden:true})).toHaveText(settings.map(([name])=>name));
        await expect(categories.locator('[aria-current=page]')).toHaveText(caption);
        await expect(picker).toHaveValue('#/projects/101/'+key);
        expect(await picker.locator('optgroup[label="设置"] option').evaluateAll(nodes=>nodes.map(n=>n.value))).toEqual(settings.map(([,id])=>'#/projects/101/'+id));
        if(width>=768) {
          await expect(page.locator('#tabs [aria-current=page]')).toHaveText('项目设置');
          for(const item of await categories.getByRole('link',{includeHidden:true}).all()) await expect(item).toBeInViewport({ratio:1});
        } else await expect(categories).toBeHidden();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      }
    }
    await page.reload(); await expect(categories.locator('[aria-current=page]')).toHaveText('成员');
    expect(errors).toEqual([]);
  } finally {await h.stop();}
});
